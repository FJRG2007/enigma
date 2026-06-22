/**
 * Local savings dashboard: a dependency-free (node:http) server that visualizes the
 * cumulative + over-time token savings recorded by the compression engine
 * (~/.enigma/ccr/stats.json + history.jsonl). It is opt-in and, by default, on-demand:
 * `enigma dashboard` serves it only while the command runs, so it costs nothing when
 * idle. The "always" mode keeps a lightweight detached daemon alive instead.
 *
 * Reachability mirrors what headroom does NOT do: instead of localhost:PORT we map the
 * bare hostname `enigma` to loopback via the OS hosts file and bind :80 when free, so
 * the user types `http://enigma`. If :80 is taken (or hosts is unwritable) it degrades
 * to http://enigma:24282 / http://localhost:24282 - never a conflict.
 *
 * Idle cost is controlled the headroom way: the browser pauses polling while the tab is
 * hidden (the HTML asset) and the server serves a short-TTL cached stats snapshot.
 *
 * The chart is rendered by a charting library vendored as a static asset under
 * assets/dashboard/lib and served from this loopback server - never a CDN at runtime and
 * not an npm runtime dependency, so the zero-dependency posture holds. (Apache-2.0; its
 * license notice is retained inside the asset, and the attribution logo is suppressed.)
 */

import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readStats, readHistory, ccrCacheStats } from "./compress";
import { readConfig } from "./config";
import { resolveBin } from "./util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const ASSETS = process.env.ENIGMA_ASSETS_DIR ?? join(PKG_ROOT, "assets");
const HTML_PATH = join(ASSETS, "dashboard", "index.html");
/** Vendored charting library (standalone build), served locally - not bundled. */
const LIB_FILE = "chart.min.js";
const LIB_PATH = join(ASSETS, "dashboard", "lib", LIB_FILE);

/** Loopback only: the dashboard exposes local savings data and is never network-facing. */
const HOST = "127.0.0.1";
/** Bare hostname mapped to loopback in the hosts file so `http://enigma` resolves. */
const HOSTNAME = "enigma";
/** Try :80 first (pretty URL, no port), then a high fallback, then an ephemeral port. */
const PORTS: readonly number[] = [80, 24282];
const HOSTS_MARKER = "# enigma-dashboard (managed by enigma; remove to disable http://enigma)";

// --- hosts file -----------------------------------------------------------------

function hostsFilePath(): string {
    return process.platform === "win32"
        ? join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
        : "/etc/hosts";
}

/** True if any line already maps loopback to the `enigma` hostname. */
function parseHostsHasEnigma(content: string): boolean {
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const tokens = trimmed.split(/\s+/);
        if ((tokens[0] === "127.0.0.1" || tokens[0] === "::1") && tokens.slice(1).includes(HOSTNAME)) return true;
    }
    return false;
}

/** Whether `http://enigma` currently resolves (a hosts entry exists). Best-effort. */
export function hasHostsEntry(): boolean {
    try { return parseHostsHasEnigma(readFileSync(hostsFilePath(), "utf8")); } catch { return false; }
}

export interface HostsResult { ok: boolean; alreadyPresent: boolean; needsAdmin: boolean; path: string; }

/**
 * Idempotently map `enigma` -> 127.0.0.1 in the hosts file. Writing it needs admin
 * (Windows) / root (Unix); on a permission error we report needsAdmin so the caller can
 * print the one manual line instead of failing. Never throws.
 */
export function ensureHostsEntry(): HostsResult {
    const path = hostsFilePath();
    let content = "";
    try { content = readFileSync(path, "utf8"); } catch { /* fall through: try to create/append */ }
    if (content && parseHostsHasEnigma(content)) return { ok: true, alreadyPresent: true, needsAdmin: false, path };
    const prefix = content && !content.endsWith("\n") ? "\n" : "";
    try {
        writeFileSync(path, `${content}${prefix}${HOSTS_MARKER}\n127.0.0.1 ${HOSTNAME}\n`);
        return { ok: true, alreadyPresent: false, needsAdmin: false, path };
    } catch (err) {
        const needsAdmin = ["EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code || "");
        return { ok: false, alreadyPresent: false, needsAdmin, path };
    }
}

/** The URL a user should open for a server bound to `port`, given hosts availability. */
export function dashboardUrl(port: number): string {
    const host = hasHostsEntry() ? HOSTNAME : "localhost";
    return port === 80 ? `http://${host}` : `http://${host}:${port}`;
}

// --- server ---------------------------------------------------------------------

let htmlCache: string | null = null;

function dashboardHtml(): string {
    if (htmlCache !== null) return htmlCache;
    try { htmlCache = readFileSync(HTML_PATH, "utf8"); } catch { htmlCache = FALLBACK_HTML; }
    return htmlCache;
}

let libCache: string | null = null;

/** The vendored chart library JS, or null if the asset is missing (cards still render). */
function dashboardLib(): string | null {
    if (libCache !== null) return libCache || null;
    try { libCache = readFileSync(LIB_PATH, "utf8"); } catch { libCache = ""; }
    return libCache || null;
}

const FALLBACK_HTML = "<!doctype html><meta charset=utf-8><title>Enigma</title><body style=\"font-family:sans-serif;background:#0b0e14;color:#e6e6e6;padding:2rem\"><h1>Enigma dashboard</h1><p>Dashboard asset not found. Fetch live numbers at <a style=color:#d7875f href=\"/api/stats\">/api/stats</a>.</p>";

let snapshot: { payload: string; expires: number } | null = null;
const SNAPSHOT_TTL_MS = 1000;

/** JSON stats payload, served from a short-TTL cache so polling never rebuilds it twice. */
function statsPayload(version: string): string {
    const now = Date.now();
    if (snapshot && now < snapshot.expires) return snapshot.payload;
    const payload = JSON.stringify({ version, generatedAt: now, priceOverride: readConfig().config.tokenPrice, stats: readStats(), history: readHistory(), cache: ccrCacheStats() });
    snapshot = { payload, expires: now + SNAPSHOT_TTL_MS };
    return payload;
}

function createDashboardServer(version: string): Server {
    return createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        if (url === "/" || url === "/index.html") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(dashboardHtml());
            return;
        }
        if (url === "/lib/" + LIB_FILE) {
            const js = dashboardLib();
            if (js === null) { res.writeHead(404).end(); return; }
            res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "max-age=86400" });
            res.end(js);
            return;
        }
        if (url === "/api/stats") {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(statsPayload(version));
            return;
        }
        if (url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", version }));
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
    });
}

