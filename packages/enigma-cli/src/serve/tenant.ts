/**
 * Tenant isolation for `enigma serve`.
 *
 * Every request names a tenant, and everything it reads or writes lives under that tenant's own
 * directory: `<data-dir>/tenants/<id>/{recall,codegraph,ccr}`. The stores already resolve their
 * root from an environment override at call time (ENIGMA_RECALL_DIR, ENIGMA_CODEGRAPH_DIR,
 * ENIGMA_CCR_DIR), so a request runs with those three pointed at its tenant.
 *
 * Swapping process environment is only safe because every handler is SYNCHRONOUS: the swap, the
 * work and the restore happen inside one turn of the event loop, so no other request can observe
 * the overrides. `withTenant` refuses a callback that returns a promise to keep that true.
 */

import { join, resolve, sep } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";

/**
 * Lowercase only, so two ids can never collide on a case-insensitive filesystem (Windows, macOS):
 * "Acme" and "acme" would otherwise share one directory and read each other's memory. A host with
 * mixed-case ids lowercases or hashes them itself; the server refuses rather than folding.
 */
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Device names Windows reserves in every directory; a tenant dir named one cannot be created. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Why a tenant id was refused, or null when it is valid. */
export function tenantIdError(id: string | undefined): string | null {
    if (!id) return "missing tenant id (send the X-Enigma-Tenant header)";
    if (!TENANT_RE.test(id)) return "invalid tenant id: 1-64 characters of a-z, 0-9, '_' or '-', starting with a letter or digit";
    if (WINDOWS_RESERVED.test(id)) return "invalid tenant id: reserved device name";
    return null;
}

/** The tenant's data directory under `dataDir` (created on first use). */
export function tenantDir(dataDir: string, id: string): string {
    const dir = join(resolve(dataDir), "tenants", id);
    mkdirSync(dir, { recursive: true });
    return dir;
}

const OVERRIDES = ["ENIGMA_RECALL_DIR", "ENIGMA_CODEGRAPH_DIR", "ENIGMA_CCR_DIR"] as const;

/**
 * Run `fn` with every store rooted in the tenant's directory, then restore the environment
 * exactly as it was. Synchronous by contract (see the module comment).
 */
export function withTenant<T>(dir: string, fn: () => T): T {
    const saved = OVERRIDES.map((k) => [k, process.env[k]] as const);
    process.env.ENIGMA_RECALL_DIR = join(dir, "recall");
    process.env.ENIGMA_CODEGRAPH_DIR = join(dir, "codegraph");
    process.env.ENIGMA_CCR_DIR = join(dir, "ccr");
    try {
        const out = fn();
        if (out && typeof (out as { then?: unknown; }).then === "function") throw new Error("withTenant: handlers must be synchronous");
        return out;
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/**
 * Resolve a code root a tenant asked to index, confined to that tenant's workspace
 * (`<workspace-root>/<tenant>`). Symlinks are resolved before the containment check, so a link
 * inside the workspace cannot point the indexer at the rest of the disk. Returns null when the
 * path escapes the workspace or does not exist.
 */
export function confineRoot(workspaceRoot: string, tenant: string, relative: string): string | null {
    let base: string;
    let target: string;
    try {
        base = realpathSync(join(resolve(workspaceRoot), tenant));
        target = realpathSync(resolve(base, relative));
    } catch {
        return null;
    }
    return target === base || target.startsWith(base + sep) ? target : null;
}
