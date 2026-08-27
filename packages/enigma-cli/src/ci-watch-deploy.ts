/**
 * CI-notifier hook deployment. When the `ciWatch` toggle is on (default), enigma wires two
 * Claude Code hooks so a failed workflow reaches the agent on its own:
 *
 *  - PostToolUse on Bash, which is where a push comes from. This is the hook that ARMS a
 *    watch, and the one that delivers a verdict soonest - the agent is usually mid-task when
 *    the build breaks, and that is exactly when it is cheapest to fix.
 *  - UserPromptSubmit, as the backstop. A verdict that lands after the agent has stopped
 *    running commands would otherwise sit unread until the next one; this makes sure it is
 *    the first thing on the next turn instead.
 *
 * Both call the same hidden command, which prints NOTHING unless there is an undelivered
 * failure - so on the common path (a green build) these hooks cost a process start and not
 * one model token.
 *
 * Claude Code only for now, deliberately. The delivery channel is a hook whose stdout is fed
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

/** True when the CI notifier is enabled (default on). */
export function isCiWatchOn(): boolean {
    return readConfig().config.ciWatch;
}

/**
 * Add (on) or remove (off) the enigma CI-notifier hooks in a Claude settings.json,
 * preserving every other hook and setting. Returns true when the file changed.
 */
export function applyClaudeCiWatchHooks(settingsPath: string, on: boolean): boolean {
    const post = applyClaudeHook(settingsPath, "PostToolUse", "__ci-hook", { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "enigma __ci-hook PostToolUse", timeout: 20 }] }, on) === "changed";
    const prompt = applyClaudeHook(settingsPath, "UserPromptSubmit", "__ci-hook", { hooks: [{ type: "command", command: "enigma __ci-hook UserPromptSubmit", timeout: 20 }] }, on) === "changed";
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
