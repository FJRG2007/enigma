/**
 * Wiring for the subagent budget (subagents.ts), the auto-compact window and the subagent turn cap,
 * written into Claude Code's config dir for the default account and mirrored into every managed account.
 *
 * Three hook entries, all `enigma __subagent-hook <phase>`: PreToolUse on the Agent tool (admits or
 * refuses a launch), SubagentStart (records it and hands the subagent its brief) and SubagentStop
 * (frees the slot). They are installed whatever the limit, because the limit is read per project at
 * run time (`readConfigAt`) - a project can set one while the global value is off - and they cost a
 * process start per subagent launch, which is noise next to what a subagent spends.
 *
 * THE COMPACT WINDOW is Claude Code's `autoCompactWindow` (tokens, 100k-1M): where a conversation
 * compacts. Opus and Sonnet 5.x run a 1M window natively, so a session and every subagent it spawns
 * grew to ~967k before compacting, and each model call re-reads the whole context: measured, the
 * average call read 400-550k tokens. The setting applies to the main conversation and to subagents
 * alike (subagents compact with the same logic, and nothing in Claude Code scopes it to them), so
 * enigma sets one window for both. 0 leaves the key alone and Claude Code picks its own.
 *
 * THE TURN CAP is what actually bounds a subagent. Measured on 12 subagent transcripts after the
 * 400k window shipped: each ran 60-655 model calls and 8-137M input tokens, compacting at ~367k and
 * carrying on - compaction lowers the price of a call, not the number of calls. Claude Code has no
 * per-subagent token setting and no turn parameter on the Agent tool, and a PreToolUse hook on every
 * tool would cost a process start per call (2-15 s measured here). What it does have is `maxTurns`
 * in an agent definition, and a user-level agent named `general-purpose` replaces the built-in one -
 * both verified with `claude -p` (2.1.296): the override's prompt answered, and a sequential task
 * under `maxTurns: 2` was stopped after two turns and handed back to the caller. So enigma writes
 * `agents/general-purpose.md` beside each settings.json, marked as its own so a file the user wrote
 * is never touched, and removes it when the cap is off. Explore and Plan keep their built-ins: they
 * are read-only and their definitions carry a model and tool list enigma cannot source.
 *
 * Node builtins + config/util only, the deploy counterpart of subagents.ts.
 */

import { readJson } from "./util";
import { readConfig } from "./config";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { applyClaudeHook, claudeGlobalSettings } from "./claude-hooks";

/** Marker shared by the three entries; each event's write is keyed by event as well. */
const MARKER = "__subagent-hook";

/** Claude Code accepts an auto-compact window in this range, in tokens. */
export const MIN_COMPACT_WINDOW = 100_000;
export const MAX_COMPACT_WINDOW = 1_000_000;

/** One entry per event; the Agent matcher keeps the PreToolUse process off every other tool. */
const HOOKS: { event: string; phase: string; matcher?: string; }[] = [
    { event: "PreToolUse", phase: "pre", matcher: "Agent|Task" },
    { event: "SubagentStart", phase: "start" },
    { event: "SubagentStop", phase: "stop" },
];

/** Claude Code turns a capped subagent may take per run; outside this range the cap stops being useful. */
export const MIN_SUBAGENT_TURNS = 10;
export const MAX_SUBAGENT_TURNS = 500;

/** Frontmatter comment that marks the general-purpose override as enigma's to rewrite or remove. */
const TURNS_MARKER = "# enigma-managed: subagent-turns";

/** Host timeout in seconds: a process start on a slow host plus a directory listing. */
const HOOK_TIMEOUT_S = 20;

/**
 * Parses the `compact-window` value: tokens from MIN_COMPACT_WINDOW to MAX_COMPACT_WINDOW (a `k`
 * suffix is accepted), or `auto` (stored as 0) to leave the window to Claude Code.
 */
export function parseCompactWindow(value: string): number {
    const text = value.trim().toLowerCase();
    if (text === "auto" || text === "off") return 0;
    const m = /^(\d+)(k?)$/.exec(text);
    const n = m ? Number(m[1]) * (m[2] ? 1000 : 1) : NaN;
    if (!(n >= MIN_COMPACT_WINDOW && n <= MAX_COMPACT_WINDOW)) {
        throw new Error(`expected a token count from ${MIN_COMPACT_WINDOW / 1000}k to ${MAX_COMPACT_WINDOW / 1000}k, or "auto", got "${value}"`);
    }
    return n;
}

/**
 * Sets `autoCompactWindow` in one Claude settings.json. 0 leaves the file alone: "auto" means the
 * user's own value (or Claude Code's default) stands. A window already in the file is kept unless
 * `override` is set (the user chose `compact-window` explicitly), so enigma's default never replaces
 * one the user picked. Refuses an unparseable file rather than replacing it. Returns true when the
 * file changed.
 */
