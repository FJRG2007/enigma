/**
 * Local savings dashboard: the http server serves the HTML shell, a JSON stats payload
 * reflecting recorded savings, and 404s anything else; URL formatting drops the port
 * only on :80; and a stale daemon pidfile is detected as not-running and cleaned up.
 * Temp HOME (set BEFORE import) isolates ~/.enigma, resolved lazily per call.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-dash-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { startDashboardServer, dashboardUrl, runningDaemon, removeHostsEntry } = await import("../src/dashboard");
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
        const page = await html.text();
        expect(page).toContain("<!doctype html>");
        // The chart library's attribution logo is suppressed in our own CSS.
        expect(page).toContain("#tv-attr-logo { display: none");

        // The vendored chart library is served from the loopback server (no CDN).
        const lib = await fetch(`${base}/lib/chart.min.js`);
        expect(lib.status).toBe(200);
        expect(lib.headers.get("content-type")).toContain("javascript");
        expect(await lib.text()).toContain("createChart");

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

test("settings API reads the registry and writes a setting; cross-origin writes are refused", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        // GET returns the same categories the TUI registry exposes.
        const get = await fetch(`${base}/api/settings`);
        expect(get.status).toBe(200);
        const data = await get.json() as { categories: { settings: { key: string; value: boolean }[] }[] };
        const all = data.categories.flatMap((c) => c.settings);
        const commit = all.find((s) => s.key === "commit-emoji");
        expect(commit).toBeDefined();

        // POST toggles a boolean setting and the change is reflected back.
        const next = !commit!.value;
        const post = await fetch(`${base}/api/settings`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: "commit-emoji", value: next }),
        });
        expect(post.status).toBe(200);
        const out = await post.json() as { ok: boolean; setting?: { value: boolean } };
        expect(out.ok).toBe(true);
        expect(out.setting?.value).toBe(next);

        // A cross-origin POST (CSRF / DNS-rebind) is rejected before any write.
        const evil = await fetch(`${base}/api/settings`, {
            method: "POST", headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
            body: JSON.stringify({ key: "commit-emoji", value: true }),
        });
        expect(evil.status).toBe(403);
    } finally {
        server.close();
    }
});

test("removeHostsEntry strips only the enigma mapping and leaves other hosts intact", () => {
    const hostsPath = join(homedir(), "hosts-test");
    process.env.ENIGMA_HOSTS_FILE = hostsPath;
    try {
        writeFileSync(hostsPath, [
            "127.0.0.1 localhost",
            "# enigma-dashboard (managed by enigma; remove to disable http://enigma)",
            "127.0.0.1 enigma",
            "10.0.0.5 internal.example",
        ].join("\n") + "\n");
        const r = removeHostsEntry();
        expect(r.ok).toBe(true);
        const after = readFileSync(hostsPath, "utf8");
        expect(after).not.toContain("enigma");
        expect(after).toContain("127.0.0.1 localhost");
        expect(after).toContain("10.0.0.5 internal.example");
        // Idempotent: a second removal is a no-op.
        expect(removeHostsEntry().ok).toBe(true);
    } finally {
        delete process.env.ENIGMA_HOSTS_FILE;
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
