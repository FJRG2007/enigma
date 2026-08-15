/**
 * MCP server: the hand-rolled JSON-RPC handler must speak the initialize ->
 * tools/list -> tools/call handshake, expose the always-on compress tools plus whichever
 * toggled families are enabled, compress on demand, and round-trip through enigma_retrieve.
 * Driven via the pure handleMcpRequest (no real stdio). Temp HOME (set BEFORE import) isolates
 * CCR and pins the config, so the advertised set is the defaults', not the developer's.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-mcp-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { handleMcpRequest, clientNameOf } = await import("../src/mcp");
const { readStats } = await import("../src/compress");

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    delete process.env.ENIGMA_CONFIG_HOME;
});

const call = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
    handleMcpRequest({ jsonrpc: "2.0", id, method, params }, "9.9.9");

test("initialize advertises tools capability and server info", () => {
    const res = call("initialize", { protocolVersion: "2025-06-18" });
    expect(res?.result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: "enigma", version: "9.9.9" } });
});

test("notifications get no response", () => {
    expect(call("notifications/initialized", {}, null)).toBeNull();
});

test("tools/list advertises the compress tools plus the code graph, which is on by default", () => {
    const res = call("tools/list");
    const names = ((res?.result as { tools: { name: string; }[]; }).tools).map((t) => t.name);
    expect(names.slice(0, 3)).toEqual(["enigma_compress", "enigma_retrieve", "enigma_stats"]);
    // The code-graph family rides the same server and defaults to on; recall stays opt-in, so its
    // tools must NOT be here. A tool advertised for a disabled feature is a tool that errors.
    expect(names).toContain("enigma_codegraph_ask");
    expect(names.some((n) => n.startsWith("enigma_recall"))).toBe(false);
});

test("tools/call enigma_compress compresses and enigma_retrieve restores", () => {
    const arr: Record<string, unknown>[] = Array.from({ length: 200 }, (_, i) => ({ id: i, status: "ok", msg: "handled" }));
    arr.push({ id: 200, status: "error", msg: "connection refused" });
    const original = JSON.stringify({ results: arr });

    const comp = call("tools/call", { name: "enigma_compress", arguments: { content: original } });
    const text = (comp?.result as { content: { text: string; }[]; }).content[0]!.text;
    expect(text.length).toBeLessThan(original.length);
    const hash = text.match(/<<enigma:ccr:([0-9a-f]+) /)?.[1];
    expect(hash).toBeTruthy();

    const back = call("tools/call", { name: "enigma_retrieve", arguments: { hash } });
    expect((back?.result as { content: { text: string; }[]; }).content[0]!.text).toBe(original);
});

test("unknown method returns JSON-RPC method-not-found", () => {
    const res = call("does/notExist");
    expect(res?.error?.code).toBe(-32601);
});

test("clientNameOf reads the initialize clientInfo name", () => {
    expect(clientNameOf({ method: "initialize", params: { clientInfo: { name: "claude-code", version: "1" } } })).toBe("claude-code");
    expect(clientNameOf({ method: "initialize", params: {} })).toBeUndefined();
});

test("a compress call is attributed to the connection's client source", () => {
    const arr: Record<string, unknown>[] = Array.from({ length: 200 }, (_, i) => ({ id: i, status: "ok", msg: "handled" }));
    arr.push({ id: 200, status: "error", msg: "connection refused" });
    const content = JSON.stringify({ results: arr });
    // The server loop passes the captured client name as the 3rd arg.
    handleMcpRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "enigma_compress", arguments: { content } } }, "9.9.9", "opencode");
    const stats = readStats();
    expect(stats.bySource?.opencode).toBeDefined();
    expect(stats.bySource!.opencode!.calls).toBeGreaterThanOrEqual(1);
    expect(stats.bySource!.opencode!.tokensSaved).toBeGreaterThan(0);
});
