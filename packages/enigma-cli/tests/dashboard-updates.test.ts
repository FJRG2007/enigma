/**
 * Package update checker: queries a fake npm registry (never the real one), flags the CLI as
 * having an update when a newer version is published, and persists the result so the dashboard
 * stats payload can read it. Temp HOME (set BEFORE import) isolates ~/.enigma; a local http
 * server stands in for registry.npmjs.org via ENIGMA_NPM_REGISTRY.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "enigma-upd-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

// Fake registry: /<pkg>/latest -> { version }. enigma-cli is the only installed package in a
// bare temp HOME (no managed dashboard/linter), so that is the one we publish a version for.
const registry: Server = createServer((req, res) => {
    if (req.url === "/enigma-cli/latest") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ version: "9.9.9" })); return; }
    res.writeHead(404); res.end("{}");
});
await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
process.env.ENIGMA_NPM_REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number; }).port}`;
process.env.ENIGMA_NO_UPDATE_CHECK = "1"; // read the cache without auto-triggering a second fetch

const { refreshUpdateStatus, readUpdateStatusCached } = await import("../src/dashboard-updates");

afterAll(() => { registry.close(); rmSync(HOME, { recursive: true, force: true }); });

test("flags a newer CLI release and persists the status", async () => {
    await refreshUpdateStatus("1.0.0");
    const status = readUpdateStatusCached("1.0.0");
    expect(status).not.toBeNull();
    expect(status!.available).toBe(true);
    const cli = status!.packages.find((p) => p.name === "enigma-cli");
    expect(cli).toBeTruthy();
    expect(cli!.latest).toBe("9.9.9");
    expect(cli!.hasUpdate).toBe(true);
});

test("reports no update when the CLI is already current", async () => {
    await refreshUpdateStatus("9.9.9");
    const status = readUpdateStatusCached("9.9.9");
    expect(status!.available).toBe(false);
    expect(status!.packages.find((p) => p.name === "enigma-cli")!.hasUpdate).toBe(false);
});
