/**
 * Export / import of a user's enigma configuration as a single portable JSON bundle,
 * driven from the dashboard (the browser's download + file-picker is what "asks where to
 * save / import"). Deliberately SECRET-FREE: it carries the runtime config, the guard
 * config and the account/profile STRUCTURE (names + tool->account mappings) but never any
 * auth token or credential - those stay machine-local, so the bundle is safe to move or
 * share. Importing recreates the structure (and seeds fresh account dirs); the user then
 * logs each account in per machine.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE } from "./config";
import type { EnigmaConfig } from "./config";
import { GUARD_PROTECTIONS, GUARD_LISTS, globalGuardPath, readGlobalGuard, setGuardProtection, setGuardList } from "./guard-config";
import { ALL_SETTINGS } from "./settings-registry";
import {
    DEFAULT_NAME, TOOL_NAMES, accountExists, addAccount, getActive, getActiveProfile,
    listAccounts, listProfiles, addProfile, setActive, setActiveProfile, setProfileAccount,
} from "./accounts";

export const BUNDLE_KIND = "enigma-config";
export const BUNDLE_VERSION = 1;

export interface ConfigBundle {
    kind: typeof BUNDLE_KIND;
    version: number;
    exportedAt: number;
    /** The user's explicit global .enigma.json (intent), defaults excluded. */
    config: Partial<EnigmaConfig>;
    /** The user-wide commit-guard config (protections + custom lists). */
    guard: Record<string, unknown>;
    /** Account/profile structure - names and mappings only, NEVER auth tokens. */
    accounts: {
        tools: Record<string, { active: string; accounts: string[] }>;
        profiles: { active: string | null; items: Record<string, Record<string, string>> };
    };
}

function globalConfigPath(): string {
    return join(homedir(), CONFIG_FILE);
}

/** Config keys that hold a secret and must never be exported. */
const SECRET_CONFIG_KEYS = ["recallApiKey"];

/** Drop secret keys from a config object before it leaves the machine. */
function stripSecrets(config: Partial<EnigmaConfig>): Partial<EnigmaConfig> {
    const out = { ...config };
    for (const k of SECRET_CONFIG_KEYS) delete (out as Record<string, unknown>)[k];
    return out;
}

/** Read the user's explicit global .enigma.json (not the merged effective config). */
function readGlobalConfigFile(): Partial<EnigmaConfig> {
    try { return JSON.parse(readFileSync(globalConfigPath(), "utf8")) as Partial<EnigmaConfig>; } catch { return {}; }
}

/** Build the secret-free export bundle. */
export function exportBundle(): ConfigBundle {
    const tools: Record<string, { active: string; accounts: string[] }> = {};
    for (const tool of TOOL_NAMES) {
        tools[tool] = {
            active: getActive(tool),
            accounts: listAccounts(tool).filter((a) => a.name !== DEFAULT_NAME).map((a) => a.name),
        };
    }
    const items: Record<string, Record<string, string>> = {};
    for (const p of listProfiles()) items[p.name] = p.accounts;
    return {
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        exportedAt: Date.now(),
        config: stripSecrets(readGlobalConfigFile()),
        guard: readGlobalGuard() as unknown as Record<string, unknown>,
        accounts: { tools, profiles: { active: getActiveProfile()?.name ?? null, items } },
    };
}

export interface ImportResult { ok: boolean; error?: string; applied: string[]; skipped: string[]; }

/** Allowed config keys = the settings registry + the numeric/string knobs outside it (no secrets). */
const NUMERIC_KEYS = new Set(["tokenPrice", "tokenSpeed", "dashboardPort"]);
const STRING_KEYS = new Set(["recallProvider", "recallModel", "recallApiBase"]);
function isImportableConfigKey(key: string): boolean {
    if (SECRET_CONFIG_KEYS.includes(key)) return false;
    return NUMERIC_KEYS.has(key) || STRING_KEYS.has(key) || ALL_SETTINGS.some((s) => s.key.replace(/-/g, "") === key.toLowerCase());
}

