/**
 * Why a turn feels slow: time every hook wired into Claude Code and name the one over budget.
 *
 * A hook that takes fifteen seconds is invisible from inside the agent. The user sees the
 * agent stall, or a bare `UserPromptSubmit hook timed out after 30s` that names an EVENT and
 * never the hook - and an event can carry several, from three different settings files and
 * from any enabled plugin. Attributing it by hand means finding every config that contributes
 * one, expanding ${CLAUDE_PLUGIN_ROOT}, and running each with a payload it accepts. This does
 * that in one command.
 *
 * It EXECUTES the hooks, which is the only way to time them, so the default is the two events
 * that fire on every turn (UserPromptSubmit, PostToolUse) with a deliberately inert payload -
 * a Read of no file, so a hook that acts on an edit has nothing to act on. Everything else is
 * behind --all, because Stop and PreCompact hooks do real work.
 */

import { join } from "node:path";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isDir, readJson, enigmaHome } from "./util";
import { claudeGlobalSettings, type HookGroup } from "./claude-hooks";

/** Events that fire on every turn, so a slow hook on one is felt as the agent being slow. */
export const HOT_EVENTS = ["UserPromptSubmit", "PostToolUse"];

/** A hook slower than this is worth reporting even when it never hits its timeout. */
const SLOW_MS = 1000;

/** Times each hook is run; the verdict uses the median, because this is a noisy measurement. */
const RUNS = 3;

/** One hook found in a settings file or an enabled plugin, ready to be timed. */
export interface HookRef {
    event: string;
    /** Where it came from: "user settings", "project settings", "plugin warp@claude-code-warp". */
    source: string;
    /** Tool matcher the group declared, when it narrows the event. */
    matcher: string | null;
    command: string;
    /** Declared timeout in seconds, or null when the entry leaves it to Claude Code's default. */
    timeout: number | null;
    /** Directory ${CLAUDE_PLUGIN_ROOT} expands to, for a plugin hook. */
    pluginRoot: string | null;
}

/** How a hook is doing: `over` its own declared timeout, `slow`, `ok`, or it never ran. */
export type HookVerdict = "ok" | "slow" | "over" | "failed";

/** Timing for one hook: every run, plus the median the verdict is based on. */
export interface HookTiming extends HookRef {
    /** Wall time in ms per run; a run that could not be spawned is absent. */
    runs: number[];
    median: number;
    /**
     * Exit code of the last run, or null when it never spawned. Reported but never graded: a
     * hook exits non-zero to BLOCK an event, which is it working, not it failing.
     */
    status: number | null;
    verdict: HookVerdict;
}

/** Flatten one `hooks` object (settings or plugin) into a ref per command. */
function flatten(hooks: Record<string, HookGroup[]>, source: string, pluginRoot: string | null): HookRef[] {
    const out: HookRef[] = [];
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
            for (const entry of group.hooks || []) {
                if (typeof entry.command !== "string" || !entry.command) continue;
                out.push({
                    event,
                    source,
                    matcher: typeof group.matcher === "string" ? group.matcher : null,
                    command: entry.command,
                    timeout: typeof entry.timeout === "number" ? entry.timeout : null,
                    pluginRoot,
                });
            }
        }
    }
    return out;
}

interface SettingsShape { hooks?: Record<string, HookGroup[]>; enabledPlugins?: Record<string, unknown>; }

/**
 * Hooks contributed by the enabled plugins. Claude Code keys `enabledPlugins` as
 * "<plugin>@<marketplace>" but stores the files under cache/<marketplace>/<plugin>/<version>,
 * so the key is split rather than joined. installed_plugins.json carries the exact install
 * path when it is readable; the version scan is the fallback for an older layout.
 */
function fromPlugins(enabled: Record<string, unknown>, home: string): HookRef[] {
    const pluginsDir = join(home, ".claude", "plugins");
    const installed = readJson<{ plugins?: Record<string, Array<{ installPath?: string; }>>; }>(join(pluginsDir, "installed_plugins.json"));
    const out: HookRef[] = [];
    for (const [key, on] of Object.entries(enabled)) {
        if (on !== true) continue;
        const roots: string[] = [];
        for (const entry of installed?.plugins?.[key] || []) {
            if (entry.installPath && isDir(entry.installPath)) roots.push(entry.installPath);
        }
        if (!roots.length) {
            const [plugin, marketplace] = key.split("@");
            const base = plugin && marketplace ? join(pluginsDir, "cache", marketplace, plugin) : "";
            if (base && isDir(base)) for (const version of readdirSync(base)) roots.push(join(base, version));
        }
        for (const root of roots) {
            const parsed = readJson<SettingsShape>(join(root, "hooks", "hooks.json"));
            if (parsed?.hooks) out.push(...flatten(parsed.hooks, `plugin ${key}`, root));
        }
    }
    return out;
}

/**
 * Every hook Claude Code would fire in `cwd`: the three settings files that all contribute at
 * once (user, project, project-local) plus the enabled plugins any of them declare.
 */
export function collectHooks(cwd: string = process.cwd()): HookRef[] {
    const files: Array<[string, string]> = [
        [claudeGlobalSettings(), "user settings"],
        [join(cwd, ".claude", "settings.json"), "project settings"],
        [join(cwd, ".claude", "settings.local.json"), "local settings"],
    ];
    const refs: HookRef[] = [];
    const enabled: Record<string, unknown> = {};
    for (const [file, source] of files) {
        const parsed = readJson<SettingsShape>(file);
        if (!parsed) continue;
        if (parsed.hooks) refs.push(...flatten(parsed.hooks, source, null));
        Object.assign(enabled, parsed.enabledPlugins || {});
    }
    refs.push(...fromPlugins(enabled, enigmaHome()));
    return refs;
}

