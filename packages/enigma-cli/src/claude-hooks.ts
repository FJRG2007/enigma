/**
 * One read-merge-write for enigma's hooks in a Claude Code settings.json.
 *
 * Both the post-edit guardrails hook and the turn-end completion gate need the same thing:
 * add or remove exactly their own entry under one hook event, leave every other hook and
 * setting untouched, and be idempotent. They were written twice and had already drifted -
 * one copy refused to rewrite an unparseable settings file, the other silently replaced it,
 * which would have discarded everything the user had in it. Sharing the merge keeps the safe
 * behaviour in one place, where the next hook inherits it rather than reimplementing it.
 *
 * Node builtins + util only, so it stays as cheap to load as the deploy modules that use it.
 */

import { dirname, join } from "node:path";
import { readJson, enigmaHome } from "./util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/** One hook entry as Claude Code's settings.json stores it. */
export interface HookEntry { type?: string; command?: string; timeout?: number; }

/** A group of hooks under one event, optionally narrowed by a tool matcher. */
export interface HookGroup { matcher?: string; hooks?: HookEntry[]; }

/**
 * What a hook write did. `refused` is kept distinct from `unchanged` on purpose: they both
 * mean "nothing was written", but one of them means the hook is NOT installed and the user
 * has no idea - which is the failure this whole area keeps having to design against.
 */
export type HookWrite = "changed" | "unchanged" | "refused";

/**
 * Add (`on`) or remove the enigma group for `event` in a Claude settings.json, identified by
 * `marker` appearing in its command so the operation is idempotent and never touches a hook
 * the user wrote.
 */
/**
 * Global Claude settings.json for the default account.
 *
 * enigmaHome(), never a raw homedir(): bun on Linux does not reflect a runtime-reassigned
 * $HOME through os.homedir(), so a test would wire its hooks into the real home dir.
 */
export function claudeGlobalSettings(): string {
    return join(enigmaHome(), ".claude", "settings.json");
}

export function applyClaudeHook(settingsPath: string, event: string, marker: string, group: HookGroup, on: boolean): HookWrite {
    const parsed = readJson<Record<string, unknown>>(settingsPath);
    // Refuse to touch a settings file that exists but cannot be parsed: writing a fresh one
    // would silently discard everything the user has in it.
    if (parsed === null && existsSync(settingsPath)) return "refused";
    const current = parsed || {};

    const hooks = (typeof current.hooks === "object" && current.hooks !== null) ? { ...current.hooks as Record<string, unknown> } : {};
    const existing: HookGroup[] = Array.isArray(hooks[event]) ? [...hooks[event] as HookGroup[]] : [];
    const isOurs = (g: HookGroup): boolean => Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === "string" && h.command.includes(marker));

    const rest = existing.filter((g) => !isOurs(g));
    const next = on ? [...rest, group] : rest;
    if (next.length) hooks[event] = next; else delete hooks[event];

    const nextSettings: Record<string, unknown> = { ...current };
    if (Object.keys(hooks).length) nextSettings.hooks = hooks; else delete nextSettings.hooks;

    if (JSON.stringify(nextSettings) === JSON.stringify(current)) return "unchanged";
    // Never create a settings file just to record the absence of a hook.
    if (!existsSync(settingsPath) && Object.keys(nextSettings).length === 0) return "unchanged";
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
    return "changed";
}
