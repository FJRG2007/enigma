/**
 * Global commit-guard configuration: which protections enigma's git guard enforces by
 * default, stored in ~/.enigma-guard.json. This is the user-wide BASE the standalone guard
 * (guard.ts) reads under any per-repo .githooks/enigma-guard.json override, so toggling a
 * protection here changes enforcement for every repo that does not override it.
 *
 * Kept dependency-free and light (Node builtins only) so the settings registry - which
 * surfaces these in the TUI AND the dashboard - can import it without pulling in clack or
 * the security install machinery (that lives in security.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

export type GuardKey = "secrets" | "envFiles" | "depDirs" | "generatedDirs" | "junkFiles" | "largeFiles";

export interface GuardProtection { value: GuardKey; label: string; hint: string; }

/** All toggleable guard protections, in display order (shared by `enigma security`, the registry and the dashboard). */
export const GUARD_PROTECTIONS: GuardProtection[] = [
    { value: "secrets", label: "Block committed secrets", hint: "API keys, tokens, and private-key / keystore files (.pem, .key, .p12, .pfx, .jks, id_rsa)" },
    { value: "envFiles", label: "Block .env files", hint: "allows .env.example / .sample / .template" },
    { value: "depDirs", label: "Block dependency/cache dirs", hint: "node_modules, __pycache__, venv" },
    { value: "generatedDirs", label: "Warn on generated dirs", hint: "dist, build, .next, coverage" },
    { value: "junkFiles", label: "Warn on log / OS junk files", hint: ".log, .DS_Store, Thumbs.db" },
    { value: "largeFiles", label: "Warn on files over 5 MB", hint: "oversized blobs" },
];

/** User-supplied lists that refine the guard beyond the built-in protections. */
export interface GuardLists {
    /** Extra glob patterns to BLOCK from commits (on top of the built-in rules). */
    blockPaths: string[];
    /** Glob patterns the guard never flags, even if they look risky (an allowlist). */
    allowPaths: string[];
    /** Extra regular-expression sources treated as secrets (JS regex source, no slashes). */
    secretPatterns: string[];
}

export type GuardListKey = keyof GuardLists;

export interface GuardListMeta { field: GuardListKey; value: string; label: string; hint: string; placeholder: string; }

/** Metadata for the user-editable guard lists (shared by the registry, TUI and dashboard). */
export const GUARD_LISTS: GuardListMeta[] = [
    { field: "blockPaths", value: "block-paths", label: "Extra blocked paths", hint: "additional glob patterns to block from commits (e.g. secrets/*.json, *.local.env)", placeholder: "e.g. secrets/*.json" },
    { field: "allowPaths", value: "allow-paths", label: "Excluded paths (allowlist)", hint: "glob patterns the guard never flags, even if risky (e.g. tests/fixtures/**)", placeholder: "e.g. tests/fixtures/**" },
    { field: "secretPatterns", value: "secret-patterns", label: "Custom secret patterns", hint: "extra regex sources treated as secrets (e.g. mycorp_[a-z0-9]{32})", placeholder: "e.g. mycorp_[a-z0-9]{32}" },
];

export interface GuardConfig extends Record<GuardKey, boolean>, GuardLists {}

/** Defaults: every protection on (matches the standalone guard's missing-key behavior); lists empty. */
function defaults(): GuardConfig {
    return { secrets: true, envFiles: true, depDirs: true, generatedDirs: true, junkFiles: true, largeFiles: true, blockPaths: [], allowPaths: [], secretPatterns: [] };
}

/** The user-wide guard config file enigma's guard reads as its base layer. */
export function globalGuardPath(): string {
    return join(homedir(), ".enigma-guard.json");
}

/** Read the global guard config (defaults overlaid by ~/.enigma-guard.json). */
export function readGlobalGuard(): GuardConfig {
    try {
        const raw = JSON.parse(readFileSync(globalGuardPath(), "utf8"));
        const cfg = { ...defaults(), ...raw };
        // Defend against a hand-edited file: list fields must stay string arrays.
        for (const l of GUARD_LISTS) if (!Array.isArray(cfg[l.field])) cfg[l.field] = [];
        return cfg;
    } catch { return defaults(); }
}

/** Write the full guard config back in canonical order (protections then lists). */
function writeGuard(cfg: GuardConfig): void {
    const out: Partial<GuardConfig> = {};
    for (const p of GUARD_PROTECTIONS) out[p.value] = cfg[p.value];
    for (const l of GUARD_LISTS) out[l.field] = cfg[l.field];
    writeFileSync(globalGuardPath(), JSON.stringify(out, null, 2) + "\n");
}

/** Set one protection on/off in the global guard config, preserving the others (and the lists). */
export function setGuardProtection(key: GuardKey, on: boolean): void {
    const cur = readGlobalGuard();
    cur[key] = on;
    writeGuard(cur);
}

/** Replace one of the guard's user lists (block/allow/secret patterns), deduped and trimmed. */
export function setGuardList(key: GuardListKey, values: string[]): void {
    const cur = readGlobalGuard();
    const seen = new Set<string>();
    cur[key] = values.map((v) => v.trim()).filter((v) => v && !seen.has(v) && (seen.add(v), true));
    writeGuard(cur);
}