/**
 * Hook stdin, shaped like Claude Code's payload for `event`. Deliberately inert: the tool is a
 * Read with no file, and `stop_hook_active` is already true, so a hook that acts on an edit has
 * nothing to act on and a stop hook does not try to block a turn that is not running.
 */
export function probePayload(event: string, cwd: string): string {
    const payload: Record<string, unknown> = { session_id: "enigma-doctor", transcript_path: "", cwd, hook_event_name: event };
    if (event === "UserPromptSubmit") payload.prompt = "enigma doctor hooks probe";
    if (event === "SessionStart") payload.source = "startup";
    if (event === "Notification") payload.message = "enigma doctor hooks probe";
    if (event === "Stop" || event === "SubagentStop") payload.stop_hook_active = true;
    if (event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest") {
        payload.tool_name = "Read";
        payload.tool_input = {};
    }
    if (event === "PostToolUse") payload.tool_response = {};
    return JSON.stringify(payload);
}

/** Run a hook once for its wall time and exit code, or null when it could not be spawned. */
function timeOnce(ref: HookRef, payload: string, cwd: string): { ms: number; status: number | null; } | null {
    const command = ref.pluginRoot ? ref.command.split("${CLAUDE_PLUGIN_ROOT}").join(ref.pluginRoot) : ref.command;
    // A plugin ships .sh scripts, and a settings entry can declare `"shell": "bash"`; cmd.exe
    // runs neither, and a hook that fails to START would time as instant and read as healthy.
    // Claude Code hands those to a shell that can run them, so this does too.
    const viaBash = command.includes(".sh") || command.startsWith("bash ");
    const started = Date.now();
    const run = viaBash
        ? spawnSync("bash", ["-c", command], { input: payload, cwd, encoding: "utf8", windowsHide: true })
        : spawnSync(command, { input: payload, cwd, shell: true, encoding: "utf8", windowsHide: true });
    if (run.error) return null;
    return { ms: Date.now() - started, status: run.status };
}

/** Median of a non-empty list of durations. */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Run one hook `runs` times and grade it against its own declared timeout. */
export function timeHook(ref: HookRef, cwd: string = process.cwd(), runs: number = RUNS): HookTiming {
    const payload = probePayload(ref.event, cwd);
    const measured: number[] = [];
    let status: number | null = null;
    for (let i = 0; i < runs; i++) {
        const run = timeOnce(ref, payload, cwd);
        if (run === null) return { ...ref, runs: measured, median: 0, status: null, verdict: "failed" };
        measured.push(run.ms);
        status = run.status;
    }
    const mid = median(measured);
    const over = ref.timeout !== null && mid >= ref.timeout * 1000;
    return { ...ref, runs: measured, median: mid, status, verdict: over ? "over" : mid >= SLOW_MS ? "slow" : "ok" };
}

/** Seconds with one decimal, the only precision this measurement supports. */
function secs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

/** One report row: what ran, where it came from, how long it took, and the verdict. */
function describe(t: HookTiming): string {
    const budget = t.timeout === null ? "no timeout" : `timeout ${t.timeout}s`;
    const range = t.runs.length > 1 ? ` (${secs(Math.min(...t.runs))}-${secs(Math.max(...t.runs))})` : "";
    const timing = t.verdict === "failed" ? "did not run" : `${secs(t.median)}${range}`;
    const exit = t.status ? `, exit ${t.status}` : "";
    return `  ${t.event.padEnd(18)} ${t.source.padEnd(30)} ${timing.padEnd(22)} ${budget}${exit}\n      ${t.command}`;
}

/**
 * `enigma doctor [hooks]`. Times the hooks that fire on every turn (or every hook, with --all)
 * and reports them slowest first, so the answer to "which hook timed out" is one command.
 */
export function runDoctorCli(args: string[], all: boolean, json: boolean): number {
    const sub = args[0];
    if (sub && sub !== "hooks") {
        console.error(`Unknown doctor subcommand: ${sub}. Try 'enigma doctor hooks'.`);
        return 2;
    }

    const cwd = process.cwd();
    const found = collectHooks(cwd);
    const targets = all ? found : found.filter((h) => HOT_EVENTS.includes(h.event));
    if (!targets.length) {
        const scope = all ? "No hooks are configured." : `No hooks on ${HOT_EVENTS.join(" or ")}. Run 'enigma doctor hooks --all' for every event.`;
        if (json) console.log(JSON.stringify({ hooks: [] }, null, 2));
        else console.log(scope);
        return 0;
    }

    if (!json) {
        const scope = all ? "every configured hook" : `the hooks that fire on every turn (${HOT_EVENTS.join(", ")})`;
        console.log(`Timing ${scope}: ${targets.length} hook(s), ${RUNS} runs each. They are executed with an inert payload.\n`);
    }

    const timings: HookTiming[] = [];
    for (const ref of targets) {
        const timing = timeHook(ref, cwd);
        timings.push(timing);
        if (!json) console.log(describe(timing));
    }
    timings.sort((a, b) => b.median - a.median);

    if (json) {
        console.log(JSON.stringify({ hooks: timings }, null, 2));
        return 0;
    }

    const worst = timings[0];
    console.log("");
    if (!worst || worst.verdict === "ok") {
        console.log("No hook is over budget.");
        return 0;
    }
    console.log(`Slowest: ${worst.event} from ${worst.source} at ${secs(worst.median)} - ${worst.command}`);
    if (worst.timeout === null) {
        console.log("It declares no timeout, so it falls back to Claude Code's default and a spike over that reaches you as 'hook timed out'.");
    }
    console.log("A hook's cost is paid on every event it is wired to. Remove it, narrow its matcher, or make it answer without spawning a process.");
    return 0;
}
