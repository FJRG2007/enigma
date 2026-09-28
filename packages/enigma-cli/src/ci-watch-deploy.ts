/**
 * CI-notifier hook deployment. When the `ciWatch` toggle is on (default), enigma wires ONE
 * Claude Code hook so a failed workflow reaches the agent on its own:
 *
 *  - PostToolUse on Bash with `asyncRewake`. It runs in the background, so a Bash call never
 *    waits on it; it arms a watch when the call pushed, then waits on the state file for the
 *    verdict of this repository's pending push (its own, or one the gate pipeline made) and
 *    exits 2 on a failure, which wakes the model even after its turn ended. The timeout covers
 *    the poller's whole budget, since the host kills a hook at its timeout.
 *
 * The UserPromptSubmit entry older versions installed is REMOVED: it spawned the ~99 MB binary
 * before every prompt, measured at 16-22 s here against its 20 s budget, and `asyncRewake`
 * already delivers what it existed to backstop.
 *
 * It prints NOTHING unless there is an undelivered failure - so on the common path (a green
 * build) it costs a background process and not one model token.
 *
 * Claude Code only for now, deliberately. The delivery channel is a hook whose output is fed
 * back to the model, and it is the harness enigma can rely on for that; opencode and Kimi get
 * nothing rather than a hook that fires into a void (the same call trim-deploy documents for
 * Codex, and guardrails-deploy for Kimi).
 *
 * Node-builtins + config/util only (no engine import), the deploy counterpart of ci-watch.ts.
 */

import { join } from "node:path";
import { readConfig, setEnigmaToggle } from "./config";
import { applyClaudeHook, claudeGlobalSettings } from "./claude-hooks";

/** Tools whose output can be a push. Narrower than "every tool" to keep the spawn budget honest. */
const HOOK_MATCHER = "Bash";

/** Host timeout for the background hook, in seconds: the 30-minute poll, the log fetch, and slack. */
const HOOK_TIMEOUT_S = 2400;

/** True when the CI notifier is enabled (default on). */
export function isCiWatchOn(): boolean {
    return readConfig().config.ciWatch;
}

/**
 * Add (on) or remove (off) the enigma CI-notifier hooks in a Claude settings.json,
 * preserving every other hook and setting. Returns true when the file changed.
 */
export function applyClaudeCiWatchHooks(settingsPath: string, on: boolean): boolean {
    const post = applyClaudeHook(settingsPath, "PostToolUse", "__ci-hook", { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "enigma __ci-hook rewake", timeout: HOOK_TIMEOUT_S, asyncRewake: true }] }, on) === "changed";
    // Always removed, whatever the toggle: see the header.
    const prompt = applyClaudeHook(settingsPath, "UserPromptSubmit", "__ci-hook", {}, false) === "changed";
    return post || prompt;
}

/**
 * Re-assert the global wiring to match the current toggle (presence AND absence). Called on
 * install and on toggle, like the trim and code-graph wiring.
 */
export function applyCiWatchWiring(): void {
    applyClaudeCiWatchHooks(claudeGlobalSettings(), isCiWatchOn());
}

/** Mirror the wiring into a managed account's config dir so `enigma claude <account>` matches. */
export function mirrorCiWatchWiring(toolName: string, accountDir: string): void {
    if (toolName === "claude") applyClaudeCiWatchHooks(join(accountDir, "settings.json"), isCiWatchOn());
}

/**
 * Set the toggle and apply the wiring. Enabling adds the hooks; disabling removes them.
 * Returns the .enigma.json path written.
 */
export function setCiWatch(scope: "global" | "local", on: boolean): string {
    const path = setEnigmaToggle("ciWatch", on, scope);
    applyCiWatchWiring();
    return path;
}
