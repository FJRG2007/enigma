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

import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readStats, readHistory, ccrCacheStats } from "./compress";
import { dashboardAssetsDir, installedDashboardVersion, spawnDashboardPkgInstall } from "./dashboard-pkg";
import { readUsageCached } from "./usage";
import { readConfig, setEnigmaValue } from "./config";
import { resolveBin } from "./util";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The vendored charting library file name, served locally - never a CDN. */
const LIB_FILE = "chart.min.js";

/** Absolute path to an installed UI asset, or null when the on-demand package is absent. */
function assetPath(...parts: string[]): string | null {
    const dir = dashboardAssetsDir();
    return dir ? join(dir, ...parts) : null;
}

/** Loopback only: the dashboard exposes local savings data and is never network-facing. */
const HOST = "127.0.0.1";
/** Bare hostname mapped to loopback in the hosts file so `http://enigma` resolves. */
const HOSTNAME = "enigma";
/** Try :80 first (pretty URL, no port), then a high fallback, then an ephemeral port. */
const PORTS: readonly number[] = [80, 24282];
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

/** The URL a user should open for a server bound to `port`, given hosts availability. */
export function dashboardUrl(port: number): string {
    const host = hasHostsEntry() ? HOSTNAME : "localhost";
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
function readAssetCached(cache: { text: string; key: string } | null, path: string | null, fallback: string): { value: string; cache: { text: string; key: string } | null } {
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

let htmlCache: { text: string; key: string } | null = null;

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

let libCache: { text: string; key: string } | null = null;

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

let snapshot: { payload: string; expires: number } | null = null;
const SNAPSHOT_TTL_MS = 1000;

// Identifies this server process. The page reloads when it sees this change, so a tab left
// open from a previous `enigma dashboard` self-heals after a restart/UI update.
const SERVER_BOOT = Date.now();

/** JSON stats payload, served from a short-TTL cache so polling never rebuilds it twice. */
function statsPayload(version: string): string {
    const now = Date.now();
    if (snapshot && now < snapshot.expires) return snapshot.payload;
    const cfg = readConfig().config;
    const payload = JSON.stringify({
        version, generatedAt: now, boot: SERVER_BOOT,
        // Version of the served UI bundle (@enigmax/dashboard). The page reloads when this
        // changes, so a background update to a newer bundle swaps the UI without a restart.
        ui: installedDashboardVersion(),
        priceOverride: cfg.tokenPrice, speedOverride: cfg.tokenSpeed,
        stats: readStats(), history: readHistory(), cache: ccrCacheStats(),
        usage: cfg.usageStats ? readUsageCached() : null,
    });
    snapshot = { payload, expires: now + SNAPSHOT_TTL_MS };
    return payload;
}

/** Hostnames a same-machine request may legitimately use (the server binds 127.0.0.1 only). */
const LOCAL_HOSTS = new Set(["enigma", "localhost", "127.0.0.1", "::1"]);

/** Strip scheme/port/path from a Host or Origin header, leaving the bare hostname. */
function hostOnly(h: string | undefined): string {
    return (h || "").replace(/^https?:\/\//, "").replace(/^\[|\]$/g, "").split("/")[0].split(":")[0].toLowerCase();
}

/**
 * Guard for the settings WRITE surface: accept only same-machine requests and reject any
 * cross-origin caller. The server is already loopback-bound (unreachable from the network),
 * and this also blocks DNS-rebinding / CSRF from a malicious web page on the same machine.
 */
function isLocalRequest(req: import("node:http").IncomingMessage): boolean {
    if (!LOCAL_HOSTS.has(hostOnly(req.headers.host))) return false;
    const origin = req.headers.origin;
    if (origin && !LOCAL_HOSTS.has(hostOnly(origin))) return false;
    return true;
}

const JSON_HDR = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } as const;

/** Serve the current value of every configurable setting (mirrors the TUI registry). */
function serveSettings(res: import("node:http").ServerResponse): void {
    import("./dashboard-settings")
        .then(({ serializeSettings }) => { res.writeHead(200, JSON_HDR); res.end(JSON.stringify({ categories: serializeSettings("global") })); })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"settings unavailable"}'); });
}

/** Apply a single setting write from a POST body { key, value }. Bounded body, global scope. */
function writeSetting(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
        let parsed: { key?: unknown; value?: unknown };
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
    Promise.all([import("./skills"), import("./dashboard-pkg")])
        .then(async ([skills, pkg]) => {
            const { updated, synced } = await skills.checkAndUpdateSkills();
            const uiChanged = pkg.refreshDashboardPkg();
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
            res.end(JSON.stringify({ ok: true, changed, version: process.env.ENIGMA_VERSION || "", note }));
        })
        .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"ok":false,"error":"update failed"}'); });
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
        let parsed: { tool?: unknown };
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
        let parsed: { name?: unknown; action?: unknown; content?: unknown };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        if (typeof parsed.action !== "string") { res.writeHead(400, JSON_HDR); res.end('{"error":"missing action"}'); return; }
        import("./dashboard-skills")
            .then(({ applySkillAction }) => applySkillAction(typeof parsed.name === "string" ? parsed.name : "", parsed.action as string, parsed.content))
            .then((out) => { res.writeHead(out.ok ? 200 : 400, JSON_HDR); res.end(JSON.stringify(out)); })
            .catch(() => { res.writeHead(500, JSON_HDR); res.end('{"error":"action failed"}'); });
    });
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
        let parsed: { op?: unknown } & Record<string, unknown>;
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
        let parsed: { key?: unknown; value?: unknown };
        try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400, JSON_HDR); res.end('{"error":"bad json"}'); return; }
        const field = typeof parsed.key === "string" ? PLAN_FIELDS[parsed.key as keyof typeof PLAN_FIELDS] : undefined;
        if (!field) { res.writeHead(400, JSON_HDR); res.end('{"error":"unknown plan key"}'); return; }
        if (field === "planWeeklyReset") {
            setEnigmaValue("planWeeklyReset", String(parsed.value || "mon 00:00"), "global");
        } else {
            const n = Number(parsed.value);
            if (!Number.isFinite(n) || n < 0) { res.writeHead(400, JSON_HDR); res.end('{"error":"bad number"}'); return; }
            setEnigmaValue(field, n, "global");
        }
        snapshot = null; // force the next /api/stats to recompute the windows with the new limit
        res.writeHead(200, JSON_HDR); res.end('{"ok":true}');
    });
}

function createDashboardServer(version: string): Server {
    return createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        const method = req.method || "GET";
        // Settings + Skills APIs are the write surfaces, so they are origin-guarded.
        if (url === "/api/settings") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "GET") { serveSettings(res); return; }
            if (method === "POST") { writeSetting(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/skills") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "GET") { serveSkills(res); return; }
            if (method === "POST") { writeSkill(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/update") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "POST") { serveUpdate(res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/fix-path") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "POST") { serveFixPath(req, res); return; }
            res.writeHead(405).end(); return;
        }
        // Accounts/profiles management + config import/export are write/structure surfaces, origin-guarded.
        if (url === "/api/accounts") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "GET") { serveAccounts(res); return; }
            if (method === "POST") { writeAccount(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/config-export") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "GET") { serveConfigExport(res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/config-import") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "POST") { writeConfigImport(req, res); return; }
            res.writeHead(405).end(); return;
        }
        if (url === "/api/plan") {
            if (!isLocalRequest(req)) { res.writeHead(403, JSON_HDR); res.end('{"error":"forbidden"}'); return; }
            if (method === "POST") { writePlan(req, res); return; }
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
