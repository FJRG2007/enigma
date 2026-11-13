/**
 * `enigma serve --http`: auth, tenant isolation, request validation and bounded responses.
 * Run alone (needs Bun for recall's sqlite): bun test tests/host/serve.test.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "enigma-serve-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.ENIGMA_CONFIG_HOME = root;
process.env.ENIGMA_OFFLINE = "1";

const TOKEN = "t".repeat(40);
const dataDir = join(root, "data");
const workspace = join(root, "ws");
let server: Server;
let base = "";
let tenant: typeof import("../../src/serve/tenant");
let serveMod: typeof import("../../src/serve/server");

beforeAll(async () => {
    mkdirSync(join(workspace, "acme", "repo", "src"), { recursive: true });
    writeFileSync(join(workspace, "acme", "repo", "package.json"), "{}\n");
    writeFileSync(join(workspace, "acme", "repo", "src", "a.ts"), "export function hello() {\n  return world();\n}\n\nexport function world() {\n  return 1;\n}\n");
    writeFileSync(join(root, "token"), `${TOKEN}\n`);
    tenant = await import("../../src/serve/tenant");
    serveMod = await import("../../src/serve/server");
    server = await serveMod.startServeServer({ dataDir, tokenFile: join(root, "token"), host: "127.0.0.1", port: 0, workspaceRoot: workspace, maxBody: 4096, maxText: 200, version: "test" });
    base = `http://127.0.0.1:${(server.address() as { port: number; }).port}`;
});

afterAll(() => { server?.close(); });

async function call(path: string, body?: unknown, opts: { tenant?: string; token?: string; method?: string; raw?: string; } = {}): Promise<{ status: number; json: any; }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token !== "") headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
    if (opts.tenant !== "") headers["x-enigma-tenant"] = opts.tenant ?? "acme";
    const res = await fetch(`${base}${path}`, { method: opts.method ?? (body === undefined && !opts.raw ? "GET" : "POST"), headers, body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, json: await res.json() };
}

test("health answers without a token", async () => {
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
});

test("a wrong or missing token is 401 with the stable error shape", async () => {
    for (const token of ["", "x".repeat(40)]) {
        const r = await call("/v1/stats", undefined, { token });
        expect(r.status).toBe(401);
        expect(r.json).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    }
});

test("tenant ids are validated; mixed case and path tricks are refused", async () => {
    expect((await call("/v1/stats", undefined, { tenant: "" })).json.error.code).toBe("missing_tenant");
    for (const bad of ["Acme", "../x", ".hidden", "a/b", "con", "x".repeat(65)]) {
        expect((await call("/v1/stats", undefined, { tenant: bad })).json.error.code).toBe("invalid_tenant");
    }
});

test("recall data is isolated per tenant", async () => {
    const stored = await call("/v1/recall/remember", { content: "Webhooks retry three times", type: "discovery", project: "billing" });
    expect(stored.status).toBe(200);
    const mine = await call("/v1/recall/search", { query: "webhooks retry" });
    expect(mine.json.items.map((i: { title: string; }) => i.title)).toContain("Webhooks retry three times");
    const theirs = await call("/v1/recall/search", { query: "webhooks retry" }, { tenant: "other" });
    expect(theirs.json.items).toEqual([]);
    expect((await call("/v1/recall/get", { ids: [stored.json.id] }, { tenant: "other" })).json.items).toEqual([]);
});

test("bodies are validated against the route schema", async () => {
    expect((await call("/v1/recall/search", { bogus: 1 })).json.error.code).toBe("invalid_body");
    expect((await call("/v1/recall/search", { limit: 1000 })).json.error.code).toBe("invalid_body");
    expect((await call("/v1/recall/search", { cursor: "x" })).json.error.code).toBe("invalid_cursor");
    expect((await call("/v1/recall/search", undefined, { raw: "{nope" })).json.error.code).toBe("invalid_json");
    expect((await call("/v1/recall/search", undefined, { method: "GET" })).json.error.code).toBe("method_not_allowed");
    expect((await call("/v1/nope", {})).status).toBe(404);
});

test("an oversize body is answered 413", async () => {
    const r = await call("/v1/compress", { content: "a".repeat(10_000) });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("payload_too_large");
});

test("indexing is confined to the tenant's own workspace", async () => {
    expect((await call("/v1/codegraph/index", { root: "../../" })).json.error.code).toBe("forbidden_root");
    expect((await call("/v1/codegraph/index", { root: "repo" }, { tenant: "other" })).json.error.code).toBe("forbidden_root");
    const ok = await call("/v1/codegraph/index", { root: "repo" });
    expect(ok.status).toBe(200);
    expect(ok.json.symbols).toBe(2);
    const trace = await call("/v1/codegraph/trace", { symbol: "world" });
    expect(trace.json.text).toContain("hello");
    // Another tenant sees no project at all.
    expect((await call("/v1/codegraph/ask", { query: "hello" }, { tenant: "other" })).json.error.code).toBe("not_indexed");
});

test("a symlink inside the workspace cannot point the indexer outside it", () => {
    const link = join(workspace, "acme", "escape");
    try { symlinkSync(root, link, "junction"); } catch { return; } // no symlink privilege here
    expect(tenant.confineRoot(workspace, "acme", "escape")).toBeNull();
});

test("rendered text is capped and says so", async () => {
    const r = await call("/v1/codegraph/map", {});
    expect(r.status).toBe(200);
    expect(r.json.text.length).toBeLessThanOrEqual(200);
});

test("withTenant restores the environment and refuses an async handler", async () => {
    const before = process.env.ENIGMA_RECALL_DIR;
    tenant.withTenant(join(root, "t1"), () => { expect(process.env.ENIGMA_RECALL_DIR).toBe(join(root, "t1", "recall")); });
    expect(process.env.ENIGMA_RECALL_DIR).toBe(before);
    expect(() => tenant.withTenant(join(root, "t2"), () => Promise.resolve(1))).toThrow(/synchronous/);
    expect(process.env.ENIGMA_RECALL_DIR).toBe(before);
});

test("a short or multi-line token file is refused at startup", () => {
    writeFileSync(join(root, "short"), "abc\n");
    expect(() => serveMod.readTokenFile(join(root, "short"))).toThrow(/shorter than/);
    writeFileSync(join(root, "two"), `${TOKEN}\n${TOKEN}\n`);
    expect(() => serveMod.readTokenFile(join(root, "two"))).toThrow(/one line/);
});

test("a rotated token file takes effect without a restart", async () => {
    const next = "n".repeat(40);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(root, "token"), `${next}\n`);
    expect((await call("/v1/stats")).status).toBe(401);
    expect((await call("/v1/stats", undefined, { token: next })).status).toBe(200);
    writeFileSync(join(root, "token"), `${TOKEN}\n`);
});
