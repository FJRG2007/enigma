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
 * The UI bundle (page + vendored charting library) is NOT shipped in the base enigma-cli
 * package: it lives in @enigmax/dashboard, installed on demand into ~/.enigma/dashboard the
 * first time the dashboard is enabled or opened (see dashboard-pkg.ts). This server resolves
 * and serves those files; until the install lands it serves a minimal built-in fallback page.
 * So a user who never opens the dashboard never downloads its ~196 KB of assets. The chart
 * library is served from this loopback server, never a CDN, so the zero-runtime-dependency
 * posture holds. (Apache-2.0; its license notice is retained inside the asset, logo hidden.)
 */

import * as conf from "./config";
import { isIPv6 } from "node:net";
import { resolveBin } from "./util";
import { fileURLToPath } from "node:url";
import { readUsageCached } from "./usage";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { createServer, type Server } from "node:http";
import { homedir, hostname, networkInterfaces } from "node:os";
import { readStats, readHistory, ccrCacheStats } from "./compress";
import { bearerOf, readDashboardToken, tokenMatches } from "./dashboard-token";
import { readUpdateStatusCached, spawnEnigmaUpdate } from "./dashboard-updates";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dashboardAssetsDir, installedDashboardVersion, spawnDashboardPkgInstall } from "./dashboard-pkg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The enigma-cli version sitting on disk right now. `enigma update` replaces the package
 * under the running process, so `ENIGMA_VERSION` - stamped into the env by the launcher
 * that started THIS process - is the version we booted with, not the installed one. The
 * launcher also points `ENIGMA_ASSETS_DIR` at `<pkgRoot>/assets`, so the package manifest
 * beside it answers the question honestly. Falls back to the env value (dev, or an
 * unreadable manifest), which is correct whenever no update has happened underneath us.
 */
function installedCliVersion(): string {
    const assets = process.env.ENIGMA_ASSETS_DIR;
    if (assets) {
        try {
            const pkg = JSON.parse(readFileSync(join(dirname(assets), "package.json"), "utf8")) as { version?: unknown; };
            if (typeof pkg.version === "string" && pkg.version) return pkg.version;
        } catch { /* fall through to the env value */ }
    }
    return process.env.ENIGMA_VERSION || "";
}

/** The vendored charting library file name, served locally - never a CDN. */
const LIB_FILE = "chart.min.js";

/** Absolute path to an installed UI asset, or null when the on-demand package is absent. */
function assetPath(...parts: string[]): string | null {
    const dir = dashboardAssetsDir();
    return dir ? join(dir, ...parts) : null;
}

/** Loopback: the default bind, reachable only from this machine and needing no token. */
const LOOPBACK = "127.0.0.1";
/** Bare hostname mapped to loopback in the hosts file so `http://enigma` resolves. */
const HOSTNAME = "enigma";
/** Try :80 first (pretty URL, no port), then a high fallback, then an ephemeral port. */
const PORTS: readonly number[] = [80, 24282];
/** What `/health` calls itself, so a liveness probe can tell this server from any other. */
const HEALTH_SERVICE = "enigma-dashboard";
const HOSTS_MARKER = "# enigma-dashboard (managed by enigma; remove to disable http://enigma)";

// --- hosts file -----------------------------------------------------------------

function hostsFilePath(): string {
    if (process.env.ENIGMA_HOSTS_FILE) return process.env.ENIGMA_HOSTS_FILE;
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

/**
 * Idempotently REMOVE the `enigma` -> loopback mapping (and our marker) from the hosts
 * file, so turning the dashboard off leaves no trace (matters on a server). Drops a line
 * that maps only `enigma`; if the line maps other names too, only `enigma` is stripped.
 * Needs admin/root like the write; reports needsAdmin on a permission error. Never throws.
 */
export function removeHostsEntry(): HostsResult {
    const path = hostsFilePath();
    let content: string;
    try { content = readFileSync(path, "utf8"); } catch { return { ok: true, alreadyPresent: false, needsAdmin: false, path }; }
    if (!parseHostsHasEnigma(content)) return { ok: true, alreadyPresent: false, needsAdmin: false, path };
    const kept: string[] = [];
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === HOSTS_MARKER) continue;
        const tokens = trimmed.split(/\s+/);
        if (!trimmed.startsWith("#") && (tokens[0] === "127.0.0.1" || tokens[0] === "::1") && tokens.slice(1).includes(HOSTNAME)) {
            const rest = tokens.slice(1).filter((t) => t !== HOSTNAME);
            if (rest.length) kept.push(`${tokens[0]} ${rest.join(" ")}`);
            continue;
        }
        kept.push(line);
    }
    try {
        writeFileSync(path, kept.join("\n"));
        return { ok: true, alreadyPresent: true, needsAdmin: false, path };
    } catch (err) {
        const needsAdmin = ["EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code || "");
        return { ok: false, alreadyPresent: true, needsAdmin, path };
    }
}

/**
 * This machine's first non-internal IPv4, or null when it has none.
 *
 * An exposed dashboard is reached from another machine, and `os.hostname()` is usually the
 * wrong answer there: a cloud VM calls itself something like `ip-172-31-4-9` that resolves
 * nowhere outside its own VPC, so the printed link (the only way in) would be dead. An address
 * at least works from anything that can route to it. IPv4 only: an IPv6 pick would need a
 * scope/reachability judgement we cannot make from here.
 */
function lanAddress(): string | null {
    for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === "IPv4" && !a.internal) return a.address;
        }
    }
    return null;
}

/** Wrap an IPv6 literal in brackets; URLs require it, and a bare one parses as host:port garbage. */
function urlHost(host: string): string {
    return isIPv6(host) ? `[${host}]` : host;
}

/**
 * The URL a user should open for a server bound to `port`, given hosts availability.
 * An exposed bind is reached from ANOTHER machine, where the `enigma` hosts alias (and
 * `localhost`) would point the visitor back at themselves - so it reports a routable address:
 * the pinned one for a custom bind, else this host's own LAN address.
 */
export function dashboardUrl(port: number, bind?: BindResolution): string {
    const host = bind && bind.mode !== "loopback"
        ? urlHost(bind.mode === "custom" ? bind.host : (lanAddress() || hostname()))
        : (hasHostsEntry() ? HOSTNAME : "localhost");
    return port === 80 ? `http://${host}` : `http://${host}:${port}`;
}

// --- server ---------------------------------------------------------------------

/**
 * A read-through cache keyed by the asset file's (mtime, size). This is what lets a running
 * dashboard pick up an EXTERNAL update: `enigma update` (a different process) reinstalls the
 * @enigmax/dashboard bundle on disk, changing the files' mtime/size; the next request here
 * sees the new key and re-reads, instead of serving the page cached at server start forever.
 * `fallback` is returned (and not cached) until the asset exists.
 */
function readAssetCached(cache: { text: string; key: string; } | null, path: string | null, fallback: string): { value: string; cache: { text: string; key: string; } | null; } {
    if (path) {
        try {
            const st = statSync(path);
            const key = `${st.mtimeMs}:${st.size}`;
            if (cache && cache.key === key) return { value: cache.text, cache };
            const text = readFileSync(path, "utf8");
            return { value: text, cache: { text, key } };
        } catch { /* not installed yet: fall through to the fallback */ }
    }
    return { value: fallback, cache };
}

let htmlCache: { text: string; key: string; } | null = null;

/**
 * The dashboard page from the on-demand @enigmax/dashboard package. Re-read whenever the file
 * changes on disk (e.g. after `enigma update` swaps the bundle), so a long-running server or
 * daemon serves the current UI rather than the one cached when it booted.
 */
function dashboardHtml(): string {
    const r = readAssetCached(htmlCache, assetPath("index.html"), FALLBACK_HTML);
    htmlCache = r.cache;
    return r.value;
}

