/**
 * Dashboard exposure: the dashboard is an admin surface, so a bind beyond loopback refuses to
 * start without a token, and once it has one every /api/* route demands the bearer.
 *
 * The exposed cases bind mode "custom" pinned at 127.0.0.1: token enforcement keys off the
 * bind MODE, not the address, so this exercises the whole auth path end-to-end without ever
 * putting a port on the network of whatever machine runs the suite.
 *
 * Temp HOME + ENIGMA_CONFIG_HOME are set BEFORE the import: the modules resolve paths lazily
 * per call, but only through enigmaHome(), which bun on Linux will not re-read from $HOME.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-expose-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_NO_UPDATE_CHECK = "1";
// An inherited token would mask the fail-closed case, which is the whole point of this file.
delete process.env.ENIGMA_DASHBOARD_TOKEN;

const { startDashboardServer, resolveBind, tokenizedUrl } = await import("../src/dashboard");
const { ensureDashboardToken, clearDashboardToken, readDashboardToken, tokenMatches, bearerOf } = await import("../src/dashboard-token");

/** Point the global config at a bind; the repo has no local .enigma.json to override it. */
function setBind(mode: string, address = ""): void {
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ dashboardBind: mode, dashboardBindAddress: address }));
}

/**
 * GET a route over loopback while presenting an arbitrary Host, the way a browser on another
 * machine would. Raw node:http because fetch() treats Host as a forbidden header and rewrites
 * it to the address it dialed - which would quietly turn this back into a same-machine request.
 */
function getAs(port: number, path: string, host: string, token: string | null): Promise<number> {
    const headers: Record<string, string> = { Host: host };
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Promise((res, rej) => {
        const req = request({ host: "127.0.0.1", port, path, method: "GET", headers, setHost: false }, (r) => {
            r.resume();
            r.on("end", () => res(r.statusCode || 0));
        });
        req.on("error", rej);
        req.end();
    });
}

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("a non-loopback bind refuses to start without a token", () => {
    setBind("custom", "127.0.0.1");
    clearDashboardToken();
    // Failing to start is the intended outcome: serving an admin surface unauthenticated
    // would be worse than not serving it at all.
    expect(() => resolveBind()).toThrow(/without a token/);
    expect(startDashboardServer("v")).rejects.toThrow(/without a token/);
});

test("a custom bind with no address configured refuses to start", () => {
    setBind("custom", "");
    ensureDashboardToken();
    expect(() => resolveBind()).toThrow(/dashboardBindAddress is empty/);
    clearDashboardToken();
});

test("an unavailable bind address blames the interface, not the port", async () => {
    // 192.0.2.1 is TEST-NET-1: never assigned to a local interface, so every listen fails
    // without touching the network. This is the stale-dashboardBindAddress case (a tailnet
    // that moved, an interface that is down), which used to exhaust the port fallback list
    // and report "could not bind any port", sending the operator after the wrong cause.
    // Asserted on the message, not the error code: bun reports this as EADDRINUSE.
    setBind("custom", "192.0.2.1");
    ensureDashboardToken();
    expect(startDashboardServer("v")).rejects.toThrow(/points at the interface, not the port/);
    clearDashboardToken();
});

test("loopback binds with no token and keeps serving the API", async () => {
    setBind("loopback");
    clearDashboardToken();
    const bind = resolveBind();
    expect(bind.host).toBe("127.0.0.1");
    expect(bind.token).toBeNull();
    const server = await startDashboardServer("test-version");
    try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/status`);
        expect(res.status).toBe(200);
    } finally { server.close(); }
});

test("an exposed bind rejects every /api/* request without the bearer, and serves it with", async () => {
    setBind("custom", "127.0.0.1");
    const token = ensureDashboardToken(true);
    const server = await startDashboardServer("test-version");
    const base = `http://127.0.0.1:${server.port}`;
    try {
        expect(server.bind.token).toBe(token);

        // Read-only routes are gated too: the stats payload carries project names, costs and
        // session history, so it is not "harmless" just because it does not write.
        for (const route of ["/api/status", "/api/stats", "/api/settings"]) {
            const res = await fetch(`${base}${route}`);
            expect(res.status).toBe(401);
        }
        // A write surface stays shut too.
        const write = await fetch(`${base}/api/settings`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "commit-emoji", value: false }),
        });
        expect(write.status).toBe(401);

        const wrong = await fetch(`${base}/api/status`, { headers: { Authorization: "Bearer not-the-token" } });
        expect(wrong.status).toBe(401);

        const ok = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
        expect(ok.status).toBe(200);

        // The page itself stays open: it has no data, and it must load to run the bootstrap
        // that reads the token out of the URL fragment.
        const page = await fetch(`${base}/`);
        expect(page.status).toBe(200);
    } finally { server.close(); }
});

