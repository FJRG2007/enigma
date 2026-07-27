/**
 * Verify hook deployment. When the `verify` toggle is on (default), enigma wires a
 * turn-end hook into Claude Code so that a completion claim is checked against what the
 * turn actually produced before the agent is allowed to stop. The engine is bundled in
 * enigma, so the hook just invokes the hidden `enigma __verify-hook` command (which reads
 * the Stop payload from stdin) - no runner file to maintain.
 *
 * Claude Code only, by capability rather than preference: its `Stop` hook is the one
 * documented turn-end hook that can DENY the stop (exit 2 feeds stderr back and the turn
 * continues). Codex has no turn-end hook at all, and opencode's `session.idle` event has no
 * documented way to block a turn or return anything to the model, so wiring either would
 * only pretend to gate them. Those two are covered by `enigma verify` plus the always-on
 * memory rule instead, which is honest about being persuasion rather than enforcement.
 *
 * Node-builtins + config/util only (no engine import), like guardrails-deploy.ts: this is
 * the deploy counterpart, cheap to load and free of cycles.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { HookWrite } from "./claude-hooks";
import { applyClaudeHook } from "./claude-hooks";
import { readGlobalConfig, setEnigmaToggle } from "./config";

/**
 * True when the completion gate is enabled (default on).
 *
 * Deliberately the GLOBAL value, not the cwd-merged one: this drives wiring that is written
 * to the global agent settings, and auto-sync re-asserts it on every launch. Reading a
 * repo-local `verify: false` here would let launching from inside one project strip the hook
 * for every other project. The per-project opt-out is honoured where it belongs - at runtime,
 * in runVerifyHook, against the directory the turn actually ran in.
 */
export function isVerifyOn(): boolean {
    return readGlobalConfig().verify;
}

/** The hook command: the hidden verify subcommand of the enigma binary on PATH. */
function hookCommand(): string {
    return "enigma __verify-hook";
}

/**
 * Add (on) or remove (off) the enigma Stop hook in a Claude settings.json, preserving
 * every other hook and setting. Returns true when the file changed.
 *
 * The timeout covers the project's own verification command when one is configured, so
 * it is generous compared with the per-edit guardrails hook.
 */
export function applyClaudeVerifyHook(settingsPath: string, on: boolean): boolean {
    return writeVerifyHook(settingsPath, on) === "changed";
}

/** The same write, reporting whether it was refused rather than collapsing that into "no change". */
function writeVerifyHook(settingsPath: string, on: boolean): HookWrite {
    return applyClaudeHook(settingsPath, "Stop", "__verify-hook", { hooks: [{ type: "command", command: hookCommand(), timeout: 330 }] }, on);
}

/** Global Claude settings.json for the default account. */
function claudeGlobalSettings(): string {
    return join(homedir(), ".claude", "settings.json");
}

/**
 * Re-assert the global wiring to match the current toggle (presence AND absence).
 * Called on install, on toggle, and on auto-sync. Returns true when the settings changed,
 * so a caller can tell the user the first time the gate is actually installed for them.
 */
export function applyVerifyWiring(): boolean {
    const result = writeVerifyHook(claudeGlobalSettings(), isVerifyOn());
    // A refusal means the gate is NOT installed. Saying so beats the alternative, where the
    // user believes it is on and only learns otherwise by never being stopped.
    if (result === "refused") {
        process.stderr.write(`enigma: could not read ${claudeGlobalSettings()}, so completion checks were not installed. Fix the JSON in that file and run 'enigma install'.\n`);
    }
    return result === "changed";
}

/**
 * Mirror the verify wiring into a managed account's config dir, matching the global
 * toggle, so `enigma claude <account>` behaves like the default account.
 */
export function mirrorVerifyWiring(toolName: string, accountDir: string): void {
    if (toolName === "claude") applyClaudeVerifyHook(join(accountDir, "settings.json"), isVerifyOn());
}

/**
 * Set the verify toggle and apply the global wiring. Enabling adds the Stop hook;
 * disabling removes it. Returns the .enigma.json path written.
 */
export function setVerify(scope: "global" | "local", on: boolean): string {
    const path = setEnigmaToggle("verify", on, scope);
    applyVerifyWiring();
    return path;
}
