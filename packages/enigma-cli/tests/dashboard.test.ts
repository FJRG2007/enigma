/**
 * Local savings dashboard: the http server serves the HTML shell, a JSON stats payload
 * reflecting recorded savings, and 404s anything else; URL formatting drops the port
 * only on :80; and a stale daemon pidfile is detected as not-running and cleaned up.
 * Temp HOME (set BEFORE import) isolates ~/.enigma, resolved lazily per call.
 */
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-dash-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// Keep the stats payload's update check from making a real npm request during the test.
process.env.ENIGMA_NO_UPDATE_CHECK = "1";
// Resolve the Helio pack from the in-repo vendored assets (no npm fetch) and isolate its
// managed dir, so the /api/packs route is exercised network-free.
process.env.ENIGMA_PACKS_DIR = join(HOME, "packs");
process.env.ENIGMA_HELIO_ASSETS = join(__dirname, "..", "..", "helio", "assets");

const { startDashboardServer, dashboardUrl, runningDaemon, removeHostsEntry, restartDashboardDaemon } = await import("../src/dashboard");
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
        const payload = await api.json() as { version: string; ui: string | null; stats: { calls: number; tokensSaved: number; }; };
        expect(payload.version).toBe("test-version");
        // The served UI bundle version drives the browser's auto-reload-on-update; the key is
        // always present (null when no on-demand bundle is installed, as in this test).
        expect("ui" in payload).toBe(true);
        expect(payload.stats.calls).toBeGreaterThanOrEqual(1);
        expect(payload.stats.tokensSaved).toBeGreaterThanOrEqual(750);

        expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
        server.close();
    }
});

test("re-reads the page when the bundle changes on disk (external enigma update)", async () => {
    // Point the server at a controlled assets dir so we can mutate index.html under it,
    // simulating `enigma update` swapping the @enigmax/dashboard bundle in another process.
    const assets = join(HOME, "dash-assets");
    mkdirSync(assets, { recursive: true });
    const page = join(assets, "index.html");
    writeFileSync(page, "<!doctype html><title>x</title>PAGE_ONE");
    process.env.ENIGMA_DASHBOARD_ASSETS = assets;
    const server = await startDashboardServer("v");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        expect(await (await fetch(`${base}/`)).text()).toContain("PAGE_ONE");
        // Different content AND size so the (mtime,size) cache key always changes, even if the
        // filesystem's mtime resolution is too coarse to differ between two fast writes.
        writeFileSync(page, "<!doctype html><title>x</title>PAGE_TWO_AFTER_UPDATE");
        expect(await (await fetch(`${base}/`)).text()).toContain("PAGE_TWO_AFTER_UPDATE");
    } finally {
        server.close();
        delete process.env.ENIGMA_DASHBOARD_ASSETS;
    }
});

test("settings API reads the registry and writes a setting; cross-origin writes are refused", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        // GET returns the same categories the TUI registry exposes.
        const get = await fetch(`${base}/api/settings`);
        expect(get.status).toBe(200);
        const data = await get.json() as { categories: { settings: { key: string; value: boolean; }[]; }[]; };
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
        const out = await post.json() as { ok: boolean; setting?: { value: boolean; }; };
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

test("settings expose the dashboard port; the port API validates and persists it", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        // The settings payload carries the numeric port knobs (outside the bool/choice registry).
        const data = await (await fetch(`${base}/api/settings`)).json() as {
            dashboardPort: number; runningPort: number;
            categories: { settings: { key: string; choices: string[] | null; offChoice: string; }[]; }[];
        };
        expect(typeof data.dashboardPort).toBe("number");
        expect(data.runningPort).toBe(server.port); // the live bound port is surfaced

        // prompt-secret-mode is a two-value SELECT (redact/reject), not a switch: its offChoice
        // must NOT be one of the choices, or the UI renders it as a toggle.
        const mode = data.categories.flatMap((c) => c.settings).find((s) => s.key === "prompt-secret-mode");
        expect(mode?.choices).toEqual(["redact", "reject"]);
        expect(mode!.choices!.indexOf(mode!.offChoice)).toBe(-1);

        // A valid port persists; the next GET reflects it.
        const ok = await fetch(`${base}/api/dashboard-port`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 8137 }),
        });
        expect(ok.status).toBe(200);
        expect((await (await fetch(`${base}/api/settings`)).json() as { dashboardPort: number; }).dashboardPort).toBe(8137);

        // Out-of-range is rejected, and a cross-origin write is refused before any change.
        expect((await fetch(`${base}/api/dashboard-port`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 99999 }) })).status).toBe(400);
        expect((await fetch(`${base}/api/dashboard-port`, { method: "POST", headers: { "Content-Type": "application/json", "Origin": "http://evil.example" }, body: JSON.stringify({ value: 3000 }) })).status).toBe(403);
    } finally {
        server.close();
    }
});