let libCache: { text: string; key: string; } | null = null;

/** The vendored chart library JS, or null if the asset is missing (cards still render). */
function dashboardLib(): string | null {
    const path = assetPath("lib", LIB_FILE);
    if (!path) return null;
    const r = readAssetCached(libCache, path, "");
    libCache = r.cache;
    // An empty value means the read failed and no cache exists yet -> treat as missing.
    return r.cache ? r.cache.text : null;
}

const FALLBACK_HTML = "<!doctype html><meta charset=utf-8><title>Enigma</title><meta http-equiv=refresh content=5><body style=\"font-family:sans-serif;background:#0b0e14;color:#e6e6e6;padding:2rem\"><h1>Enigma dashboard</h1><p>Fetching the dashboard UI (<code>@enigmax/dashboard</code>) - this page refreshes automatically. If it persists, run <code>enigma dashboard</code> once with network access. Live numbers are available now at <a style=color:#d7875f href=\"/api/stats\">/api/stats</a>.</p>";

let snapshot: { payload: string; expires: number; } | null = null;
const SNAPSHOT_TTL_MS = 1000;

// Identifies this server process. The page reloads when it sees this change, so a tab left
// open from a previous `enigma dashboard` self-heals after a restart/UI update.
const SERVER_BOOT = Date.now();

/** JSON stats payload, served from a short-TTL cache so polling never rebuilds it twice. */
function statsPayload(version: string): string {
    const now = Date.now();
    if (snapshot && now < snapshot.expires) return snapshot.payload;
    const cfg = conf.readConfig().config;
    // `version` is what THIS process booted with. `enigma update` replaces the package under
    // a long-lived daemon, so reporting it leaves "Enigma CLI x -> y" on screen for good: the
    // update lands on disk, the daemon keeps comparing npm's latest against its own stale
    // number, and only a dashboard restart clears the alert. Re-read from disk (the same
    // reason serveUpdate and the daemon respawn already do) so the banner clears itself on
    // the next poll. Falls back to the boot value when the manifest is unreadable.
    const live = installedCliVersion() || version;
    const payload = JSON.stringify({
        version: live, generatedAt: now, boot: SERVER_BOOT,
        // Version of the served UI bundle (@enigmax/dashboard). The page reloads when this
        // changes, so a background update to a newer bundle swaps the UI without a restart.
        ui: installedDashboardVersion(),
        // Which installed enigma packages (CLI, dashboard, linter) have a newer npm release.
        // Read from a 30-min-throttled cache so polling never hits the registry; drives the
        // top-of-page "update available" alert.
        updates: readUpdateStatusCached(live),
        priceOverride: cfg.tokenPrice, speedOverride: cfg.tokenSpeed,
        stats: readStats(), history: readHistory(), cache: ccrCacheStats(),
        usage: cfg.usageStats ? readUsageCached() : null,
    });
    snapshot = { payload, expires: now + SNAPSHOT_TTL_MS };
    return payload;
}

/** Hostnames a same-machine request may legitimately use when the server binds loopback. */
const LOCAL_HOSTS = new Set(["enigma", "localhost", "127.0.0.1", "::1"]);

/**
 * Strip scheme/port/path from a Host or Origin header, leaving the bare hostname.
 *
 * IPv6 is why this is not a one-liner. Such a host arrives bracketed (`[::1]:24282`), and
 * splitting it on ":" chops it at the first group: `[::1]` collapsed to "" (so a loopback
 * dashboard refused its own IPv6 client) and `[2a01:db8::1]` collapsed to "2a01" (so two
 * unrelated addresses sharing a prefix compared equal, weakening the Origin/Host check).
 * Take the bracketed literal whole, and only strip a port off a plain host.
 */
function hostOnly(h: string | undefined): string {
    const bare = (h || "").trim().replace(/^https?:\/\//, "").split("/")[0];
    const v6 = /^\[([^\]]+)\]/.exec(bare);
    if (v6) return v6[1]!.toLowerCase();
    return bare.split(":")[0].toLowerCase();
}

/**
 * The loopback layer of isAuthorized: accept only same-machine requests and reject any
 * cross-origin caller. The server is already loopback-bound (unreachable from the network),
 * and this also blocks DNS-rebinding / CSRF from a malicious web page on the same machine.
 */
function isLocalRequest(req: import("node:http").IncomingMessage): boolean {
    if (!LOCAL_HOSTS.has(hostOnly(req.headers.host))) return false;
    const origin = req.headers.origin;
    if (origin && !LOCAL_HOSTS.has(hostOnly(origin))) return false;
    return true;
}

// --- bind + authentication ------------------------------------------------------

export interface BindResolution {
    mode: conf.DashboardBind;
    /** Interface to listen on. */
    host: string;
    /** Shared secret every /api/* request must present, or null when loopback (none needed). */
    token: string | null;
}

/**
 * Which interface to bind and which token to require, resolved once per server.
 *
 * Throws when an exposed bind has no token. That refusal is the point: the dashboard is an
 * admin surface (it runs agents with your credentials, kills processes, rewrites config), so
 * it is never bound to a reachable interface unauthenticated - failing to start is strictly
 * better than serving something an operator would reasonably assume was safe.
 *
 * The bind is read from the GLOBAL config only. A repo's .enigma.json is committable and
 * travels with a clone, so honouring it here would let cloned repo content decide that this
 * machine opens a port - which is also the invariant dashboard-config-io.ts keeps by refusing
 * to carry these keys in an exported bundle.
 */
export function resolveBind(override?: conf.DashboardBind): BindResolution {
    const cfg = conf.readGlobalConfig();
    const configured = conf.DASHBOARD_BINDS.includes(cfg.dashboardBind) ? cfg.dashboardBind : "loopback";
    // `override` is the "just this once" path: it binds for this run without persisting.
    const mode = override || configured;
    if (mode === "loopback") return { mode, host: LOOPBACK, token: null };
    const host = mode === "lan" ? "0.0.0.0" : (cfg.dashboardBindAddress || "").trim();
    if (!host) throw new Error("dashboardBind is \"custom\" but dashboardBindAddress is empty: set it with `enigma config dashboard-bind-address <ip>`");
    const token = readDashboardToken();
    if (!token) throw new Error(`refusing to bind ${host} without a token (the dashboard can run agents, kill processes and rewrite config): run \`enigma dashboard --expose\`, or set one with \`enigma dashboard token --new\``);
    return { mode, host, token };
}

/**
 * Whether a repo-local .enigma.json is trying to set the bind, so a caller can say it was
 * ignored. Silently dropping a setting the user wrote is worse than refusing it out loud.
 */
export function repoBindOverrideIgnored(): boolean {
    const local = conf.readProjectConfig(process.cwd());
    return local.dashboardBind !== undefined || local.dashboardBindAddress !== undefined;
}

/** The bind this process resolved at listen time; every request is authorized against it. */
let activeBind: BindResolution = { mode: "loopback", host: LOOPBACK, token: null };

/**
 * Whether a request may touch the API surface. The two layers move with the bind:
 * - loopback: unreachable from the network, so the same-machine Host/Origin check is the
 *   whole defense (it blocks DNS-rebinding and CSRF from a page on this machine).
 * - exposed: the token authenticates. Host may legitimately be any address or DNS name that
 *   points at this box, so pinning an allowlist would just break real setups; instead a
 *   browser's Origin must match the Host it called, which keeps the CSRF/rebinding layer.
 *
 * The token is re-read per request rather than taken from `activeBind`. Rotation is the
 * documented answer to a leaked link, so it has to bite a server that is already running:
 * caching it here made `dashboard token --new` print "every link handed out earlier is now
 * dead" while the live process happily kept honouring the old one. A deleted token file now
 * closes the surface for the same reason.
 */
