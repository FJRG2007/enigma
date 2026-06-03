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
import { readJson } from "./util";
import { readConfig } from "./config";

const REGISTRY_URL = "https://registry.npmjs.org/enigma-cli/latest";
const UPDATE_COMMAND = "npm i -g enigma-cli@latest";
const CACHE_FILE = join(homedir(), ".enigma-update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // re-check the registry at most once a day

interface UpdateCache {
    latest: string | null;
    checkedAt: number;
}

/**
 * Inline script run by a detached child: fetch the latest version and write it to
 * the cache. Self-aborts after 5s and swallows every error so it can never hang
 * or surface output. Values arrive via env vars (not string interpolation) to
 * keep the registry response out of the executed code.
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

/** Split a version into [major, minor, patch], dropping a leading "v" and any prerelease tag. */
function parseVersion(version: string): [number, number, number] {
    const core = String(version).trim().replace(/^v/, "").split("-")[0]!;
    const [major, minor, patch] = core.split(".").map((n) => parseInt(n, 10) || 0);
    return [major || 0, minor || 0, patch || 0];
}

/** True when `latest` is a strictly higher release than `current`. */
function isNewer(latest: string, current: string): boolean {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    for (let i = 0; i < 3; i++) {
        if (a[i]! > b[i]!) return true;
        if (a[i]! < b[i]!) return false;
    }
    return false;
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
 * unreachable registry) don't spawn a checker on every run.
 */
function scheduleUpdateCheck(): void {
    try {
        const cache = readCache();
        if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return;
        writeFileSync(CACHE_FILE, JSON.stringify({ latest: cache?.latest ?? null, checkedAt: Date.now() }));
        const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env, E_URL: REGISTRY_URL, E_FILE: CACHE_FILE },
        });
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
 */
export function runUpdate(): void {
    const onWindows = process.platform === "win32";
    try {
        parkRunningBinary();
        // Best-effort cache clean; ignore its exit status so a clean-only failure
        // does not block the install.
        spawnSync("npm", ["cache", "clean", "--force"], { stdio: "inherit", shell: onWindows });
        const result = spawnSync("npm", ["i", "-g", "enigma-cli@latest"], { stdio: "inherit", shell: onWindows });
        if (result.status === 0) console.log("Updated. Re-run enigma to use the new version.");
        else console.log(`Update did not complete. Run '${UPDATE_COMMAND}' manually.`);
    } catch {
        console.log(`Could not run the update. Run '${UPDATE_COMMAND}' manually.`);
    }
}

/**
 * Non-prompting update check for the hub: returns the current/latest pair when a
 * newer release is cached, else null. Schedules a background refresh for next time,
 * and stays silent for non-TTY/CI or when the notifier is disabled.
 */
export function getAvailableUpdate(current: string): { current: string; latest: string } | null {
    try {
        if (!process.stdout.isTTY || process.env.CI) return null;
        if (!readConfig().config.updateNotifier) return null;
        scheduleUpdateCheck();
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
        scheduleUpdateCheck();
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