test("an exposed bind serves every route to a bearer arriving at this host's own name", async () => {
    setBind("custom", "127.0.0.1");
    const token = ensureDashboardToken(true);
    const server = await startDashboardServer("test-version");
    try {
        // The point of exposing: reaching the dashboard as "server.example", not "localhost".
        // fetch() forbids overriding Host, so the request is issued raw - and this must stay
        // that way, since a Host of 127.0.0.1 is exactly what let a 403 on ~20 routes ship.
        for (const route of ["/api/settings", "/api/skills", "/api/accounts", "/api/status"]) {
            const res = await getAs(server.port, route, "server.example", token);
            expect(res).toBe(200);
        }
        // The token is still what authenticates: a foreign Host is not a way around it.
        expect(await getAs(server.port, "/api/settings", "server.example", null)).toBe(401);
    } finally { server.close(); }
});

test("an exposed bind rejects a cross-origin caller even with a valid bearer", async () => {
    setBind("custom", "127.0.0.1");
    const token = ensureDashboardToken(true);
    const server = await startDashboardServer("test-version");
    try {
        // A token in sessionStorage is unreadable cross-origin, but a leaked one must not be
        // replayable from a page the operator merely visited.
        const res = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
            headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" },
        });
        expect(res.status).toBe(401);
    } finally { server.close(); }
});

test("the token round-trips, rotates, and the env var wins", () => {
    clearDashboardToken();
    expect(readDashboardToken()).toBeNull();

    const first = ensureDashboardToken();
    expect(first).toHaveLength(43); // 32 random bytes, base64url
    expect(ensureDashboardToken()).toBe(first); // stable unless rotated
    expect(readDashboardToken()).toBe(first);

    const rotated = ensureDashboardToken(true);
    expect(rotated).not.toBe(first);

    // An injected secret is owned by whatever injected it: never overwritten, never rotated.
    process.env.ENIGMA_DASHBOARD_TOKEN = "from-the-environment";
    expect(readDashboardToken()).toBe("from-the-environment");
    expect(ensureDashboardToken(true)).toBe("from-the-environment");
    delete process.env.ENIGMA_DASHBOARD_TOKEN;
    expect(readDashboardToken()).toBe(rotated);
    clearDashboardToken();
});

test.skipIf(process.platform === "win32")("the token file is readable only by its owner", () => {
    clearDashboardToken();
    ensureDashboardToken();
    // Windows has no POSIX modes (chmod is a no-op there), so this only means anything on
    // a real POSIX host - which is exactly where an exposed dashboard tends to run.
    const mode = statSync(join(HOME, ".enigma", "dashboard-token")).mode & 0o777;
    expect(mode).toBe(0o600);
    clearDashboardToken();
});

test("token compare rejects mismatches regardless of length", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("secret", "secre")).toBe(false);
    expect(tokenMatches("secret", "secretx")).toBe(false);
    expect(tokenMatches("secret", "")).toBe(false);
    expect(tokenMatches("secret", undefined)).toBe(false);
});

test("bearerOf reads only a well-formed Authorization header", () => {
    expect(bearerOf("Bearer abc123")).toBe("abc123");
    expect(bearerOf("bearer abc123")).toBe("abc123");
    expect(bearerOf("Basic abc123")).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
    expect(bearerOf("Bearer")).toBeUndefined();
});

test("the token rides the URL as a fragment, never a query string", () => {
    // A fragment is not sent to the server, so it cannot reach an access log or a Referer.
    expect(tokenizedUrl("http://host:24282", "abc")).toBe("http://host:24282/#token=abc");
    expect(tokenizedUrl("http://host:24282", null)).toBe("http://host:24282");
});

test("a token with URL-special characters survives the trip to the page", () => {
    // Generated tokens are base64url, but an operator can inject any secret through
    // ENIGMA_DASHBOARD_TOKEN. Unencoded, `&` truncates the fragment and `%` makes the page's
    // decodeURIComponent throw - both of which read as a silently unauthenticated tab.
    const awkward = "a&b#c%d e";
    const link = tokenizedUrl("http://host:24282", awkward);
    expect(link).toBe(`http://host:24282/#token=${encodeURIComponent(awkward)}`);
    // Read it back exactly as the bootstrap in index.html does.
    const m = /[#&]token=([^&]*)/.exec(link);
    expect(decodeURIComponent(m![1]!)).toBe(awkward);
});