function isAuthorized(req: import("node:http").IncomingMessage): boolean {
    if (activeBind.mode === "loopback") return isLocalRequest(req);
    const token = readDashboardToken();
    if (!token) return false;
    const origin = req.headers.origin;
    if (origin && hostOnly(origin) !== hostOnly(req.headers.host)) return false;
    return tokenMatches(token, bearerOf(req.headers.authorization));
}

const JSON_HDR = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } as const;

/** Serve the current value of every configurable setting (mirrors the TUI registry). */
function serveSettings(res: import("node:http").ServerResponse): void {
    // `dashboardPort` is the configured preference (0 = auto); `runningPort` is what the
    // live server actually bound, so the UI can show "currently on :N" - both sit outside
    // the boolean/choice registry (numeric), like token-price/token-speed and the plan limits.
    import("./dashboard-settings")
        .then(({ serializeSettings }) => {
            const payload = { categories: serializeSettings("global"), dashboardPort: conf.readConfig().config.dashboardPort, runningPort: boundPort };
            res.writeHead(200, JSON_HDR); res.end(JSON.stringify(payload));
        })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"settings unavailable"}'); });
}

/** Persist the preferred dashboard port (0 = auto, else 1-65535). Needs a restart to rebind. */
function writeDashboardPort(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: { value?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        const n = Number(parsed.value);
        if (!Number.isInteger(n) || n < 0 || n > 65535) { res.writeHead(400, JSON_HDR); res.end('{"error":"port must be 0 (auto) or 1-65535"}'); return; }
        conf.setEnigmaValue("dashboardPort", n, "global");
        const restartNote = n === boundPort || (n === 0 && [80, 24282].includes(boundPort))
            ? "" : "Restart the dashboard (enigma dashboard) to bind the new port.";
        res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ ok: true, dashboardPort: n, runningPort: boundPort, restartNote }));
    });
}

/** Apply a single setting write from a POST body { key, value }. Bounded body, global scope. */
function writeSetting(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
        let parsed: { key?: unknown; value?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.key !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing key"}'); return; }
        import("./dashboard-settings")
            .then(({ applySetting }) => applySetting(parsed.key as string, parsed.value, "global"))
            .then((out) => { snapshot = null; res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"write failed"}'); });
    });
}

/**
 * Check for and apply updates that are safe to do in-process: refresh skills from GitHub,
 * re-sync deployments, and refresh the dashboard UI bundle. The enigma-cli binary itself is
 * NOT updated here (npm cannot replace a running binary on Windows) - the response reports
 * the running version so the UI can point the user at `enigma update` for a CLI bump.
 */
function serveUpdate(res: import("node:http").ServerResponse): void {
    Promise.all([import("./skills"), import("./dashboard-pkg"), import("./lint")])
        .then(async ([skills, pkg, lint]) => {
            const { updated, synced } = await skills.checkAndUpdateSkills();
            const uiChanged = pkg.refreshDashboardPkg();
            // Keep the on-demand linter bundle current too (no-op when it is not installed).
            if (lint.isLinterInstalled()) lint.refreshLinterPkg();
            // Only drop the asset cache when the bundle actually changed, so an unchanged
            // run does not force a needless page reload.
            if (uiChanged) { htmlCache = null; libCache = null; }
            const parts: string[] = [];
            if (updated.length) parts.push(`skills updated: ${updated.join(", ")}`);
            else if (synced.length) parts.push(`skills re-synced: ${synced.join(", ")}`);
            if (uiChanged) parts.push("dashboard UI updated");
            const changed = parts.length > 0;
            const note = (changed ? parts.join("; ") : "Already up to date") + ". For a CLI update run `enigma update` in a terminal.";
            res.writeHead(200, JSON_HDR);
            res.end(JSON.stringify({ ok: true, changed, version: installedCliVersion(), note }));
        })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"ok":false,"error":"update failed"}'); });
}

/**
 * Run the full self-update behind the scenes: spawn a detached `enigma update` (reinstalls
 * enigma-cli@latest and refreshes the dashboard/linter bundles). Returns immediately - the
 * version alert clears on its own as the next polls see the new versions. The running server
 * keeps its old version until the dashboard is restarted, so the note says so.
 */
function serveRunUpdate(res: import("node:http").ServerResponse): void {
    const started = spawnEnigmaUpdate();
    // An always-on daemon restarts itself on the new binary at the end of the update (see
    // restartDashboardDaemon), so the page reloads on its own; a foreground dashboard needs a
    // manual reopen. Tailor the note so the user knows which to expect.
    const note = runningDaemon()
        ? "Updating in the background (about a minute). The dashboard will reload itself on the new version when it's ready."
        : "Updating in the background (about a minute). Reopen the dashboard (enigma dashboard) once it finishes to load the new CLI version.";
    res.writeHead(started ? 200 : 500, JSON_HDR);
    res.end(JSON.stringify(started ? { ok: true, note } : { ok: false, error: "could not start the update" }));
}

/**
 * Detect and repair tool launch paths from a POST body { tool? }. With no tool it
 * fixes every supported tool, persisting any discovered off-PATH binary to the
 * global config so `enigma <tool>` works. Returns { ok, lines, tools } so the
 * dashboard can refresh its status panel without a second request.
 */
function serveFixPath(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
        let parsed: { tool?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        const tool = typeof parsed.tool === "string" && parsed.tool ? parsed.tool : null;
        Promise.all([import("./tool-path"), import("./accounts")])
            .then(([tp, acc]) => {
                const targets = tool ? [tool] : acc.TOOL_NAMES;
                let ok = true;
                // Structured per-tool outcomes so the dashboard can render clean rows
                // (status dot + badge + path) instead of one cramped line of text.
                const results = targets.map((t) => {
                    if (!acc.isToolName(t)) { ok = false; return { tool: t, label: t, command: t, ok: false, changed: false, installed: false, path: null, message: `Unknown tool '${t}'.` }; }
                    const r = tp.ensureLaunchable(t, "global");
                    if (!r.ok) ok = false;
                    return { tool: r.tool, label: r.label, command: r.command, ok: r.ok, changed: r.changed, installed: r.installed, path: r.path, message: r.message };
                });
                const lines = results.map((r) => r.message);
                res.writeHead(200, JSON_HDR);
                res.end(JSON.stringify({ ok, results, lines, tools: tp.toolPathStatuses().map((t) => ({ name: t.name, label: t.label, status: t.status })) }));
            })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"ok":false,"error":"fix-path failed"}'); });
    });
}

/** System resources snapshot (processes, ports, WSL/Docker state) for the Resources tab. */
function serveResources(res: import("node:http").ServerResponse): void {
    import("./resources")
        .then(({ resourceStatus }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify(resourceStatus())); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"resources unavailable"}'); });
}

/** Run a DESTRUCTIVE resource action from a POST body { op, value? } (kill/free-port/wsl/docker). */
function writeResources(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
        let parsed: { op?: unknown; value?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.op !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing op"}'); return; }
        const value = typeof parsed.value === "number" ? parsed.value : undefined;
        import("./resources")
            .then(({ runResourceAction, resourceStatus }) => {
                const out = runResourceAction(parsed.op as string, value);
                res.writeHead(out.ok ? 200 : 400, JSON_HDR);
                res.end(JSON.stringify({ ...out, status: resourceStatus() }));
            })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"ok":false,"error":"action failed"}'); });
    });
}

