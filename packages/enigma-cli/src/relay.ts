/**
 * `enigma relay`: run a long task as a chain of fresh agent sessions, each handing off to the next.
 *
 * Interactive hosts other than Claude Code cannot clear their own context (no hook or plugin can
 * issue `/clear` there - Codex, Kimi and OpenCode document that), so the only fully automatic
 * version of "clear and keep going" is the one the Ralph loops (snarktank/ralph, open-ralph-wiggum)
 * use: an outside loop that starts a new headless session per step. Each step gets the task and the
 * last handoff, works, and saves a new handoff before it stops; a handoff with `STATUS: done` ends
 * the chain, and so does a step that saved none (the work cannot be carried on blind).
 *
 * The prompt never travels on a command line. It is written to a file under ~/.enigma and the agent
 * is told to read it: on Windows the npm shims are `.cmd` files that only a shell can start, and a
 * prompt (quotes, `%`, `&`) on a cmd.exe line is an injection waiting to happen.
 */

import { dirname, join } from "node:path";
import * as handoff from "./handoff";
import { readConfig } from "./config";
import { spawnSync } from "node:child_process";
import { enigmaHome, resolveBin } from "./util";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

export const RELAY_HELP = `usage: enigma relay [--agent claude|codex|opencode|kimi] [--max N] "<task>"
Run a long task as a chain of fresh sessions: each one works, saves a handoff, and the next
continues from it with a clean context. Stops when a handoff says "STATUS: done", when a step
saves no handoff, or after --max steps (default 10).

In Claude Code you can stay interactive instead: /handoff, then /clear, or let relay-at do both.`;

export type RelayAgent = "claude" | "codex" | "opencode" | "kimi";
const AGENTS: RelayAgent[] = ["claude", "codex", "opencode", "kimi"];
const DEFAULT_MAX = 10;
const MAX_STEPS = 50;

/** What every step is told about handing off, appended to its task. */
const STEP_RULES = [
    "",
    "## How this session ends",
    "This is one step of a relay: a fresh session continues after you, knowing only what you hand it.",
    "Before you stop, save the handoff with `enigma handoff save` (stdin): the goal, what is done and verified,",
    "the next steps, decisions already made, how to verify, and the files that matter.",
    "If the whole task is finished and verified, include the line `STATUS: done` so the relay stops.",
].join("\n");

export interface RelayOptions { agent: RelayAgent; max: number; task: string; cwd: string; }

/** Parse `enigma relay` arguments. Returns the options, or an error message. */
export function parseRelayArgs(argv: string[], cwd = process.cwd()): RelayOptions | string {
    let agent: RelayAgent = "claude";
    let max = DEFAULT_MAX;
    const words: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--agent" || a === "-a") {
            const v = argv[++i];
            if (!v || !AGENTS.includes(v as RelayAgent)) return `--agent takes one of ${AGENTS.join(", ")}`;
            agent = v as RelayAgent;
        } else if (a === "--max") {
            const n = Number(argv[++i]);
            if (!Number.isInteger(n) || n < 1 || n > MAX_STEPS) return `--max takes a whole number from 1 to ${MAX_STEPS}`;
            max = n;
        } else if (a.startsWith("-")) {
            return `unknown flag ${a}`;
        } else words.push(a);
    }
    const task = words.join(" ").trim();
    if (!task) return "name the task: enigma relay \"<task>\"";
    return { agent, max, task, cwd };
}

/**
 * The argv that runs one headless step of `agent` on the prompt in `promptFile`. Every step must be
 * able to run `enigma handoff save`, which writes next to the prompt (`dirname(promptFile)`), outside
 * the workspace: Claude without bypass is allowed that one command, and Codex's workspace-write
 * sandbox gets that directory as an extra writable root.
 */
