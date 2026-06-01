/**
 * User-facing enigma runtime config (.enigma.json). Small, optional, and read by
 * the coding agent itself - it is how a user opts out of behaviors the policy
 * skills enable by default (currently: commit-message emojis).
 *
 * Precedence when reading: built-in defaults, overridden by the global file
 * (~/.enigma.json), overridden by a repo-local file (<cwd>/.enigma.json). A skill
 * rule only persuades the model; this file is the deterministic toggle it checks.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isDir, readJson } from "./util";

export const CONFIG_FILE = ".enigma.json";

export interface EnigmaConfig {
    commitEmoji: boolean;
}

/** Built-in defaults: everything the skills enable is on unless opted out. */
export const CONFIG_DEFAULTS: EnigmaConfig = { commitEmoji: true };

type ConfigKey = keyof EnigmaConfig;
const BOOLEAN_KEYS: ConfigKey[] = ["commitEmoji"];

/** Map a CLI key (kebab-case) to its config field. */
const CLI_KEYS: Record<string, ConfigKey> = { "commit-emoji": "commitEmoji" };

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

function parseBool(value: string): boolean | null {
    const v = value.toLowerCase();
    if (["on", "true", "yes", "1", "enable", "enabled"].includes(v)) return true;
    if (["off", "false", "no", "0", "disable", "disabled"].includes(v)) return false;
    return null;
}

/**
 * Set a single key in the chosen scope's .enigma.json, preserving any other keys
 * already present. Returns the written file path.
 */
function setValue(scope: "global" | "local", key: ConfigKey, value: boolean): string {
    const path = configPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const next = { ...current, [key]: value };
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return path;
}

/**
 * `enigma config` command. With no positional args, prints the effective config
 * and its sources. With `<key> <on|off>`, writes that key to the given scope
 * (default: global). Returns a process exit code.
 */
export function runConfigCli(positionals: string[], scope: "global" | "local" | null): number {
    const [rawKey, rawValue] = positionals;

    if (!rawKey) {
        const { config, sources } = readConfig();
        console.log("Effective enigma config:");
        for (const k of BOOLEAN_KEYS) {
            const cliKey = Object.keys(CLI_KEYS).find((c) => CLI_KEYS[c] === k) || k;
            console.log(`  ${cliKey}: ${config[k]}`);
        }
        console.log(sources.length ? `\nFrom: ${sources.join(", ")}` : "\nFrom: built-in defaults (no .enigma.json found)");
        return 0;
    }

    const key = CLI_KEYS[rawKey];
    if (!key) {
        console.error(`Unknown config key: ${rawKey}. Known keys: ${Object.keys(CLI_KEYS).join(", ")}.`);
        return 1;
    }
    if (rawValue === undefined) {
        console.error(`Missing value for '${rawKey}'. Usage: enigma config ${rawKey} <on|off>`);
        return 1;
    }
    const value = parseBool(rawValue);
    if (value === null) {
        console.error(`Invalid value '${rawValue}' for '${rawKey}'. Use on or off.`);
        return 1;
    }

    const target = scope || "global";
    const path = setValue(target, key, value);
    console.log(`Set ${rawKey} = ${value ? "on" : "off"} (${target}) in ${path}.`);
    return 0;
}