// Provider statuspages (Atlassian Statuspage shape). Proxied SERVER-SIDE because the browser's
// cross-origin fetch is unreliable in the field (privacy/tracker blockers, corporate MITM proxies
// and captive portals can return a stub 200, which surfaced as a bogus "Status unknown" pill);
// the loopback server reaches the endpoint cleanly. opencode has no public statuspage.
const PROVIDER_STATUS_URLS: Record<string, string> = {
    claude: "https://status.claude.com/api/v2/status.json",
    codex: "https://status.openai.com/api/v2/status.json",
};

/** Same-origin proxy for a provider's statuspage: returns { indicator, description } or { error }. */
async function serveProviderStatus(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    res.writeHead(200, JSON_HDR);
    const provider = new URL(req.url || "/", "http://x").searchParams.get("provider") || "claude";
    const target = PROVIDER_STATUS_URLS[provider];
    if (!target) { res.end('{"error":"unsupported"}'); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const r = await fetch(target, { signal: ctrl.signal, headers: { "User-Agent": "enigma-dashboard", Accept: "application/json" } });
        const d = (await r.json()) as { status?: { indicator?: string; description?: string; }; };
        res.end(JSON.stringify({ indicator: d?.status?.indicator || "unknown", description: d?.status?.description || "Status unknown" }));
    } catch {
        res.end('{"error":"unreachable"}');
    } finally {
        clearTimeout(timer);
    }
}

/** Serialize the recall session-memory view (status + recent/searched observations). */
function serveRecall(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const u = new URL(req.url || "/", "http://x").searchParams;
    const timeline = u.get("timeline");
    import("./dashboard-recall")
        .then((m) => {
            if (timeline) { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ items: m.recallTimelineView(Number(timeline)) })); return; }
            const view = m.recallDashboard({ q: u.get("q") || undefined, project: u.get("project") || undefined, type: u.get("type") || undefined });
            res.writeHead(200, JSON_HDR); res.end(JSON.stringify(view));
        })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"recall unavailable"}'); });
}

/** Apply a recall action from a POST body { op, ... } (sync | clear | set-provider | delete | create | generate). */
function writeRecall(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 16384) req.destroy(); });
    req.on("end", () => {
        let parsed: {
            op?: unknown; provider?: unknown; model?: unknown; base?: unknown; key?: unknown; llm?: unknown;
            id?: unknown; ids?: unknown; type?: unknown; title?: unknown; project?: unknown; narrative?: unknown; facts?: unknown; concepts?: unknown; prompt?: unknown;
        };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.op !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing op"}'); return; }
        const strList = (v: unknown): string[] | undefined => Array.isArray(v) ? v.map(String) : undefined;
        const idList = (v: unknown): number[] | undefined => Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : undefined;
        const payload = {
            provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
            model: typeof parsed.model === "string" ? parsed.model : undefined,
            base: typeof parsed.base === "string" ? parsed.base : undefined,
            key: typeof parsed.key === "string" ? parsed.key : undefined,
            llm: typeof parsed.llm === "boolean" ? parsed.llm : undefined,
            id: typeof parsed.id === "number" ? parsed.id : undefined,
            // Bulk delete: the multi-select posts ids[], and dropping it here reads downstream
            // as no id at all ("missing memory id").
            ids: idList(parsed.ids),
            type: typeof parsed.type === "string" ? parsed.type : undefined,
            title: typeof parsed.title === "string" ? parsed.title : undefined,
            project: typeof parsed.project === "string" ? parsed.project : undefined,
            narrative: typeof parsed.narrative === "string" ? parsed.narrative : undefined,
            facts: strList(parsed.facts),
            concepts: strList(parsed.concepts),
            prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
        };
        import("./dashboard-recall")
            .then(({ applyRecallAction }) => applyRecallAction(parsed.op as string, payload))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"ok":false,"error":"action failed"}'); });
    });
}

/** Codebase-memory (code graph) view: enabled/available state, projects, selected detail. */
function serveCodeGraph(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const u = new URL(req.url || "/", "http://x").searchParams;
    import("./dashboard-codegraph")
        .then((m) => {
            const view = m.codeGraphDashboard({ project: u.get("project") || undefined });
            res.writeHead(200, JSON_HDR); res.end(JSON.stringify(view));
        })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"code-graph unavailable"}'); });
}

/** Apply a code-graph action from a POST body { op, on?, project? } (toggle | refresh). */
function writeCodeGraph(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
        let parsed: { op?: unknown; on?: unknown; project?: unknown; root?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.op !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing op"}'); return; }
        const payload = {
            on: typeof parsed.on === "boolean" ? parsed.on : undefined,
            project: typeof parsed.project === "string" ? parsed.project : undefined,
            root: typeof parsed.root === "string" ? parsed.root : undefined,
        };
        import("./dashboard-codegraph")
            .then(({ applyCodeGraphAction }) => applyCodeGraphAction(parsed.op as string, payload))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"ok":false,"error":"action failed"}'); });
    });
}

/** Serve the playground info (installed agents + their models + the default API port). */
function servePlayground(res: import("node:http").ServerResponse): void {
    import("./dashboard-playground")
        .then((m) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify(m.playgroundInfo())); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"playground unavailable"}'); });
}

/**
 * Playground POST: either persist the default API context ({ op: "set-defaults", account?,
 * profile?, pack? }) or run a request (drives a real agent in-process, or forwards to a loopback
 * server). Both are origin-guarded at the route.
 */
function runPlaygroundRoute(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
    req.on("end", () => {
        let parsed: import("./dashboard-playground").PlaygroundRequest & { op?: string; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        void (async () => {
            try {
                const m = await import("./dashboard-playground");
                const out = parsed.op === "set-defaults"
                    ? m.setApiDefaults({ account: parsed.account, profile: parsed.profile, pack: parsed.pack })
                    : await m.runPlayground(parsed);
                res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out));
            } catch (err) {
                res.writeHead(500, JSON_HDR); res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
            }
        })();
    });
}

/** Factual "what's active" overview (configured state of each enigma system + skill counts). */
function serveStatus(res: import("node:http").ServerResponse): void {
    import("./dashboard-status")
        .then(({ systemsStatus }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ systems: systemsStatus() })); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"status unavailable"}'); });
}

/** List the user's skills (enigma's own + external) for the Skills subpage. */
function serveSkills(res: import("node:http").ServerResponse): void {
    import("./dashboard-skills")
        .then(({ listSkillsForDashboard }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ skills: listSkillsForDashboard() })); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"skills unavailable"}'); });
}

/** Apply a skill action from a POST body { name, action, content? } (read/save/enable/disable/remove/check-updates). */
function writeSkill(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    // Larger cap than other writes: the "save" action carries a full SKILL.md document.
    req.on("data", (chunk) => { body += chunk; if (body.length > 512 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: { name?: unknown; action?: unknown; content?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.action !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing action"}'); return; }
        import("./dashboard-skills")
            .then(({ applySkillAction }) => applySkillAction(typeof parsed.name === "string" ? parsed.name : "", parsed.action as string, parsed.content))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"action failed"}'); });
    });
}

/** List the saved SSH connections and standalone tunnels (with live status) for the SSH subpage. */
function serveSsh(res: import("node:http").ServerResponse): void {
    import("./dashboard-ssh")
        .then(({ listSshData }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify(listSshData())); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"ssh unavailable"}'); });
}

/** Apply an SSH action from a POST body { action, alias, ... } (add/edit/remove/forward/connect/tunnel). */
function writeSsh(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: { action?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.action !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing action"}'); return; }
        import("./dashboard-ssh")
            .then(({ applySshAction }) => applySshAction(parsed.action as string, parsed as Record<string, never>))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"action failed"}'); });
    });
}

/** List the marketplace packs for the Packs subpage. */
function servePacks(res: import("node:http").ServerResponse): void {
    import("./dashboard-packs")
        .then(({ listPacksForDashboard }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ packs: listPacksForDashboard() })); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"packs unavailable"}'); });
}