export function stepArgv(agent: RelayAgent, promptFile: string): string[] {
    const ask = `Read ${promptFile} and do what it says.`;
    switch (agent) {
        case "claude": {
            const bypass = readConfig().config.permissionBypass;
            return bypass
                ? ["claude", "-p", ask, "--permission-mode", "bypassPermissions"]
                : ["claude", "-p", ask, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(enigma handoff save:*)"];
        }
        case "codex": {
            const store = dirname(promptFile).split("\\").join("/");
            if (store.includes("'")) throw new Error(`the handoff folder ${store} cannot be named in a Codex config value`);
            return ["codex", "exec", "--sandbox", "workspace-write", "-c", `sandbox_workspace_write.writable_roots=['${store}']`, ask];
        }
        case "opencode": return ["opencode", "run", ask];
        // Kimi Code: `-p` runs one prompt non-interactively (it refuses `--auto` beside it).
        case "kimi": return ["kimi", "-p", ask];
    }
}

/** A path safe to put on a cmd.exe line inside the fixed sentence: no quoting or expansion characters. */
const SAFE_PATH = /^[\w:\\/. -]+$/;

function runStep(agent: RelayAgent, promptFile: string, cwd: string): number {
    const [cmd, ...args] = stepArgv(agent, promptFile);
    const bin = resolveBin(cmd!);
    if (!bin) throw new Error(`${cmd} is not on PATH`);
    const shim = /\.(cmd|bat)$/i.test(bin);
    if (shim && !SAFE_PATH.test(promptFile)) throw new Error(`the prompt path ${promptFile} cannot be passed to a .cmd shim safely`);
    // `env` is passed on purpose: Bun does not hand a child the variables changed at run time unless told to.
    const env = { ...process.env, [handoff.RELAY_STEP_ENV]: "1" };
    const r = shim
        ? spawnSync([bin, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), { cwd, env, stdio: "inherit", shell: true, windowsHide: true })
        : spawnSync(bin, args, { cwd, env, stdio: "inherit", windowsHide: true });
    return r.status ?? 1;
}

/** Run the relay. Returns the exit code: 0 when a step reported the task done. */
export function runRelay(opts: RelayOptions, log: (line: string) => void = (l) => console.log(l)): number {
    const dir = join(enigmaHome(), ".enigma", "handoff");
    mkdirSync(dir, { recursive: true });
    const promptFile = join(dir, `relay-${process.pid}.md`);
    try {
        let previous: handoff.Handoff | null = null;
        for (let step = 1; step <= opts.max; step++) {
            const startedAt = Date.now();
            const body = previous
                ? [`# Task\n\n${opts.task}`, "", "## Handoff from the previous step", "", previous.text, STEP_RULES].join("\n")
                : [`# Task\n\n${opts.task}`, STEP_RULES].join("\n");
            writeFileSync(promptFile, `${body}\n`);
            log(`\nenigma relay: step ${step} of at most ${opts.max} (${opts.agent})`);
            let code: number;
            try { code = runStep(opts.agent, promptFile, opts.cwd); } catch (e) { log(`enigma relay: ${(e as Error).message}.`); return 1; }
            const saved = handoff.readHandoff(opts.cwd);
            if (!saved || saved.savedAt < startedAt) {
                log(`enigma relay: step ${step} ended (exit ${code}) without saving a handoff, so there is nothing to continue from. Stopped.`);
                return 1;
            }
            // The relay delivers it itself; the session-start hook must not hand it to a later session too.
            handoff.consumeHandoff(opts.cwd);
            if (saved.done) {
                log(`enigma relay: done after ${step} step(s).`);
                return 0;
            }
            previous = saved;
        }
        log(`enigma relay: stopped at the ${opts.max}-step limit; the last handoff is kept (enigma handoff show).`);
        return 1;
    } finally {
        rmSync(promptFile, { force: true });
    }
}

/** `enigma relay ...`. */
export function runRelayCli(argv: string[]): number {
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h") { console.log(RELAY_HELP); return argv.length ? 0 : 2; }
    const opts = parseRelayArgs(argv);
    if (typeof opts === "string") { console.error(`enigma relay: ${opts}.`); return 2; }
    return runRelay(opts);
}
