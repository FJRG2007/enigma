/**
 * Update availability for the dashboard: which installed enigma packages have a newer
 * version published on npm. The dashboard polls /api/stats every ~15s and reads the cached
 * result from here, while npm itself is queried at most once every POLL_INTERVAL_MS - so the
 * alert feels real-time without hammering the registry. The "Update now" button spawns a
 * detached `enigma update`, the same full self-update the CLI runs.
 *
 * Covers every enigma package the user actually has: the running CLI plus the on-demand
 * @enigmax/dashboard and @enigmax/linter bundles when installed. Fully fault-tolerant: an
 * offline/blocked registry leaves the cache stamped so it throttles like a success, and a
 * failed check never blocks a stats poll or throws.
 *
 * Node-builtins + util + the package-version readers only (no heavy agent imports), so it
 * stays cheap to load on the stats hot path and free of import cycles.
 */

import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { isNewer, readJson } from "./util";
import { installedLinterVersion } from "./lint";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { installedDashboardVersion } from "./dashboard-pkg";

export interface PkgUpdate { name: string; label: string; installed: string; latest: string | null; hasUpdate: boolean; }
export interface UpdateStatus { checkedAt: number; packages: PkgUpdate[]; available: boolean; }

const STATUS_FILE = join(homedir(), ".enigma", "update-status.json");
const POLL_INTERVAL_MS = 30 * 60 * 1000; // re-query npm at most every 30 min
const FETCH_TIMEOUT_MS = 6000;
/** npm registry base; overridable so tests point at a fake local server (never the real npm). */
const REGISTRY = (process.env.ENIGMA_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");

let refreshing = false;

/** The enigma packages currently installed, with their active versions. */
function installedPackages(cliVersion: string): { name: string; label: string; installed: string }[] {
    const list = [{ name: "enigma-cli", label: "Enigma CLI", installed: cliVersion }];
    const dash = installedDashboardVersion();
    if (dash) list.push({ name: "@enigmax/dashboard", label: "Dashboard UI", installed: dash });
    const lint = installedLinterVersion();
    if (lint) list.push({ name: "@enigmax/linter", label: "Linter", installed: lint });
    return list;
}

/** Latest published version of a package, or null on any failure (bounded by a timeout). */
async function npmLatest(name: string): Promise<string | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${REGISTRY}/${name}/latest`, { signal: ctrl.signal, headers: { "user-agent": "enigma-cli-update-check" } });
        const data = res.ok ? (await res.json()) as { version?: string } : null;
        return data?.version ?? null;
    } catch { return null; }
    finally { clearTimeout(t); }
}

/** Query npm for every installed package and persist the result. Never rejects. */
export async function refreshUpdateStatus(cliVersion: string): Promise<void> {
    const pkgs = installedPackages(cliVersion);
    const packages = await Promise.all(pkgs.map(async (p) => {
        const latest = await npmLatest(p.name);
        return { ...p, latest, hasUpdate: !!latest && isNewer(latest, p.installed) };
    }));
    const status: UpdateStatus = { checkedAt: Date.now(), packages, available: packages.some((p) => p.hasUpdate) };
    try {
        mkdirSync(dirname(STATUS_FILE), { recursive: true });
        writeFileSync(STATUS_FILE, JSON.stringify(status));
    } catch { /* a disk failure just leaves the previous cache in place */ }
}

/**
 * Stats-hot-path read: return the cached update status instantly and, when it is stale,
 * kick off a single background npm refresh (the next poll then sees the fresh result). One
 * refresh at a time per process; the registry is hit at most once every POLL_INTERVAL_MS.
 */
export function readUpdateStatusCached(cliVersion: string): UpdateStatus | null {
    const cached = readJson<UpdateStatus>(STATUS_FILE);
    // Escape hatch so tests (and anyone who wants it off) never trigger a registry call.
    if (process.env.ENIGMA_NO_UPDATE_CHECK) return cached;
    const stale = !cached || Date.now() - cached.checkedAt > POLL_INTERVAL_MS;
    if (stale && !refreshing) {
        refreshing = true;
        refreshUpdateStatus(cliVersion).catch(() => { /* best-effort */ }).finally(() => { refreshing = false; });
    }
    return cached;
}

/**
 * Spawn a detached `enigma update` - the full self-update (npm reinstalls enigma-cli@latest
 * and refreshes the dashboard/linter bundles). Mirrors the runtime dispatch used by the other
 * detached children: the compiled binary takes the command directly, node/bun on source need
 * argv[1] first. Best-effort; a failed spawn never throws.
 */
export function spawnEnigmaUpdate(): boolean {
    try {
        const exe = basename(process.execPath).toLowerCase();
        const dev = exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe";
        const args = dev ? [process.argv[1]!, "update"] : ["update"];
        spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
        return true;
    } catch { return false; }
}
