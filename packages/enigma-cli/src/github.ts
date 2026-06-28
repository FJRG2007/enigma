/**
 * GitHub CLI (gh) specific configuration. Disables gh's usage telemetry by
 * default at install time: a privacy win with zero functional cost (telemetry is
 * pure usage analytics - no gh feature depends on it), and it also sidesteps a
 * known Windows bug where the detached `gh send-telemetry` subprocess spawns
 * `tzutil.exe` without window suppression, flashing a terminal window on every
 * gh invocation (https://github.com/cli/cli/issues/13354).
 *
 * Reads/writes go through `gh config` itself rather than parsing gh's YAML, so
 * enigma stays agnostic to gh's config location (~/.config/gh vs %AppData%) and
 * key validation. gh's config is user-global only - there is no per-repo form.
 *
 * Reading via a child process is slow (~hundreds of ms on Windows), far too slow
 * for a TUI that re-reads settings on every render. The display path therefore
 * uses stale-while-revalidate: `getGhTelemetryCached` answers instantly from an
 * in-process memo backed by ~/.enigma/cache.json, while one async revalidation
 * per process fetches the real value and notifies subscribers (the TUI
 * re-renders) if it differs. Only the very first read ever - no cache file yet -
 * pays a synchronous probe. Writes go through gh synchronously (explicit user
 * action) and write back to the cache, so it never goes stale via enigma itself.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { isDir, readJson, resolveBin } from "./util";

/** Last-known gh state: enabled/disabled, or null when gh is not installed. */
export type GhTelemetry = boolean | null;

const CACHE_FILE = join(homedir(), ".enigma", "cache.json");
interface EnigmaCache { ghTelemetry?: GhTelemetry; ghTelemetryCheckedAt?: number; }

let memo: GhTelemetry | "unknown" = "unknown";
let revalidated = false;
const listeners = new Set<() => void>();

function ghBin(): string | null {
    return process.env.ENIGMA_GH_BIN || resolveBin("gh");
}

/** Run `gh config <args>` and return trimmed stdout, or null when gh is unusable. */
function ghConfig(args: string[]): string | null {
    const bin = ghBin();
    if (!bin) return null;
    try {
        const r = spawnSync(bin, ["config", ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
        if (r.status !== 0) return null;
        return (r.stdout || "").trim();
    } catch {
        return null;
    }
}

/** Is the GitHub CLI installed (resolvable on PATH)? */
export function hasGhCli(): boolean {
    return Boolean(ghBin());
}

/**
 * Whether gh telemetry is currently enabled, asking gh synchronously (slow but
 * authoritative). gh's default is enabled, so an unset/unreadable value reads as
 * true. Returns null when gh is not installed.
 */
export function getGhTelemetry(): GhTelemetry {
    if (!hasGhCli()) return null;
    const value = ghConfig(["get", "telemetry"]);
    return value !== "disabled";
}

/** Update the memo + persistent cache, notifying subscribers when the value changed. */
function remember(value: GhTelemetry): void {
    const changed = memo !== "unknown" && memo !== value;
    memo = value;
    try {
        const cache = readJson<EnigmaCache>(CACHE_FILE) || {};
        cache.ghTelemetry = value;
        cache.ghTelemetryCheckedAt = Date.now();
        const dir = join(CACHE_FILE, "..");
        if (!isDir(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
    } catch { /* cache is best-effort; the memo still serves this process */ }
    if (changed) for (const cb of listeners) cb();
}

/**
 * Revalidate the cached value once per process, off the render path: ask gh in a
 * non-blocking child and notify subscribers if reality differs from the cache
 * (e.g. the user toggled telemetry outside enigma).
 */
function revalidate(): void {
    if (revalidated) return;
    revalidated = true;
    const bin = ghBin();
    if (!bin) { remember(null); return; }
    try {
        const child = spawn(bin, ["config", "get", "telemetry"], { windowsHide: true });
        let out = "";
        child.stdout?.on("data", (d) => { out += String(d); });
        child.on("error", () => { /* keep the cached value */ });
        child.on("close", (code) => { if (code === 0) remember(out.trim() !== "disabled"); });
    } catch { /* keep the cached value */ }
}

/**
 * Instant, render-safe read: in-process memo, then the JSON cache, and only on
 * the first read ever (no cache yet) a synchronous probe. Always schedules the
 * once-per-process async revalidation.
 */
export function getGhTelemetryCached(): GhTelemetry {
    if (memo === "unknown") {
        const cache = readJson<EnigmaCache>(CACHE_FILE);
        if (cache && cache.ghTelemetry !== undefined) memo = cache.ghTelemetry;
        else { memo = getGhTelemetry(); remember(memo); }
    }
    revalidate();
    return memo;
}

/**
 * Subscribe to cache corrections (revalidation or a write found a different
 * value). Returns an unsubscribe function. Used by the TUI to re-render the row
 * once the real value lands without ever blocking the initial paint.
 */
export function onGhTelemetryChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** Repo to star via the user's authenticated gh, when available. */
const STAR_REPO = "FJRG2007/enigma";

/**
 * Best-effort, fully silent "star the repo" gesture. When the GitHub CLI is
 * installed AND authenticated, fire `gh api -X PUT user/starred/<repo>` in the
 * background. The call is idempotent (re-running on an already-starred repo is a
 * 204 no-op), so it is safe to invoke on every install and update. It never
 * blocks, never prints, and never throws: a missing/old/logged-out gh, a network
 * failure, or any spawn error is swallowed. Opt out with ENIGMA_NO_STAR=1.
 */
export function starRepoInBackground(): void {
    if (process.env.ENIGMA_NO_STAR) return;
    const bin = ghBin();
    if (!bin) return;
    try {
        // Detect an authenticated session first (exit 0 = logged in); skip otherwise.
        const auth = spawn(bin, ["auth", "status"], { windowsHide: true, stdio: "ignore" });
        auth.on("error", () => { /* gh unusable; give up silently */ });
        auth.on("close", (code) => {
            if (code !== 0) return;
            try {
                const star = spawn(bin, ["api", "-X", "PUT", `user/starred/${STAR_REPO}`], {
                    windowsHide: true, stdio: "ignore", detached: true,
                });
                star.on("error", () => { /* swallow */ });
                star.unref();
            } catch { /* swallow */ }
        });
    } catch { /* swallow */ }
}

/**
 * Enable or disable gh telemetry. Returns whether the value actually changed;
 * null when gh is not installed or too old to know the `telemetry` key (the
 * set command fails on unknown keys - treated as "nothing to do"). Successful
 * writes update the cache, keeping cached reads truthful.
 */
export function setGhTelemetry(enabled: boolean): boolean | null {
    const current = getGhTelemetry();
    if (current === null) return null;
    if (current === enabled) { remember(current); return false; }
    const result = ghConfig(["set", "telemetry", enabled ? "enabled" : "disabled"]);
    if (result === null) return null;
    remember(enabled);
    return true;
}