test("status API reports the configured state of each system", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const res = await fetch(`${base}/api/status`);
        expect(res.status).toBe(200);
        const data = await res.json() as { systems: { compress: boolean; outputStyle: string; minimalCode: string; proxy: boolean; proxyStats: { calls: number; }; security: { guardProtects: string[]; }; skills: { enigma: number; }; }; };
        const s = data.systems;
        expect(typeof s.compress).toBe("boolean");
        expect(typeof s.outputStyle).toBe("string");
        expect(typeof s.minimalCode).toBe("string");
        expect(typeof s.proxy).toBe("boolean");
        expect(typeof s.proxyStats.calls).toBe("number");
        expect(Array.isArray(s.security.guardProtects)).toBe(true);
        // The 17 bundled enigma skills are always known, even with no agents installed.
        expect(s.skills.enigma).toBeGreaterThanOrEqual(1);
    } finally {
        server.close();
    }
});

test("provider-status proxy rejects a provider with no statuspage", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        // opencode has no public statuspage -> deterministic, no network involved.
        const res = await fetch(`${base}/api/provider-status?provider=opencode`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ error: "unsupported" });
    } finally {
        server.close();
    }
});

test("skills API lists enigma skills and disable/enable round-trips", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const get = await fetch(`${base}/api/skills`);
        expect(get.status).toBe(200);
        const data = await get.json() as { skills: { name: string; source: string; discarded: boolean; update: string | null; }[]; };
        const git = data.skills.find((s) => s.name === "git-policy");
        expect(git).toBeDefined();
        expect(git!.source).toBe("enigma");

        // "read" returns the skill's SKILL.md content for the inline editor.
        const read = await fetch(`${base}/api/skills`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "git-policy", action: "read" }),
        });
        const rout = await read.json() as { ok: boolean; content?: string; };
        expect(rout.ok).toBe(true);
        expect(rout.content).toContain("name: git-policy");

        // Disable then re-read: the skill comes back flagged discarded.
        const post = await fetch(`${base}/api/skills`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "git-policy", action: "disable" }),
        });
        expect(post.status).toBe(200);
        const out = await post.json() as { ok: boolean; skills?: { name: string; discarded: boolean; }[]; };
        expect(out.ok).toBe(true);
        expect(out.skills?.find((s) => s.name === "git-policy")?.discarded).toBe(true);

        // A cross-origin request to the skills write surface is refused.
        const evil = await fetch(`${base}/api/skills`, {
            method: "POST", headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
            body: JSON.stringify({ name: "git-policy", action: "enable" }),
        });
        expect(evil.status).toBe(403);
    } finally {
        server.close();
    }
});

test("packs API lists the Helio pack and a cross-origin write is refused", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const get = await fetch(`${base}/api/packs`);
        expect(get.status).toBe(200);
        const data = await get.json() as { packs: { id: string; installed: boolean; resolvedAccount?: string; accounts?: unknown[]; }[]; };
        const helio = data.packs.find((p) => p.id === "helio");
        expect(helio).toBeDefined();
        expect(helio!.installed).toBe(true); // resolved from the vendored assets
        // The seeding account is surfaced for the picker.
        expect(helio!.resolvedAccount).toBe("default");
        expect(Array.isArray(helio!.accounts)).toBe(true);

        // set-account with "" clears the pin (always valid); the pack follows the active account.
        const setAcct = await fetch(`${base}/api/packs`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "helio", action: "set-account", value: "" }),
        });
        expect((await setAcct.json() as { ok: boolean; }).ok).toBe(true);

        // "launch" returns the command to run (the browser cannot spawn an agent).
        const launch = await fetch(`${base}/api/packs`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "helio", action: "launch" }),
        });
        const lout = await launch.json() as { ok: boolean; command?: string; };
        expect(lout.ok).toBe(true);
        expect(lout.command).toBe("enigma helio");

        // A cross-origin request to the packs write surface is refused.
        const evil = await fetch(`${base}/api/packs`, {
            method: "POST", headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
            body: JSON.stringify({ id: "helio", action: "remove" }),
        });
        expect(evil.status).toBe(403);
    } finally {
        server.close();
    }
});

