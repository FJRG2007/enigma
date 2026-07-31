/**
 * Background update notifier. Mirrors the npm `update-notifier` / Prisma pattern:
 * the running command never waits on the network. A detached child process
 * refreshes a small on-disk cache (~/.enigma-update-check.json) out of band, and
 * the NEXT invocation reads that cache synchronously to decide whether to print an
 * ASCII "update available" card. Every step is wrapped so a slow, failed, or
 * offline registry can neither block, slow down, nor break the actual command.
 */

import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import { isNewer, readJson } from "./util";
import { readConfig } from "./config";
import { refreshSkillsFromGitHub } from "./skills";

const REGISTRY_URL = "https://registry.npmjs.org/enigma-cli/latest";
const UPDATE_COMMAND = "npm i -g enigma-cli@latest";
const CACHE_FILE = join(homedir(), ".enigma-update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // re-check the registry at most once a day
const STALE_RECHECK_MS = 10 * 60 * 1000; // faster cadence while the cache lags the running version

interface UpdateCache {
    latest: string | null;
    checkedAt: number;
}

/**
 * Inline script for the detached child on the DEV path only (node/tsx, where
 * process.execPath is node and `-e` works): fetch the latest version and write it
 * to the cache. Self-aborts after 5s and swallows every error so it can never
 * hang or surface output. Values arrive via env vars (not string interpolation)
 * to keep the registry response out of the executed code. The packaged binary
 * cannot run this (a Bun-compiled executable has no `-e`); it re-invokes itself
 * with the hidden `__update-check` command instead (see performUpdateCheck).
 */
const CHILD_SCRIPT = [
    "const fs = require('fs');",
    "const ctrl = new AbortController();",
    "const t = setTimeout(() => ctrl.abort(), 5000);",
    "fetch(process.env.E_URL, { signal: ctrl.signal, headers: { 'user-agent': 'enigma-cli-update-check' } })",
    "  .then((r) => (r.ok ? r.json() : null))",
    "  .then((d) => { if (d && d.version) fs.writeFileSync(process.env.E_FILE, JSON.stringify({ latest: d.version, checkedAt: Date.now() })); })",
    "  .catch(() => {})",
    "  .finally(() => clearTimeout(t));",
].join("\n");

/**
 * Entrypoint of the hidden `enigma __update-check` command: the compiled binary's
 * detached child runs this to fetch the latest version and refresh the cache
 * (mirrors CHILD_SCRIPT). Bounded by the same 5s abort; errors leave the attempt
 * stamp in place, retried on the stale cadence.
 */
export async function performUpdateCheck(): Promise<void> {
    try {
        await fetchAndCacheLatest();
    } catch {
        // Offline/blocked registry: keep the stamp, the stale cadence retries.
    }
    // Same detached child also refreshes the GitHub skill cache, so auto-sync on
    // the next launch deploys new skills without any explicit install/update.
    // Bounded by its own fetch timeouts and silent by contract.
    try { await refreshSkillsFromGitHub(); } catch { /* best-effort */ }
}

/** Fetch the latest published version (5s bound) and write it to the cache. */
async function fetchAndCacheLatest(): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
        const res = await fetch(REGISTRY_URL, { signal: ctrl.signal, headers: { "user-agent": "enigma-cli-update-check" } });
        const data = res.ok ? (await res.json()) as { version?: string; } : null;
        if (data?.version) writeFileSync(CACHE_FILE, JSON.stringify({ latest: data.version, checkedAt: Date.now() }));
    } finally {
        clearTimeout(t);
    }
}

/**
 * Foreground registry check for `enigma update`: refresh the cache now and
 * return the newer published version, or null when current is already the
 * latest or the registry is unreachable.
 */
export async function checkLatestNow(current: string): Promise<string | null> {
    try {
        await fetchAndCacheLatest();
        const latest = readCache()?.latest;
        return latest && isNewer(latest, current) ? latest : null;
    } catch {
        return null;
    }
}