/** Apply a pack action from a POST body { id, action, value? } (install/remove/update/setup/set-account/launch). */
function writePack(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 8 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: { id?: unknown; action?: unknown; value?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.action !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing action"}'); return; }
        import("./dashboard-packs")
            .then(({ applyPackAction }) => applyPackAction(typeof parsed.id === "string" ? parsed.id : "", parsed.action as string, typeof parsed.value === "string" ? parsed.value : undefined))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"action failed"}'); });
    });
}

/** List the agent memory files for the editor (global, or per project via ?path=). */
function serveMemory(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const project = new URL(req.url || "/", "http://x").searchParams.get("path") || undefined;
    const send = (): void => {
        import("./dashboard-memory")
            .then(({ listMemoryForDashboard }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ groups: listMemoryForDashboard(project), project: project || null })); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"memory unavailable"}'); });
    };
    if (project) { ensureRegisteredProject(project, res, send); return; }
    send();
}

/** Gate view: the pipeline's YAML config, the daemon's state, and the recorded runs. */
function serveGate(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const project = new URL(req.url || "/", "http://x").searchParams.get("path") || undefined;
    const send = (): void => {
        import("./dashboard-gate")
            .then(({ gateOverview }) => gateOverview(project || null))
            .then((out) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"gate unavailable"}'); });
    };
    if (project) { ensureRegisteredProject(project, res, send); return; }
    send();
}

/**
 * Gate write endpoint. Without an `action` the body is a raw config save
 * ({ scope, text, path? }); `action` selects a structured edit instead:
 * "setting" writes one field of the global config, "daemon" starts or stops it.
 */
function writeGate(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 128 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: { scope?: unknown; text?: unknown; path?: unknown; action?: unknown; key?: unknown; value?: unknown; on?: unknown; run?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }

        if (parsed.action === "setting" || parsed.action === "daemon" || parsed.action === "abort") {
            const act = parsed.action === "daemon"
                ? (m: typeof import("./dashboard-gate")) => m.setGateDaemon(parsed.on === true)
                : parsed.action === "abort"
                    ? (m: typeof import("./dashboard-gate")) => m.abortGateRun(String(parsed.run ?? ""))
                    : (m: typeof import("./dashboard-gate")) => m.applyGateSetting(String(parsed.key ?? ""), parsed.value);
            import("./dashboard-gate")
                .then(act)
                .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
                .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"action failed"}'); });
            return;
        }

        const scope = parsed.scope === "repo" ? "repo" : "global";
        const project = typeof parsed.path === "string" && parsed.path ? parsed.path : undefined;
        const run = (): void => {
            import("./dashboard-gate")
                .then(({ saveGateConfig }) => saveGateConfig(scope, typeof parsed.text === "string" ? parsed.text : "", project || null))
                .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
                .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"save failed"}'); });
        };
        // A repo config is written inside a project folder, so it takes the same guard as memory.
        if (scope === "repo") {
            if (!project) { res.writeHead(400, JSON_HDR); res.end('{"error":"missing project"}'); return; }
            ensureRegisteredProject(project, res, run);
            return;
        }
        run();
    });
}

/** Apply a memory action from a POST body { id, action, content?, path? } (read/save/reset). */
function writeMemoryAction(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    // Larger cap: the "save" action carries a full CLAUDE.md/AGENTS.md document.
    req.on("data", (chunk) => { body += chunk; if (body.length > 512 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: { id?: unknown; action?: unknown; content?: unknown; path?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.action !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing action"}'); return; }
        const project = typeof parsed.path === "string" && parsed.path ? parsed.path : undefined;
        const run = (): void => {
            import("./dashboard-memory")
                .then(({ applyMemoryAction }) => applyMemoryAction(typeof parsed.id === "string" ? parsed.id : "", parsed.action as string, parsed.content, project))
                .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
                .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"action failed"}'); });
        };
        if (project) { ensureRegisteredProject(project, res, run); return; }
        run();
    });
}

/** Guard a project-scoped memory call: a write only ever targets a registered project folder. */
function ensureRegisteredProject(path: string, res: import("node:http").ServerResponse, ok: () => void): void {
    import("./dashboard-projects")
        .then(({ isRegisteredProject }) => {
            if (!isRegisteredProject(path)) { res.writeHead(404, JSON_HDR); res.end('{"error":"project not registered"}'); return; }
            ok();
        })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"memory unavailable"}'); });
}

/** List tool accounts + profiles for the Accounts panel. */
function serveAccounts(res: import("node:http").ServerResponse): void {
    import("./dashboard-accounts")
        .then(({ serializeAccounts }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify(serializeAccounts())); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"accounts unavailable"}'); });
}

/** Apply one account/profile mutation from a POST body { op, ...payload }. */
function writeAccount(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: { op?: unknown; } & Record<string, unknown>;
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.op !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing op"}'); return; }
        import("./dashboard-accounts")
            .then(({ applyAccountAction }) => applyAccountAction(parsed.op as string, parsed as import("./dashboard-accounts").AccountActionPayload))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"account action failed"}'); });
    });
}

/** Build and return the secret-free config bundle for download. */
function serveConfigExport(res: import("node:http").ServerResponse): void {
    import("./dashboard-config-io")
        .then(({ exportBundle }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify(exportBundle(), null, 2)); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"export unavailable"}'); });
}

/** Apply an uploaded config bundle from the POST body (the whole JSON file). */
function writeConfigImport(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: unknown;
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        import("./dashboard-config-io")
            .then(({ importBundle }) => importBundle(parsed))
            .then((out) => { snapshot = null; res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"import failed"}'); });
    });
}

/** Plan window keys settable from the dashboard cards -> their .enigma.json fields. */
const PLAN_FIELDS = { session: "planSessionLimit", weekly: "planWeeklyLimit", weeklyOpus: "planWeeklyOpusLimit", weeklySonnet: "planWeeklySonnetLimit", weeklyReset: "planWeeklyReset" } as const;

/** Set one plan limit / the weekly-reset anchor from a POST body { key, value }. */
function writePlan(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
        let parsed: { key?: unknown; value?: unknown; };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        const field = typeof parsed.key === "string" ? PLAN_FIELDS[parsed.key as keyof typeof PLAN_FIELDS] : undefined;
        if (!field) { res.writeHead(400, JSON_HDR); res.end('{"error":"unknown plan key"}'); return; }
        if (field === "planWeeklyReset") {
            conf.setEnigmaValue("planWeeklyReset", String(parsed.value || "mon 00:00"), "global");
        } else {
            const n = Number(parsed.value);
            if (!Number.isFinite(n) || n < 0) { res.writeHead(400, JSON_HDR); res.end('{"error":"bad number"}'); return; }
            conf.setEnigmaValue(field, n, "global");
        }
        snapshot = null; // force the next /api/stats to recompute the windows with the new limit
        res.writeHead(200, JSON_HDR); res.end('{"ok":true}');
    });
}

function serveProjects(res: import("node:http").ServerResponse): void {
    import("./dashboard-projects")
        .then(({ listProjects }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ projects: listProjects() })); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"projects unavailable"}'); });
}

function writeProjects(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 8 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.op !== "string" || typeof parsed.path !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing op/path"}'); return; }
        const str = (v: unknown) => typeof v === "string" ? v : undefined;
        import("./dashboard-projects").then((m) => {
            if (parsed.op === "add") {
                const out = m.addProject(parsed.path as string, str(parsed.name), str(parsed.description));
                res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); return;
            }
            if (parsed.op === "validate") { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ ok: true, ...m.checkProject(parsed.path as string, str(parsed.name) || "") })); return; }
            if (parsed.op === "update") {
                const out = m.updateProject(parsed.path as string, str(parsed.name), str(parsed.description));
                res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); return;
            }
            if (parsed.op === "remove") { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ ok: true, ...m.removeProject(parsed.path as string) })); return; }
            res.writeHead(400, JSON_HDR); res.end('{"error":"unknown op"}');
        }).catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"projects action failed"}'); });
    });
}