/**
 * Apply a bundle: merge config + guard, then recreate account/profile structure (creating
 * any missing account dir, seeded with skills/memory). Resilient and additive - it never
 * deletes existing accounts/profiles, and each step is independently fault-tolerant so one
 * bad entry cannot abort the rest. Returns a summary of what was applied vs skipped.
 */
export async function importBundle(raw: unknown): Promise<ImportResult> {
    const applied: string[] = [];
    const skipped: string[] = [];
    const b = raw as Partial<ConfigBundle> | null;
    if (!b || b.kind !== BUNDLE_KIND || typeof b.config !== "object") {
        return { ok: false, error: "Not an enigma config bundle.", applied, skipped };
    }

    // 1) Runtime config: write recognized keys to the global .enigma.json (merge, never clobber).
    try {
        const cur = readGlobalConfigFile() as Record<string, unknown>;
        let n = 0;
        for (const [k, v] of Object.entries(b.config as Record<string, unknown>)) {
            if (!isImportableConfigKey(k)) { skipped.push(`config.${k}`); continue; }
            cur[k] = v; n++;
        }
        writeFileSync(globalConfigPath(), JSON.stringify(cur, null, 2) + "\n");
        applied.push(`config (${n} key${n === 1 ? "" : "s"})`);
    } catch (err) { skipped.push(`config (${(err as Error).message})`); }

    // 2) Guard config: re-apply protections and lists through the validating setters.
    if (b.guard && typeof b.guard === "object") {
        try {
            const g = b.guard as Record<string, unknown>;
            for (const p of GUARD_PROTECTIONS) if (typeof g[p.value] === "boolean") setGuardProtection(p.value, g[p.value] as boolean);
            for (const l of GUARD_LISTS) if (Array.isArray(g[l.field])) setGuardList(l.field, (g[l.field] as unknown[]).map(String));
            applied.push("guard config");
        } catch (err) { skipped.push(`guard (${(err as Error).message})`); }
    }

    // 3) Accounts + profiles: additive recreation of the structure (fresh dirs, no secrets).
    const acc = b.accounts;
    if (acc && typeof acc === "object") {
        const tools = acc.tools || {};
        for (const tool of TOOL_NAMES) {
            const spec = tools[tool];
            if (!spec || !Array.isArray(spec.accounts)) continue;
            for (const nameRaw of spec.accounts) {
                const name = String(nameRaw);
                if (accountExists(tool, name)) { skipped.push(`${tool}/${name} (exists)`); continue; }
                try {
                    const a = addAccount(tool, name);
                    try { const { syncAccount } = await import("./skills"); syncAccount(tool, a.dir); } catch { /* seeded on launch */ }
                    applied.push(`${tool}/${name}`);
                } catch (err) { skipped.push(`${tool}/${name} (${(err as Error).message})`); }
            }
            if (spec.active && accountExists(tool, spec.active)) { try { setActive(tool, spec.active); } catch { /* */ } }
        }
        const profs = acc.profiles;
        if (profs && profs.items && typeof profs.items === "object") {
            for (const [pname, mapping] of Object.entries(profs.items)) {
                try {
                    if (!listProfiles().some((p) => p.name === pname)) addProfile(pname);
                    for (const [tool, account] of Object.entries(mapping || {})) {
                        if (TOOL_NAMES.includes(tool) && accountExists(tool, String(account))) {
                            try { setProfileAccount(pname, tool, String(account)); } catch { /* skip bad mapping */ }
                        }
                    }
                    applied.push(`profile ${pname}`);
                } catch (err) { skipped.push(`profile ${pname} (${(err as Error).message})`); }
            }
            if (profs.active) { try { setActiveProfile(profs.active); } catch { /* */ } }
        }
    }
    return { ok: true, applied, skipped };
}
