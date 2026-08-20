/**
 * Code-graph hook deployment. When the `codeGraph` toggle is on, enigma wires four hooks into
 * Claude Code so the graph rides along in a session instead of waiting to be called:
 * orientation at session start, locators per prompt, a blast radius after an edit, and a
 * background re-index at the end of a turn that changed code.
 *
 * The runtime is bundled in enigma, so each entry just invokes the hidden
 * `enigma __codegraph-hook <event>` command (which reads the hook payload from stdin) - there is
 * no runner file to install or keep in step.
 *
 * Claude Code only, deliberately. The other hosts either have no equivalent event (Codex has no
 * per-prompt hook) or fire observation-only hooks whose output reaches nothing, so wiring them
 * would spend a process per prompt to produce silence. They still get the MCP tools, which is the
 * pull half and works everywhere.
 *
 * Node-builtins + config/util only (no engine import): this is the deploy counterpart of
 * codegraph-hook.ts, and it must stay cheap to load and free of cycles.
 */

import { join } from "node:path";
import { enigmaHome } from "./util";
import { applyClaudeHook } from "./claude-hooks";
import { readConfig, setEnigmaToggle } from "./config";

/** True when the code graph is enabled. */
export function isCodeGraphOn(): boolean {
    return readConfig().config.codeGraph;
}

/** Edit tools whose writes should draw a blast radius. */
const EDIT_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

/**
 * One entry per event. The timeouts are the budget each hook has to answer in, and they differ on
 * purpose: session start is paid once and may need a cold index, so it gets the most room.
 *
 * None of them can be tight, because the floor is not the hook's own work. Every entry spawns the
 * launcher's Node process and then the ~108 MB Bun binary, and the engine then parses the whole
 * stored graph before it can answer - measured on this monorepo (1.5k files, 23k symbols) at 3-4.5 s
 * to reach `--version` and 5-7.5 s to load the graph and probe drift, on a host with Defender
 * real-time scanning on. A budget that only covers the happy path does not degrade gracefully: the
 * host kills the hook, discards its output, and prints a "timed out" warning into the session, so
 * the process cost is paid on every prompt and buys nothing but noise. These are sized for the
 * measured worst case rather than the median.
 */
const HOOK_EVENTS: { event: string; arg: string; matcher?: string; timeout: number; }[] = [
    { event: "SessionStart", arg: "session-start", timeout: 45 },
    { event: "UserPromptSubmit", arg: "prompt", timeout: 25 },
    { event: "PostToolUse", arg: "post-edit", matcher: EDIT_MATCHER, timeout: 25 },
    { event: "Stop", arg: "stop", timeout: 25 },
];

/**
 * Add (on) or remove (off) every enigma code-graph hook in a Claude settings.json, preserving all
 * other hooks and settings. Returns true when the file changed.
 */
export function applyClaudeCodeGraphHooks(settingsPath: string, on: boolean): boolean {
    let changed = false;
    for (const { event, arg, matcher, timeout } of HOOK_EVENTS) {
        const group = {
            ...(matcher ? { matcher } : {}),
            hooks: [{ type: "command", command: `enigma __codegraph-hook ${arg}`, timeout }],
        };
        // The marker is the per-event argument, not the bare command name: all four entries share
        // the command, so matching on that alone would make each event's write delete the others.
        if (applyClaudeHook(settingsPath, event, `__codegraph-hook ${arg}`, group, on) === "changed") changed = true;
    }
    return changed;
}

// enigmaHome(), never a raw homedir(): bun on Linux does not reflect a runtime-reassigned
// $HOME through os.homedir(), so a test would wire its hooks into the real home dir.
function claudeGlobalSettings(): string {
    return join(enigmaHome(), ".claude", "settings.json");
}

/**
 * Re-assert the global wiring to match the current toggle (presence AND absence). Called on
 * install and on toggle, exactly like the guardrails and trim wiring.
 */
export function applyCodeGraphWiring(): void {
    applyClaudeCodeGraphHooks(claudeGlobalSettings(), isCodeGraphOn());
}

/**
 * Mirror the wiring into a managed account's config dir so `enigma claude <account>` behaves like
 * the default. Claude is the only host with these events, so it is the only one mirrored.
 */
export function mirrorCodeGraphWiring(toolName: string, accountDir: string): void {
    if (toolName === "claude") applyClaudeCodeGraphHooks(join(accountDir, "settings.json"), isCodeGraphOn());
}

/** Persist the toggle and re-assert the hook wiring. Returns the .enigma.json path written. */
export function setCodeGraphHooks(scope: "global" | "local", on: boolean): string {
    const path = setEnigmaToggle("codeGraph", on, scope);
    applyCodeGraphWiring();
    return path;
}
