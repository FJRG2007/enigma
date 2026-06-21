/**
 * MCP server: the hand-rolled JSON-RPC handler must speak the initialize ->
 * tools/list -> tools/call handshake, expose the three enigma tools, compress on
 * demand, and round-trip through enigma_retrieve. Driven via the pure
 * handleMcpRequest (no real stdio). Temp HOME (set BEFORE import) isolates CCR.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-mcp-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { handleMcpRequest } = await import("../src/mcp");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const call = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
    handleMcpRequest({ jsonrpc: "2.0", id, method, params }, "9.9.9");

test("initialize advertises tools capability and server info", () => {
    const res = call("initialize", { protocolVersion: "2025-06-18" });
    expect(res?.result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: "enigma", version: "9.9.9" } });
});

test("notifications get no response", () => {
    expect(call("notifications/initialized", {}, null)).toBeNull();
});

test("tools/list returns the three enigma tools", () => {
    const res = call("tools/list");
    const names = ((res?.result as { tools: { name: string }[] }).tools).map((t) => t.name);
    expect(names).toEqual(["enigma_compress", "enigma_retrieve", "enigma_stats"]);
});

test("tools/call enigma_compress compresses and enigma_retrieve restores", () => {
    const arr: Record<string, unknown>[] = Array.from({ length: 200 }, (_, i) => ({ id: i, status: "ok", msg: "handled" }));
    arr.push({ id: 200, status: "error", msg: "connection refused" });
    const original = JSON.stringify({ results: arr });

    const comp = call("tools/call", { name: "enigma_compress", arguments: { content: original } });
    const text = (comp?.result as { content: { text: string }[] }).content[0]!.text;
    expect(text.length).toBeLessThan(original.length);
    const hash = text.match(/<<enigma:ccr:([0-9a-f]+) /)?.[1];
    expect(hash).toBeTruthy();

    const back = call("tools/call", { name: "enigma_retrieve", arguments: { hash } });
    expect((back?.result as { content: { text: string }[] }).content[0]!.text).toBe(original);
});

test("unknown method returns JSON-RPC method-not-found", () => {
    const res = call("does/notExist");
    expect(res?.error?.code).toBe(-32601);
});