export function applyCompactWindow(settingsPath: string, tokens: number, override = false): boolean {
    if (tokens <= 0) return false;
    const current = readJson<Record<string, unknown>>(settingsPath);
    if (current === null && existsSync(settingsPath)) return false;
    if (current?.autoCompactWindow === tokens) return false;
    if (!override && current?.autoCompactWindow !== undefined) return false;
    writeFileSync(settingsPath, `${JSON.stringify({ ...current, autoCompactWindow: tokens }, null, 2)}\n`);
    return true;
}

/**
 * Parses the `subagent-turns` value: model turns per subagent run, MIN_SUBAGENT_TURNS to
 * MAX_SUBAGENT_TURNS, or `off` (stored as 0) for Claude Code's built-in, uncapped agent.
 */
export function parseSubagentTurns(value: string): number {
    const text = value.trim().toLowerCase();
    if (text === "off" || text === "unlimited") return 0;
    const n = Number(text);
    if (!/^\d+$/.test(text) || n < MIN_SUBAGENT_TURNS || n > MAX_SUBAGENT_TURNS) {
        throw new Error(`expected a number of turns from ${MIN_SUBAGENT_TURNS} to ${MAX_SUBAGENT_TURNS}, or "off", got "${value}"`);
    }
    return n;
}

/**
 * The general-purpose override. The description is the built-in's, so the main agent picks it for
 * the same work; tools and model are left out, so it inherits every tool and the session's model
 * exactly as the built-in does.
 */
export function generalPurposeAgent(turns: number): string {
    return [
        "---",
        TURNS_MARKER,
        "name: general-purpose",
        "description: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
        `maxTurns: ${turns}`,
        "---",
        "You are a general-purpose agent for Claude Code. Complete the task in the prompt with the tools available, then hand back a short report: what changed (absolute paths), what was verified, and what remains.",
        "",
        "- Do what was asked and nothing more. Do not create files the task does not need.",
        "- When you do not know where something lives, search broadly; then read only the parts you need.",
        `- You have ${turns} turns. Past them you are stopped mid-task and nothing you have not reported reaches the caller. If the task will not fit, do the part that does and report exactly what remains, so a fresh agent can pick it up.`,
        "- Do not spend turns waiting: run a long build, test or command once and read its result instead of polling a log or sleeping.",
        "",
    ].join("\n");
}

/**
 * Writes or removes the general-purpose override in one Claude config dir's `agents/`. A file
 * without enigma's marker is the user's own and is never replaced or deleted. Returns true when the
 * directory changed.
 */
export function applySubagentTurns(agentsDir: string, turns: number): boolean {
    const path = join(agentsDir, "general-purpose.md");
    let current: string | null = null;
    try { current = readFileSync(path, "utf8"); } catch { /* absent */ }
    if (current !== null && !current.includes(TURNS_MARKER)) return false;
    if (turns <= 0) {
        if (current === null) return false;
        rmSync(path, { force: true });
        return true;
    }
    const next = generalPurposeAgent(turns);
    if (current === next) return false;
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(path, next);
    return true;
}

/** The configured compact window, and whether a config file sets it rather than the default. */
function configuredCompactWindow(): { tokens: number; explicit: boolean; } {
    const { config, sources } = readConfig();
    const explicit = sources.some((path) => readJson<Record<string, unknown>>(path)?.compactWindow !== undefined);
    return { tokens: config.compactWindow, explicit };
}

/** Installs the three subagent hooks, the compact window and the turn cap into one Claude config dir. */
export function applyClaudeSubagentWiring(settingsPath: string): boolean {
    let changed = false;
    for (const { event, phase, matcher } of HOOKS) {
        const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `enigma ${MARKER} ${phase}`, timeout: HOOK_TIMEOUT_S }] };
        if (applyClaudeHook(settingsPath, event, `${MARKER} ${phase}`, group, true) === "changed") changed = true;
    }
    const { tokens, explicit } = configuredCompactWindow();
    if (applyCompactWindow(settingsPath, tokens, explicit)) changed = true;
    if (applySubagentTurns(join(dirname(settingsPath), "agents"), readConfig().config.subagentTurns)) changed = true;
    return changed;
}

/**
 * Re-asserts the wiring for the default account. Called on install, on every sync (so `enigma
 * update` reaches an existing install) and when a setting changes. Returns true when it changed.
 */
export function applySubagentWiring(): boolean {
    return applyClaudeSubagentWiring(claudeGlobalSettings());
}

/** Mirrors the wiring into a managed account's config dir. */
export function mirrorSubagentWiring(toolName: string, accountDir: string): void {
    if (toolName === "claude") applyClaudeSubagentWiring(join(accountDir, "settings.json"));
}