test("ssh API adds a connection, builds the connect command, and refuses cross-origin writes", async () => {
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        const add = await fetch(`${base}/api/ssh`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "add", alias: "server1", serverName: "web-prod", host: "203.0.113.10", user: "root", password: "hunter2" }),
        });
        const aout = await add.json() as { ok: boolean; connections?: { alias: string; name?: string; hasPassword: boolean; }[]; };
        expect(aout.ok).toBe(true);
        const conn = aout.connections!.find((c) => c.alias === "server1")!;
        expect(conn.name).toBe("web-prod"); // the second connect key round-trips
        expect(conn.hasPassword).toBe(true); // stored, never echoed back
        expect((conn as Record<string, unknown>).password).toBeUndefined();

        const list = await fetch(`${base}/api/ssh`);
        expect(list.status).toBe(200);
        expect((await list.json() as { connections: unknown[]; }).connections.length).toBe(1);

        const connect = await fetch(`${base}/api/ssh`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "connect", alias: "server1" }),
        });
        expect((await connect.json() as { command?: string; }).command).toBe("enigma ssh server1");

        // A named tunnel is saved on the connection so it can be run by name.
        const fwd = await fetch(`${base}/api/ssh`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "forward-add", alias: "server1", spec: "9090:5432", name: "pg" }),
        });
        const fout = await fwd.json() as { ok: boolean; connections?: { alias: string; forwards?: { name?: string; }[]; }[]; };
        expect(fout.ok).toBe(true);
        expect(fout.connections!.find((c) => c.alias === "server1")!.forwards![0]!.name).toBe("pg");

        // A standalone tunnel is created and listed with its live status (separate from a server).
        const tadd = await fetch(`${base}/api/ssh`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "tunnel-add", tunnelName: "redis", tunnelServer: "server1", tunnelSpec: "6380:6379" }),
        });
        const tout = await tadd.json() as { ok: boolean; tunnels?: { name: string; server: string; active: boolean; spec: string; }[]; };
        expect(tout.ok).toBe(true);
        const rt = tout.tunnels!.find((t) => t.name === "redis")!;
        expect(rt.server).toBe("server1");
        expect(rt.active).toBe(false);
        expect(rt.spec).toBe("6380:localhost:6379");

        const evil = await fetch(`${base}/api/ssh`, {
            method: "POST", headers: { "Content-Type": "application/json", "Origin": "http://evil.example" },
            body: JSON.stringify({ action: "remove", alias: "server1" }),
        });
        expect(evil.status).toBe(403);
    } finally {
        server.close();
    }
});

test("restartDashboardDaemon is a no-op (never spawns) when no daemon is running", () => {
    // No pidfile at all: nothing to restart.
    expect(restartDashboardDaemon()).toBe(false);
    // A pidfile pointing at a dead pid is treated as not-running and cleaned up, still no spawn.
    const daemonPath = join(homedir(), ".enigma", "dashboard.json");
    mkdirSync(join(homedir(), ".enigma"), { recursive: true });
    writeFileSync(daemonPath, JSON.stringify({ pid: 2147483646, port: 80, url: "http://localhost", startedAt: 1 }));
    expect(restartDashboardDaemon()).toBe(false);
    expect(runningDaemon()).toBeNull(); // the stale pidfile was cleared
});

test("restartDashboardDaemon leaves a FOREGROUND dashboard alone", () => {
    // The daemon and a foreground `enigma dashboard` publish the same pidfile. Restarting the
    // foreground one (as `enigma update` does) kills the process the user's terminal is blocked
    // on and respawns it detached: the terminal comes back and the dashboard keeps serving with
    // no Ctrl+C left to reach it. A live pid is needed here - the guard has to reject the record
    // before anything is killed.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    child.on("error", () => { /* the assertions below fail on their own if it never started */ });
    const pidfile = join(homedir(), ".enigma", "dashboard.json");
    mkdirSync(join(homedir(), ".enigma"), { recursive: true });
    try {
        writeFileSync(pidfile, JSON.stringify({ pid: child.pid, port: 80, url: "http://enigma", startedAt: 1, kind: "foreground" }));
        expect(restartDashboardDaemon()).toBe(false);
        // Untouched: a restart would have killed it and cleared the record.
        expect(existsSync(pidfile)).toBe(true);
        expect(runningDaemon()?.pid).toBe(child.pid);
    } finally {
        child.kill();
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