/** Wrap text in an ANSI color, but only on a real terminal that allows color. */
function paint(text: string, code: string): string {
    return process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Build the ASCII update card (Prisma-style), padded to the widest line. */
function renderUpdateBox(current: string, latest: string): string {
    const lines = [
        { text: `Update available  ${current} -> ${latest}`, color: "1;33" },
        { text: `Run ${UPDATE_COMMAND} to update`, color: "36" },
    ];
    const width = Math.max(...lines.map((l) => l.text.length));
    const border = `+${"-".repeat(width + 4)}+`;
    const blank = `|${" ".repeat(width + 4)}|`;
    const rows = lines.map((l) => `|${paint(`  ${l.text}${" ".repeat(width - l.text.length)}  `, l.color)}|`);
    return [border, blank, ...rows, blank, border].join("\n");
}

/** Read the cached registry result, or null if missing/corrupt. */
function readCache(): UpdateCache | null {
    return readJson<UpdateCache>(CACHE_FILE);
}

/**
 * Kick off a detached, fire-and-forget registry check if the cache is stale.
 * Stamps the cache with the attempt time up front so repeated commands (or an
 * unreachable registry) don't spawn a checker on every run. A cache with no
 * `latest` (a previous check failed) or whose `latest` is already older than the
 * running version (the user updated past it, or a release just shipped) is stale
 * by definition, so it re-checks on a much shorter cadence - but not on every
 * run, or a dev build running ahead of npm would hit the registry per command.
 *
 * The child process depends on the runtime: the compiled Bun binary cannot run
 * `node -e` scripts (its execPath is the binary itself, which parses `-e` as a
 * CLI flag), so it re-invokes itself with the hidden `__update-check` command;
 * Bun running the source entry re-runs that entry with the same command; dev
 * runs under node/tsx keep the classic update-notifier `-e` child.
 */
function scheduleUpdateCheck(current: string): void {
    try {
        const cache = readCache();
        const cacheStale = !cache?.latest || isNewer(current, cache.latest);
        const interval = cacheStale ? STALE_RECHECK_MS : CHECK_INTERVAL_MS;
        if (cache && Date.now() - cache.checkedAt < interval) return;
        writeFileSync(CACHE_FILE, JSON.stringify({ latest: cache?.latest ?? null, checkedAt: Date.now() }));
        const exe = basename(process.execPath).toLowerCase();
        const spawnOpts = { detached: true, stdio: "ignore", windowsHide: true } as const;
        let child;
        if (exe === "node" || exe === "node.exe") {
            // Dev under node/tsx: the classic update-notifier `node -e` child.
            child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
                ...spawnOpts,
                env: { ...process.env, E_URL: REGISTRY_URL, E_FILE: CACHE_FILE },
            });
        } else if (exe === "bun" || exe === "bun.exe") {
            // Bun running the source entry (npm run dev): re-run it with the command.
            child = spawn(process.execPath, [process.argv[1]!, "__update-check"], spawnOpts);
        } else {
            // Compiled binary (any asset name): every arg goes straight to the
            // embedded CLI, so it re-invokes itself with the hidden command.
            child = spawn(process.execPath, ["__update-check"], spawnOpts);
        }
        child.unref();
    } catch {
        // Best-effort only: a failed schedule must never affect the command.
    }
}

/**
 * Windows-only pre-update step: updating from INSIDE enigma means the running
 * `enigma-bin.exe` is this very process, and Windows refuses to unlink a running
 * executable - npm then spams "npm warn cleanup EPERM" and leaves an orphaned
 * `.enigma-cli-*` staging dir behind. A running exe CAN be renamed/moved though,
 * so park it in a temp dir first: npm's cleanup finds nothing locked, the fresh
 * install ships its own binary (postinstall or lazy download), and parked copies
 * plus stale staging dirs are swept on the next update. Entirely best-effort -
 * any failure just leaves npm's warning as before.
 */
