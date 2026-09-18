/**
 * Which account a gate run's agents authenticate as.
 *
 * The daemon is one long-lived process shared by every session on the machine, so
 * its own environment belongs to whichever session happened to start it. Letting
 * agents inherit it meant a run pushed from one account's session spent another
 * account's quota, silently. Instead the pusher snapshots its account variables
 * (`captureAccountEnv`), the snapshot travels with the push or rerun request, and
 * the daemon pins it to the run's worktree (`registerRunAccountEnv`). Every child
 * spawned with a cwd inside that worktree gets it applied over the daemon's own
 * environment (`withRunAccountEnv`, called from spawnConfigured), which covers the
 * step agents, their servers and the configured commands alike.
 *
 * A null value means "unset in the pusher" and removes the variable from the child,
 * so a session on a tool's default account never inherits a managed account the
 * daemon happened to start with.
 */

import { accountEnvKeys } from "@/accounts";
import { isAbsolute, resolve, sep } from "node:path";

/** Account variable -> config dir, or null when the pusher had it unset. */
export type AccountEnv = Record<string, string | null>;

const runAccounts = new Map<string, AccountEnv>();

/** Snapshots the account variables of `env`; every known variable is present. */
export function captureAccountEnv(env: NodeJS.ProcessEnv = process.env): AccountEnv {
    const snapshot: AccountEnv = {};
    for (const key of accountEnvKeys()) {
        const value = env[key]?.trim() ?? "";
        snapshot[key] = value === "" ? null : value;
    }
    return snapshot;
}

/**
 * Validates an account snapshot from the wire. Undefined means the client predates
 * the field. A variable the snapshot omits counts as unset, because the snapshot is
 * the pusher's whole account state, never a partial override.
 */
export function decodeAccountEnv(raw: unknown): AccountEnv | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("account_env must be an object");
    const keys = accountEnvKeys();
    const entries = raw as Record<string, unknown>;
    for (const key of Object.keys(entries)) {
        if (!keys.includes(key)) throw new Error(`account_env: unsupported variable "${key}"`);
    }
    const decoded: AccountEnv = {};
    for (const key of keys) {
        const value = entries[key];
        if (value === undefined || value === null) {
            decoded[key] = null;
            continue;
        }
        if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
            throw new Error(`account_env: "${key}" must be an absolute path or null`);
        }
        decoded[key] = value;
    }
    return decoded;
}

/** One-line rendering for logs: `KEY=dir` or `KEY=(unset)` per variable. */
export function describeAccountEnv(env: AccountEnv): string {
    return Object.entries(env).map(([key, value]) => `${key}=${value ?? "(unset)"}`).join(" ");
}

function pathKey(path: string): string {
    const full = resolve(path);
    return process.platform === "win32" ? full.toLowerCase() : full;
}

/** Pins `env` to every process spawned inside `worktree` until unregistered. */
export function registerRunAccountEnv(worktree: string, env: AccountEnv): void {
    runAccounts.set(pathKey(worktree), env);
}

export function unregisterRunAccountEnv(worktree: string): void {
    runAccounts.delete(pathKey(worktree));
}

/** The account snapshot pinned to the worktree containing `cwd`, or null. */
export function runAccountEnvFor(cwd: string | undefined): AccountEnv | null {
    if (cwd === undefined || cwd === "" || runAccounts.size === 0) return null;
    const target = pathKey(cwd);
    for (const [root, env] of runAccounts) {
        if (target === root || target.startsWith(root + sep)) return env;
    }
    return null;
}

/**
 * Returns `base` with the run's account applied when `cwd` is inside a registered
 * worktree, else `base` unchanged. Windows matches variable names case-insensitively,
 * so a differently cased copy of a variable is removed too rather than left to win.
 */
export function withRunAccountEnv(cwd: string | undefined, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const account = runAccountEnvFor(cwd);
    if (account === null) return base;
    const env: NodeJS.ProcessEnv = { ...base };
    for (const [key, value] of Object.entries(account)) {
        for (const existing of Object.keys(env)) {
            if (existing === key || (process.platform === "win32" && existing.toUpperCase() === key.toUpperCase())) {
                delete env[existing];
            }
        }
        if (value !== null) env[key] = value;
    }
    return env;
}