function serveProjectDetail(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const path = new URL(req.url || "/", "http://x").searchParams.get("path") || "";
    if (!path) { res.writeHead(400, JSON_HDR); res.end('{"error":"missing path"}'); return; }
    import("./dashboard-projects")
        .then(({ projectDetail }) => { const d = projectDetail(path); res.writeHead("error" in d ? 404 : 200, JSON_HDR); res.end(JSON.stringify(d)); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"detail unavailable"}'); });
}

function writeProjectAction(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
    req.on("end", () => {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.path !== "string" || typeof parsed.op !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing path/op"}'); return; }
        import("./dashboard-projects")
            .then(({ applyProjectAction }) => applyProjectAction(parsed.path as string, parsed as unknown as import("./dashboard-projects").ProjectActionPayload))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"project action failed"}'); });
    });
}

function createDashboardServer(version: string): Server {
    return createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        const method = req.method || "GET";
        // One gate for the whole API surface. On an exposed bind this is what authenticates:
        // every /api/* route needs the bearer, including the read-only ones (stats leak project
        // names, costs and session history). `/` and `/lib/*` stay open on purpose - static
        // assets with no data, and the page must load in order to run the token bootstrap.
        if (url.startsWith("/api/") && !isAuthorized(req)) {
            const exposed = activeBind.mode !== "loopback";
            res.writeHead(exposed ? 401 : 403, { ...JSON_HDR, "WWW-Authenticate": "Bearer" });
            res.end(exposed ? '{"error":"unauthorized"}' : '{"error":"forbidden"}');
            return;
        }
        if (url === "/api/settings") {
            if (method === "GET") { serveSettings(res); return; }
            if (method === "POST") { writeSetting(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/skills") {
            if (method === "GET") { serveSkills(res); return; }
            if (method === "POST") { writeSkill(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // AI quality gate: its YAML config plus the runs recorded for a project.
        if (url === "/api/gate") {
            if (method === "GET") { serveGate(req, res); return; }
            if (method === "POST") { writeGate(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // Agent memory editor (CLAUDE.md / AGENTS.md), global or per project.
        if (url === "/api/memory") {
            if (method === "GET") { serveMemory(req, res); return; }
            if (method === "POST") { writeMemoryAction(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/update") {
            if (method === "POST") { serveUpdate(res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/run-update") {
            // Spawns a detached `enigma update` (full self-update incl. the CLI binary).
            if (method === "POST") { serveRunUpdate(res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/fix-path") {
            if (method === "POST") { serveFixPath(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/resources") {
            // Destructive: kills processes / shuts down WSL / quits Docker.
            if (method === "GET") { serveResources(res); return; }
            if (method === "POST") { writeResources(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // Recall reads your own session memory and can sync/clear it.
        if (url === "/api/recall") {
            if (method === "GET") { serveRecall(req, res); return; }
            if (method === "POST") { writeRecall(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // Code-graph reads/registers an external MCP for your agents.
        if (url === "/api/codegraph") {
            if (method === "GET") { serveCodeGraph(req, res); return; }
            if (method === "POST") { writeCodeGraph(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // The API playground drives a real agent (spawns / makes a request).
        if (url === "/api/playground") {
            if (method === "GET") { servePlayground(res); return; }
            if (method === "POST") { runPlaygroundRoute(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/accounts") {
            if (method === "GET") { serveAccounts(res); return; }
            if (method === "POST") { writeAccount(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/config-export") {
            if (method === "GET") { serveConfigExport(res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/config-import") {
            if (method === "POST") { writeConfigImport(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/plan") {
            if (method === "POST") { writePlan(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/dashboard-port") {
            if (method === "POST") { writeDashboardPort(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // Marketplace packs: fetch/remove/update/setup optional isolated harness packs.
        if (url === "/api/packs") {
            if (method === "GET") { servePacks(res); return; }
            if (method === "POST") { writePack(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // SSH connection manager: manage saved connections and port forwards.
        if (url === "/api/ssh") {
            if (method === "GET") { serveSsh(res); return; }
            if (method === "POST") { writeSsh(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // Per-project management: registers project folders and manages each by path
        // (skills, local config, git hooks, gate). Operates only on registered projects.
        if (url === "/api/projects") {
            if (method === "GET") { serveProjects(res); return; }
            if (method === "POST") { writeProjects(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/projects/detail") {
            if (method === "GET") { serveProjectDetail(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/projects/action") {
            if (method === "POST") { writeProjectAction(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (method !== "GET") { res.writeHead(405).end(); return; }
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
        if (url === "/api/status") { serveStatus(res); return; }
        if (url === "/api/provider-status") { void serveProviderStatus(req, res); return; }
        if (url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            // `service` is the marker the CLI's liveness probe matches on, so a foreign listener
            // that happens to hold the port cannot pass for the dashboard. The pid goes only to
            // same-machine callers: it names the process to stop, and is nobody else's business.
            res.end(JSON.stringify({ status: "ok", service: HEALTH_SERVICE, version, pid: isLocalRequest(req) ? process.pid : undefined }));
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
    });
}

function tryListen(server: Server, port: number, host: string): Promise<void> {
    return new Promise((res, rej) => {
        const onErr = (e: Error): void => { server.removeListener("listening", onOk); rej(e); };
        const onOk = (): void => { server.removeListener("error", onErr); res(); };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(port, host);
    });
}

/** The port the running server actually bound, surfaced to the settings UI. 0 until listening. */
let boundPort = 0;

/**
 * Bind a port for the dashboard on `host`. A user-configured `dashboardPort` (1-65535) is tried
 * first; otherwise (or if it is busy) it falls back to 80 -> 24282 -> an ephemeral port, so the
 * dashboard always opens. Returns the bound port.
 *
 * `host` is user-configurable, so exhausting the list means the interface is unavailable (a
 * stale `dashboardBindAddress`, a downed tailnet) far more often than it means every port is
 * taken: the list ends at port 0, and the OS always has a free ephemeral port to hand out, so
 * failing THAT was never about the port. The error reports that inference rather than the
 * listen error code, because the code cannot be trusted here - bun flattens every listen
 * failure to EADDRINUSE ("Is port X in use?"), including an unroutable address, where node
 * reports EADDRNOTAVAIL. Enigma ships as a bun binary, so the misleading one is the default.
 */
async function listenWithFallback(server: Server, host: string): Promise<number> {
    const preferred = conf.readConfig().config.dashboardPort;
    const valid = Number.isInteger(preferred) && preferred > 0 && preferred <= 65535;
    const candidates = [...(valid ? [preferred] : []), ...PORTS, 0].filter((p, i, a) => a.indexOf(p) === i);
    let last = "";
    for (const port of candidates) {
        try { await tryListen(server, port, host); boundPort = (server.address() as { port: number; }).port; return boundPort; }
        catch (err) { last = (err as NodeJS.ErrnoException).code || (err as Error).message; }
    }
    throw new Error(`could not bind the dashboard to ${host}: no port worked, including an ephemeral one (${last}) - that points at the interface, not the port. Check \`enigma config dashboard-bind\` / \`dashboard-bind-address\`.`);
}

export interface RunningServer {
    /** Clean URL, no token. */
    url: string;
    port: number;
    bind: BindResolution;
    close: () => void;
}

/**
 * Start the HTTP server and resolve once it is listening. Caller owns its lifecycle.
 * Rejects rather than binding an exposed interface without a token (see resolveBind).
 */
export async function startDashboardServer(version: string, bindOverride?: conf.DashboardBind): Promise<RunningServer> {
    const bind = resolveBind(bindOverride);
    activeBind = bind;
    const server = createDashboardServer(version);
    const port = await listenWithFallback(server, bind.host);
    return { url: dashboardUrl(port, bind), port, bind, close: () => server.close() };
}

/**
 * The URL to hand someone, carrying the token as a fragment when one is required. The
 * fragment is deliberate: a browser never sends it to the server, so unlike a query
 * string the token cannot land in access logs or a Referer header. The page reads it
 * once, moves it to sessionStorage and strips it from the address bar.
 *
 * Encoded to match the page's decodeURIComponent: a generated token is base64url and needs
 * none, but an operator-supplied ENIGMA_DASHBOARD_TOKEN may hold `&`, `#` or `%`, which
 * would otherwise truncate the fragment or fail to decode - leaving a silently dead link.
 */
export function tokenizedUrl(url: string, token: string | null): string {
    return token ? `${url}/#token=${encodeURIComponent(token)}` : url;
}

// --- daemon (always mode) -------------------------------------------------------

/**
 * The published record of whatever is serving the dashboard right now. `kind` separates the
 * detached `always` daemon from a foreground `enigma dashboard`: both publish here so a second
 * invocation defers instead of fighting for the port, but only the daemon may be killed and
 * respawned behind the user's back. Doing that to a foreground run orphans it - the terminal is
 * freed and Ctrl+C no longer reaches anything. Records written before the field existed are
 * treated as daemons, which is what they were.
 *
 * `beat` is refreshed by the serving process while it lives (see publishDashboard). A pid alone
 * is not an identity - the OS recycles it the moment the dashboard dies - so the heartbeat is
 * what a record needs to still be believed. Absent on records written before the field existed.
 */
export interface DaemonRecord { pid: number; port: number; url: string; startedAt: number; kind?: "daemon" | "foreground"; beat?: number; }

/** How often the serving process refreshes its record, and how long a record outlives a beat. */
const BEAT_MS = 20_000;
const BEAT_STALE_MS = 120_000;
/** A dashboard on this machine answers `/health` well inside this; past it, nothing is there. */
const PROBE_MS = 800;

/** Whether a record describes the detached daemon rather than a foreground run. */
export function isDaemonRecord(rec: DaemonRecord): boolean { return rec.kind !== "foreground"; }

function daemonFile(): string {
    return join(homedir(), ".enigma", "dashboard.json");
}

function readDaemon(): DaemonRecord | null {
    try { return JSON.parse(readFileSync(daemonFile(), "utf8")) as DaemonRecord; } catch { return null; }
}

export function writeDaemon(rec: DaemonRecord): void {
    const dir = dirname(daemonFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(daemonFile(), JSON.stringify(rec, null, 2) + "\n");
}

export function clearDaemon(): void {
    try { unlinkSync(daemonFile()); } catch { /* already gone */ }
}

/** Why the last daemon start failed, sitting next to the pidfile it never got to write. */
function daemonErrorFile(): string {
    return join(homedir(), ".enigma", "dashboard-error");
}

function writeDaemonError(message: string): void {
    try {
        mkdirSync(dirname(daemonErrorFile()), { recursive: true });
        writeFileSync(daemonErrorFile(), `${message}\n`);
    } catch { /* diagnostics are best-effort; never mask the original failure */ }
}

function clearDaemonError(): void {
    try { unlinkSync(daemonErrorFile()); } catch { /* already gone */ }
}

/** The reason the background dashboard is not running, if it failed to start. */
export function daemonError(): string | null {
    try { return readFileSync(daemonErrorFile(), "utf8").trim() || null; } catch { return null; }
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
    // A live pid is necessary but NOT sufficient. Pids are recycled - aggressively so on Windows -
    // and a record whose process died points at whatever inherited the number next, which is how
    // `enigma dashboard` came to announce a dashboard "already running" on a URL that answered
    // nothing, and how `dashboard stop` could kill the innocent process that inherited it. The
    // heartbeat cannot be forged by that process, so it is what makes the record expire.
    // A record written before the field existed has no beat and keeps the old pid-only behaviour
    // until its process is replaced; liveDashboard() is what settles those authoritatively.
    const fresh = rec.beat === undefined || Date.now() - rec.beat < BEAT_STALE_MS;
    if (isProcessAlive(rec.pid) && fresh) return rec;
    clearDaemon();
    return null;
}

/**
 * Publish this process as the one serving the dashboard, and keep the record provably fresh
 * until it stops. Returns the teardown to run on shutdown. The timer is unref'd: the http
 * server is what keeps the process alive, and a heartbeat must never be the reason it lingers.
 */
export function publishDashboard(rec: Omit<DaemonRecord, "beat">): () => void {
    const beat = (): void => writeDaemon({ ...rec, beat: Date.now() });
    beat();
    const timer = setInterval(beat, BEAT_MS);
    timer.unref?.();
    return () => { clearInterval(timer); clearDaemon(); };
}

/** Addresses to ask whether a record is still serving: loopback first, then its own URL. */
function probeUrls(rec: DaemonRecord): string[] {
    const local = `http://127.0.0.1:${rec.port}/health`;
    const own = `${rec.url.replace(/\/$/, "")}/health`;
    // Loopback answers a default bind without touching DNS or the hosts entry; the record's own
    // URL is the fallback that covers an exposed bind, which does not listen on 127.0.0.1 at all.
    return own === local ? [local] : [local, own];
}

/**
 * Ask the recorded server whether it is really there. `/health` needs no token (it carries no
 * data) and names the service, so neither a dead record nor a foreign listener holding the port
 * can pass for the dashboard. Same-machine callers also get the pid back, which catches the last
 * case: a recycled record pid while a DIFFERENT dashboard answers on that port.
 */
async function probeDashboard(rec: DaemonRecord): Promise<HealthBody | null> {
    for (const url of probeUrls(rec)) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
            if (!res.ok) continue;
            const body = await res.json() as HealthBody;
            if (!identifiesDashboard(body, rec)) continue;
            // A dashboard answered, but on a pid the record does not name: a different one holds
            // this port and the record is stale. Settled, so do not ask the next address.
            if (body.pid !== undefined && body.pid !== rec.pid) return null;
            return body;
        } catch { /* not answering on this address - try the next one */ }
    }
    return null;
}

/** What `/health` answers, across every version that can still be running. Untrusted. */
interface HealthBody { service?: string; status?: string; version?: string; pid?: number; }

/**
 * Whether a health body identifies the dashboard THIS record named.
 *
 * `service` is the modern proof and settles it whenever the field is present. A body without it
 * is weighed on the weaker evidence it does carry, but only for a record that predates the
 * field - and the record itself says so, because `service` shipped alongside `beat`. A beatless
 * record is therefore exactly the one whose server answers `{"status":"ok","version":"1.26.0"}`
 * and nothing else, and the one that has to stay reachable: rejecting it settled nothing, it
 * cleared the record of a server that was still listening, which left the port held by a process
 * `stop` then reported as absent and `restart` could not replace. Observed in the field as a
 * 1.26.0 daemon serving a dashboard whose newer routes all answered 404.
 *
 * A record WITH a beat gets no such benefit: the server that wrote it names the service, so a
 * body missing it is a foreign listener on a port this record no longer owns. Accepting one
 * would put the pid check back in the position of proving a negative - such a body carries no
 * `pid` to contradict, so `stop` would signal whatever process inherited the number.
 */
function identifiesDashboard(body: HealthBody, rec: DaemonRecord): boolean {
    if (body.service !== undefined) return body.service === HEALTH_SERVICE;
    if (rec.beat !== undefined) return false;
    return body.status === "ok" && healthVersion(body) !== undefined;
}

/** The version `/health` named, or undefined if it named none. The body is untrusted JSON. */
function healthVersion(body: HealthBody): string | undefined {
    return typeof body.version === "string" && body.version.trim() !== "" ? body.version : undefined;
}

/** A confirmed dashboard: its record, plus the version the server itself reports serving. */
export interface LiveDashboard { rec: DaemonRecord; version?: string; }

/**
 * The record ONLY if it still answers as this dashboard, with the version it answered - which is
 * not necessarily this CLI's: an older server keeps the port until something restarts it, and its
 * missing routes are what the caller has to explain. Undefined only if `/health` named no version.
 */
export async function liveDashboardHealth(): Promise<LiveDashboard | null> {
    const rec = runningDaemon();
    if (!rec) return null;
    const health = await probeDashboard(rec);
    if (!health) { clearDaemon(); return null; }
    return { rec, version: healthVersion(health) };
}

/**
 * The record ONLY if it still answers as this dashboard; a phantom record is cleaned up. This is
 * the authoritative check and the one the user-facing commands use: `runningDaemon()` stays
 * synchronous for the callers that cannot await, but only an answer from the port itself proves
 * a dashboard is there. Costs one loopback request.
 */
export async function liveDashboard(): Promise<DaemonRecord | null> {
    return (await liveDashboardHealth())?.rec ?? null;
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
        const child = spawn(process.execPath, args, opts);
        // Load-bearing, not decorative: a spawn failure arrives as an ASYNCHRONOUS `error`
        // event, and a child with no listener for it rethrows as an uncaught exception -
        // taking down the caller. The try/catch around this cannot see that.
        child.on("error", () => { /* no daemon; the dashboard still opens on demand */ });
        child.unref();
    } catch { /* best-effort: a failed spawn must never break the calling command */ }
}

/**
 * Stop whatever is serving the dashboard - the background daemon, or a foreground run whose
 * terminal is gone. Best-effort; returns the record it stopped, or null if nothing was running.
 */
export function stopDashboardDaemon(): DaemonRecord | null {
    const rec = runningDaemon();
    if (!rec) { clearDaemon(); return null; }
    try { process.kill(rec.pid); } catch { /* already gone */ }
    clearDaemon();
    return rec;
}

/**
 * Verify-then-kill twin of stopDashboardDaemon, for the callers that can await. Killing by pid
 * on a record's word alone is how an unrelated process that inherited the number gets shot; the
 * probe means nothing is signalled unless a dashboard actually answers there. The synchronous
 * version stays for `applyDashboardMode`, which is called from write paths that cannot await.
 */
export async function stopDashboard(): Promise<DaemonRecord | null> {
    const rec = await liveDashboard();
    if (!rec) { clearDaemon(); return null; }
    try { process.kill(rec.pid); } catch { /* already gone */ }
    clearDaemon();
    return rec;
}

/**
 * Restart a running dashboard daemon on the freshly installed binary. Called at the end of
 * `enigma update`: an `always`-mode daemon is a long-lived process still running the PRE-update
 * binary (with its version baked in at spawn), so without this it keeps serving the old page and
 * showing a stale "update available" banner - which is exactly why the dashboard's "Update now"
 * button looked like it did nothing.
 *
 * Respawns via the enigma LAUNCHER on PATH, not process.execPath: after an update the current
 * process is the OLD (parked) binary, so re-invoking it would just bring the old version back;
 * the launcher resolves to the updated package. No-op when no daemon is running or the launcher
 * cannot be found (the daemon then simply refreshes on the next `enigma dashboard`).
 */
export function restartDashboardDaemon(): boolean {
    const running = runningDaemon();
    if (!running) return false;
    // A foreground `enigma dashboard` publishes the same record. Killing THAT and respawning it
    // detached hands the user a server their Ctrl+C no longer reaches (their terminal came back
    // and the dashboard kept serving), and it turns on-demand mode into a permanent background
    // process. An update leaves a foreground run alone; it picks up the new version when the
    // user restarts it.
    if (!isDaemonRecord(running)) return false;
    // Only `always` owns a background daemon. Under on-demand (or off) a daemon record is a
    // leftover - an earlier `always`, or a crash - and respawning it hands that user a permanent
    // detached server they never asked for, on a fresh port every update because the previous one
    // is often still holding 24282. That is how a single machine ends up with several dashboards
    // and an `enigma dashboard` that reports a different URL each time it is run.
    if (conf.readConfig().config.dashboard !== "always") return false;
    stopDashboardDaemon();
    try {
        // The child inherits THIS process's env, and during `enigma update` that env carries
        // the version the OLD launcher started us with. The respawned daemon would then keep
        // advertising it and the page's "update available" banner would survive the very
        // update it is asking for, so the version is re-read from the package on disk.
        const env = { ...process.env, ENIGMA_VERSION: installedCliVersion() };
        // Respawn the SAME way spawnDashboardDaemon does - process.execPath, no shell - which is
        // windowless on Windows (a .exe with windowsHide). Using the enigma.cmd launcher + shell:true
        // popped a visible Node/cmd console on every `enigma update`. This still picks up the new
        // version: `enigma update` parks the old binary and npm installs the new one at execPath's
        // path, so process.execPath now resolves to the updated binary. Dev (node/bun) re-runs argv[1].
        const exe = basename(process.execPath).toLowerCase();
        const args = (exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe")
            ? [process.argv[1]!, "__dashboard-serve"]
            : ["__dashboard-serve"];
        const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env });
        child.on("error", () => { /* the daemon just won't come back until the next open */ });
        child.unref();
        return true;
    } catch { return false; }
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
    try { server = await startDashboardServer(version); }
    catch (err) {
        // The daemon is detached with stdio ignored, so a thrown error has nowhere to go and
        // the user just finds no dashboard. Leave the reason next to the pidfile: the common
        // case here is the fail-closed refusal (an exposed bind with no token), which is
        // otherwise indistinguishable from the daemon never having been asked to start.
        writeDaemonError((err as Error).message);
        return;
    }
    clearDaemonError();
    const unpublish = publishDashboard({ pid: process.pid, port: server.port, url: server.url, startedAt: Date.now(), kind: "daemon" });
    // Block until a shutdown signal. Without this the function would return, run() would resolve,
    // and the bin entry's process.exit() would kill the daemon the instant after it bound its port
    // (the pidfile is written but nothing ever answers). The MCP server stays alive the same way.
    await new Promise<void>((resolve) => {
        const shutdown = (): void => { unpublish(); server.close(); resolve(); };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
    });
}

// --- mode side effects ----------------------------------------------------------

export interface DashboardApplyResult { hosts: HostsResult | null; daemon: "started" | "stopped" | "none"; }

/**
 * Apply the side effects of a dashboard mode change. Idempotent and best-effort:
 * - off:       full teardown - stop any daemon AND remove the hosts entry, so the
 *              dashboard leaves no trace (it can be added back any time by re-enabling).
 * - on-demand: ensure the hosts entry; stop a daemon left over from "always".
 * - always:    ensure the hosts entry; start the background daemon.
 */
export function applyDashboardMode(mode: "off" | "on-demand" | "always"): DashboardApplyResult {
    if (mode === "off") { stopDashboardDaemon(); return { hosts: removeHostsEntry(), daemon: "stopped" }; }
    // Enabling fetches the UI bundle in the background (no-op if already installed).
    spawnDashboardPkgInstall();
    const hosts = ensureHostsEntry();
    if (mode === "always") { spawnDashboardDaemon(); return { hosts, daemon: "started" }; }
    stopDashboardDaemon();
    return { hosts, daemon: "stopped" };
}
