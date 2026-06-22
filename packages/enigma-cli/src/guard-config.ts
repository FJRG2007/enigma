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
    { value: "secrets", label: "Block committed secrets", hint: "API keys, tokens, private keys" },
    { value: "envFiles", label: "Block .env files", hint: "allows .env.example / .sample / .template" },
    { value: "depDirs", label: "Block dependency/cache dirs", hint: "node_modules, __pycache__, venv" },
    { value: "generatedDirs", label: "Warn on generated dirs", hint: "dist, build, .next, coverage" },
    { value: "junkFiles", label: "Warn on log / OS junk files", hint: ".log, .DS_Store, Thumbs.db" },
    { value: "largeFiles", label: "Warn on files over 5 MB", hint: "oversized blobs" },
];

export type GuardConfig = Record<GuardKey, boolean>;

/** Defaults: every protection on (matches the standalone guard's missing-key behavior). */
function defaults(): GuardConfig {
    return { secrets: true, envFiles: true, depDirs: true, generatedDirs: true, junkFiles: true, largeFiles: true };
}

/** The user-wide guard config file enigma's guard reads as its base layer. */
export function globalGuardPath(): string {
    return join(homedir(), ".enigma-guard.json");
}

/** Read the global guard config (defaults overlaid by ~/.enigma-guard.json). */
export function readGlobalGuard(): GuardConfig {
    try { return { ...defaults(), ...JSON.parse(readFileSync(globalGuardPath(), "utf8")) }; }
    catch { return defaults(); }
}

/** Set one protection on/off in the global guard config, preserving the others. */
export function setGuardProtection(key: GuardKey, on: boolean): void {
    const cur = readGlobalGuard();
    cur[key] = on;
    // Persist only the known keys, in canonical order, so the file stays clean.
    const out: Partial<GuardConfig> = {};
    for (const p of GUARD_PROTECTIONS) out[p.value] = cur[p.value];
    writeFileSync(globalGuardPath(), JSON.stringify(out, null, 2) + "\n");
}
