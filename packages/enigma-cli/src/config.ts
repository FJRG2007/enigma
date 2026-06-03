/**
 * User-facing enigma runtime config (.enigma.json). Small, optional, and read by
 * the coding agent itself - it is how a user opts out of behaviors the policy
 * skills enable by default (e.g. commit-message emojis, update notifications).
 *
 * Precedence when reading: built-in defaults, overridden by the global file
 * (~/.enigma.json), overridden by a repo-local file (<cwd>/.enigma.json). A skill
 * rule only persuades the model; this file is the deterministic toggle it checks.
 *
 * This module is the data layer for .enigma.json only. The CLI/TUI config surface
 * (key registry, `enigma config` command, interactive menu) lives in settings.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isDir, readJson } from "./util";

export const CONFIG_FILE = ".enigma.json";

/**
 * Output compression level for agent prose replies. "off" disables it; the rest are
 * graded terseness, deployed as a memory-file section (see skills.ts renderMemory).
 * "lite" is professional terse (keeps grammar/language), "full"/"ultra" go shorter.
 */
export type OutputStyle = "off" | "lite" | "full" | "ultra";
export const OUTPUT_STYLES: readonly OutputStyle[] = ["off", "lite", "full", "ultra"];

export interface EnigmaConfig {
    commitEmoji: boolean;
    updateNotifier: boolean;
    fullscreen: boolean;
    parallelSubagents: boolean;
    outputStyle: OutputStyle;
}

/**
 * Built-in defaults: everything the skills enable is on unless opted out.
 * fullscreen clears the screen so the TUI renders cleanly (on by default); it uses
 * an OS-agnostic clear rather than the alternate screen buffer, so exiting returns
 * to the shell without wiping/restoring the terminal.
 * parallelSubagents is opt-in (off): spawning sub-agents in parallel multiplies
 * token cost, so it stays explicit. When on, the deployed memory file gains the
 * parallel sub-agent section (subtask decomposition itself is always on).
 * outputStyle is opt-in (off): it changes the voice of every reply, so it is an
 * explicit choice. When not off, the memory file gains the token-efficient output
 * section keyed to the chosen level.
 */
export const CONFIG_DEFAULTS: EnigmaConfig = {
    commitEmoji: true, updateNotifier: true, fullscreen: true, parallelSubagents: false, outputStyle: "off",
};

export type EnigmaConfigKey = keyof EnigmaConfig;

function configPath(scope: "global" | "local"): string {
    return scope === "global" ? join(homedir(), CONFIG_FILE) : join(process.cwd(), CONFIG_FILE);
}

/** Effective config plus the files that contributed, nearest (local) last. */
export function readConfig(): { config: EnigmaConfig; sources: string[] } {
    const sources: string[] = [];
    let config: EnigmaConfig = { ...CONFIG_DEFAULTS };
    for (const scope of ["global", "local"] as const) {
        const path = configPath(scope);
        const raw = existsSync(path) ? readJson<Partial<EnigmaConfig>>(path) : null;
        if (raw) { config = { ...config, ...raw }; sources.push(path); }
    }
    return { config, sources };
}

/**
 * Set a single key in the chosen scope's .enigma.json, preserving any other keys
 * already present. Accepts boolean toggles and string-valued settings alike.
 * Returns the written file path.
 */
export function setEnigmaValue(key: EnigmaConfigKey, value: boolean | string, scope: "global" | "local"): string {
    const path = configPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const next = { ...current, [key]: value };
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return path;
}

/** Boolean-toggle convenience over setEnigmaValue, for the on/off settings. */
export function setEnigmaToggle(key: EnigmaConfigKey, value: boolean, scope: "global" | "local"): string {
    return setEnigmaValue(key, value, scope);
}