function parkRunningBinary(): void {
    if (process.platform !== "win32") return;
    const exe = process.execPath;
    // Strict guard: only ever move our own compiled binary, never node/bun (the
    // dev/tsx path runs under node.exe and must stay untouched).
    if (!basename(exe).toLowerCase().startsWith("enigma-bin")) return;
    try {
        const park = join(tmpdir(), "enigma-old-binaries");
        mkdirSync(park, { recursive: true });
        // Sweep previously parked binaries (skip any still running/locked) and
        // stale npm staging dirs from updates made before this fix existed.
        for (const f of readdirSync(park)) {
            try { rmSync(join(park, f), { force: true }); } catch { /* still locked */ }
        }
        const modulesDir = dirname(dirname(dirname(exe))); // bin -> enigma-cli -> node_modules
        for (const entry of readdirSync(modulesDir)) {
            if (!entry.startsWith(".enigma-cli-")) continue;
            try { rmSync(join(modulesDir, entry), { recursive: true, force: true }); } catch { /* still locked */ }
        }
        renameSync(exe, join(park, `enigma-bin-${process.pid}-${Date.now()}.exe`));
    } catch {
        // Parking is an optimization; the update itself proceeds either way.
    }
}

/**
 * Run the global update in place, reporting the outcome without ever throwing.
 * Clears the npm cache first so a stale cached tarball is never reused, then
 * installs the latest. OS-agnostic: npm is resolved through the shell on Windows
 * (where it is npm.cmd) and spawned directly elsewhere.
 *
 * Returns whether the install succeeded, so the caller can run the NEW version's
 * asset sync in the same command instead of leaving it to the next run.
 */
export function runUpdate(): boolean {
    const onWindows = process.platform === "win32";
    try {
        parkRunningBinary();
        // Best-effort cache clean; ignore its exit status so a clean-only failure
        // does not block the install.
        spawnSync("npm", ["cache", "clean", "--force"], { stdio: "inherit", shell: onWindows });
        const result = spawnSync("npm", ["i", "-g", "enigma-cli@latest"], { stdio: "inherit", shell: onWindows });
        if (result.status === 0) {
            // Drop the cached check so the freshly installed version re-reads the
            // registry on its next run instead of trusting a pre-update snapshot.
            try { rmSync(CACHE_FILE, { force: true }); } catch { /* best-effort */ }
            console.log("Updated to the latest enigma-cli.");
            return true;
        }
        console.log(`Update did not complete. Run '${UPDATE_COMMAND}' manually.`);
    } catch {
        console.log(`Could not run the update. Run '${UPDATE_COMMAND}' manually.`);
    }
    return false;
}

/**
 * Non-prompting update check for the hub: returns the current/latest pair when a
 * newer release is cached, else null. Schedules a background refresh for next time,
 * and stays silent for non-TTY/CI or when the notifier is disabled.
 */
export function getAvailableUpdate(current: string): { current: string; latest: string; } | null {
    try {
        if (!process.stdout.isTTY || process.env.CI) return null;
        if (!readConfig().config.updateNotifier) return null;
        scheduleUpdateCheck(current);
        const cache = readCache();
        const latest = cache?.latest ? String(cache.latest).replace(/[^\w.+-]/g, "") : "";
        if (!latest || !isNewer(latest, current)) return null;
        return { current, latest };
    } catch {
        return null;
    }
}

/**
 * Surface an update notice after a command finishes. Displays the cached result
 * (instant, no network), schedules a background refresh for next time, and - only
 * on an interactive terminal - offers to update now. Silent for non-TTY/CI output
 * so it never pollutes machine-readable results, and fully error-isolated.
 */
export async function notifyUpdate(current: string, interactive: boolean): Promise<void> {
    if (!process.stdout.isTTY || process.env.CI) return;
    try {
        if (!readConfig().config.updateNotifier) return;
        scheduleUpdateCheck(current);
        const cache = readCache();
        const latest = cache?.latest ? String(cache.latest).replace(/[^\w.+-]/g, "") : "";
        if (!latest || !isNewer(latest, current)) return;
        process.stdout.write(`\n${renderUpdateBox(current, latest)}\n`);
        if (!interactive) return;
        const ok = await p.confirm({ message: `Update now with ${UPDATE_COMMAND}?`, initialValue: true });
        if (p.isCancel(ok) || !ok) return;
        runUpdate();
    } catch {
        // An update notice is purely informational; never let it break the command.
    }
}
