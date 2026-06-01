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

export interface EnigmaConfig {
    commitEmoji: boolean;
    updateNotifier: boolean;
}

/** Built-in defaults: everything the skills enable is on unless opted out. */
export const CONFIG_DEFAULTS: EnigmaConfig = { commitEmoji: true, updateNotifier: true };

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
 * already present. Returns the written file path.
 */
export function setEnigmaToggle(key: EnigmaConfigKey, value: boolean, scope: "global" | "local"): string {
    const path = configPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const next = { ...current, [key]: value };
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return path;
}
