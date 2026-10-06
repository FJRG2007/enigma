/**
 * Wiring for the subagent budget (subagents.ts) and the auto-compact window, both written into
 * Claude Code's settings.json for the default account and mirrored into every managed account.
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
 * Node builtins + config/util only, the deploy counterpart of subagents.ts.
 */

import { join } from "node:path";
import { readJson } from "./util";
import { readConfig } from "./config";
import { existsSync, writeFileSync } from "node:fs";
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
 * user's own value (or Claude Code's default) stands. Refuses an unparseable file rather than
 * replacing it. Returns true when the file changed.
 */
export function applyCompactWindow(settingsPath: string, tokens: number): boolean {
    if (tokens <= 0) return false;
    const current = readJson<Record<string, unknown>>(settingsPath);
    if (current === null && existsSync(settingsPath)) return false;
    if (current?.autoCompactWindow === tokens) return false;
    writeFileSync(settingsPath, `${JSON.stringify({ ...current, autoCompactWindow: tokens }, null, 2)}\n`);
    return true;
}

/** Installs the three subagent hooks and the compact window into one Claude settings.json. */
export function applyClaudeSubagentWiring(settingsPath: string): boolean {
    let changed = false;
    for (const { event, phase, matcher } of HOOKS) {
        const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `enigma ${MARKER} ${phase}`, timeout: HOOK_TIMEOUT_S }] };
        if (applyClaudeHook(settingsPath, event, `${MARKER} ${phase}`, group, true) === "changed") changed = true;
    }
    if (applyCompactWindow(settingsPath, readConfig().config.compactWindow)) changed = true;
    return changed;
}

/** Re-asserts the wiring for the default account. Called on install and when a setting changes. */
export function applySubagentWiring(): void {
    applyClaudeSubagentWiring(claudeGlobalSettings());
}

/** Mirrors the wiring into a managed account's config dir. */
export function mirrorSubagentWiring(toolName: string, accountDir: string): void {
    if (toolName === "claude") applyClaudeSubagentWiring(join(accountDir, "settings.json"));
}