function tryListen(server: Server, port: number): Promise<void> {
    return new Promise((res, rej) => {
        const onErr = (e: Error): void => { server.removeListener("listening", onOk); rej(e); };
        const onOk = (): void => { server.removeListener("error", onErr); res(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, HOST);
    });
}

/** Bind the first available port (80 -> 24282 -> ephemeral). Returns the bound port. */
async function listenWithFallback(server: Server): Promise<number> {
    for (const port of [...PORTS, 0]) {
        try { await tryListen(server, port); return (server.address() as { port: number }).port; }
        catch { /* port busy or privileged: try the next */ }
    }
    throw new Error("could not bind any port for the dashboard");
}

export interface RunningServer { url: string; port: number; close: () => void; }

/** Start the HTTP server and resolve once it is listening. Caller owns its lifecycle. */
export async function startDashboardServer(version: string): Promise<RunningServer> {
    const server = createDashboardServer(version);
    const port = await listenWithFallback(server);
    return { url: dashboardUrl(port), port, close: () => server.close() };
}

// --- daemon (always mode) -------------------------------------------------------

export interface DaemonRecord { pid: number; port: number; url: string; startedAt: number; }

function daemonFile(): string {
    return join(homedir(), ".enigma", "dashboard.json");
}

function readDaemon(): DaemonRecord | null {
    try { return JSON.parse(readFileSync(daemonFile(), "utf8")) as DaemonRecord; } catch { return null; }
}

function writeDaemon(rec: DaemonRecord): void {
    const dir = dirname(daemonFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(daemonFile(), JSON.stringify(rec, null, 2) + "\n");
}

function clearDaemon(): void {
    try { unlinkSync(daemonFile()); } catch { /* already gone */ }
}

/** Signal-0 liveness probe: EPERM means the pid exists but is not ours (still alive). */
function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The running daemon record, or null if none is alive (stale pidfile is cleaned up). */
export function runningDaemon(): DaemonRecord | null {
    const rec = readDaemon();
    if (!rec) return null;
    if (isProcessAlive(rec.pid)) return rec;
    clearDaemon();
    return null;
}

/**
 * Spawn the dashboard as a detached background process via the hidden
 * `__dashboard-serve` command. Mirrors update.ts's runtime branching: the compiled
 * binary re-invokes itself, Bun-on-source re-runs the entry, node/tsx re-runs argv[1].
 * The child writes the pidfile once it is listening, so we never depend on the spawn pid.
 */
export function spawnDashboardDaemon(): void {
    const existing = runningDaemon();
    if (existing) return;
    try {
        const exe = basename(process.execPath).toLowerCase();
        const opts = { detached: true, stdio: "ignore", windowsHide: true } as const;
        const args = (exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe")
            ? [process.argv[1]!, "__dashboard-serve"]
            : ["__dashboard-serve"];
        spawn(process.execPath, args, opts).unref();
    } catch { /* best-effort: a failed spawn must never break the calling command */ }
}

/** Stop the background daemon if one is running. Best-effort. */
export function stopDashboardDaemon(): void {
    const rec = runningDaemon();
    if (!rec) { clearDaemon(); return; }
    try { process.kill(rec.pid); } catch { /* already gone */ }
    clearDaemon();
}

/**
 * Run the server forever for the detached daemon: bind a port, publish the pidfile, and
 * keep the process alive. Silent by contract (stdout/stderr are ignored by the parent).
 * Invoked by the hidden `enigma __dashboard-serve` command.
 */
export async function serveDashboardDaemon(version: string): Promise<void> {
    // A second daemon would just fight for the port; defer to the live one.
    if (runningDaemon()) return;
    let server: RunningServer;
    try { server = await startDashboardServer(version); } catch { return; }
    writeDaemon({ pid: process.pid, port: server.port, url: server.url, startedAt: Date.now() });
    const shutdown = (): void => { clearDaemon(); server.close(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

// --- mode side effects ----------------------------------------------------------

export interface DashboardApplyResult { hosts: HostsResult | null; daemon: "started" | "stopped" | "none"; }

/**
 * Apply the side effects of a dashboard mode change. Idempotent and best-effort:
 * - off:       stop any daemon (the hosts entry is harmless and left in place).
 * - on-demand: ensure the hosts entry; stop a daemon left over from "always".
 * - always:    ensure the hosts entry; start the background daemon.
 */
export function applyDashboardMode(mode: "off" | "on-demand" | "always"): DashboardApplyResult {
    if (mode === "off") { stopDashboardDaemon(); return { hosts: null, daemon: "stopped" }; }
    const hosts = ensureHostsEntry();
    if (mode === "always") { spawnDashboardDaemon(); return { hosts, daemon: "started" }; }
    stopDashboardDaemon();
    return { hosts, daemon: "stopped" };
}
