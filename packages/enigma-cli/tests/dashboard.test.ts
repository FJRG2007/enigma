/**
 * Local savings dashboard: the http server serves the HTML shell, a JSON stats payload
 * reflecting recorded savings, and 404s anything else; URL formatting drops the port
 * only on :80; and a stale daemon pidfile is detected as not-running and cleaned up.
 * Temp HOME (set BEFORE import) isolates ~/.enigma, resolved lazily per call.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-dash-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { startDashboardServer, dashboardUrl, runningDaemon } = await import("../src/dashboard");
const { recordStats } = await import("../src/compress/ccr");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("serves the HTML shell, a stats payload, and 404s the rest", async () => {
    recordStats(1000, 250); // one recorded compression before the snapshot is built
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const html = await fetch(`${base}/`);
        expect(html.status).toBe(200);
        expect(html.headers.get("content-type")).toContain("text/html");
        expect(await html.text()).toContain("<!doctype html>");

        // The vendored chart library is served from the loopback server (no CDN).
        const lib = await fetch(`${base}/lib/lightweight-charts.standalone.production.js`);
        expect(lib.status).toBe(200);
        expect(lib.headers.get("content-type")).toContain("javascript");
        expect(await lib.text()).toContain("TradingView");

        const api = await fetch(`${base}/api/stats`);
        expect(api.status).toBe(200);
        const payload = await api.json() as { version: string; stats: { calls: number; tokensSaved: number } };
        expect(payload.version).toBe("test-version");
        expect(payload.stats.calls).toBeGreaterThanOrEqual(1);
        expect(payload.stats.tokensSaved).toBeGreaterThanOrEqual(750);

        expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
        server.close();
    }
});

test("dashboardUrl omits the port only on :80", () => {
    expect(dashboardUrl(80)).not.toContain(":80");
    expect(dashboardUrl(24282)).toContain(":24282");
    expect(dashboardUrl(24282)).toMatch(/^http:\/\//);
});

test("a stale daemon pidfile reads as not running and is cleaned up", () => {
    const dir = join(homedir(), ".enigma");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const pidfile = join(dir, "dashboard.json");
    // A pid that cannot exist: signal-0 probe yields ESRCH (dead), not EPERM (alive).
    writeFileSync(pidfile, JSON.stringify({ pid: 2147483646, port: 80, url: "http://enigma", startedAt: 0 }));
    expect(runningDaemon()).toBeNull();
    expect(existsSync(pidfile)).toBe(false);
});
