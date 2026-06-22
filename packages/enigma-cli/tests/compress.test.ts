/**
 * Compression engine: SmartCrusher reduces a redundant JSON array while keeping
 * error rows, CCR makes the result reversible (retrieve restores the original
 * byte-for-byte), the detector routes content correctly, and safety rules leave
 * small/unique/code content untouched. Temp HOME (set BEFORE import) isolates the
 * CCR cache, since ccr.ts resolves ~/.enigma/ccr lazily per call.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-compress-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { compress, retrieve, readStats, readHistory, clearCcr } = await import("../src/compress");
const { detect } = await import("../src/compress/detect");
const { markerHash } = await import("../src/compress/ccr");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function rows(n: number): string {
    const arr = Array.from({ length: n }, (_, i) => ({ id: i, status: "ok", msg: "request handled", ms: 12 }));
    arr.push({ id: n, status: "error", msg: "upstream timeout", ms: 9000 });
    return JSON.stringify({ results: arr });
}

test("crushes a redundant JSON array and keeps the error row", () => {
    const original = rows(200);
    const r = compress(original);
    expect(r.contentType).toBe("json");
    expect(r.offloaded).toBeGreaterThan(100);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    // The error row survives the crush.
    expect(r.compressed).toContain("upstream timeout");
    expect(r.ccrHash).toBeTruthy();
});

test("CCR round-trips: retrieve restores the original exactly", () => {
    const original = rows(200);
    const r = compress(original);
    const hash = markerHash(r.compressed);
    expect(hash).toBe(r.ccrHash!);
    expect(retrieve(hash!)).toBe(original);
});

test("small input passes through unchanged", () => {
    const small = JSON.stringify({ ok: true });
    const r = compress(small);
    expect(r.compressed).toBe(small);
    expect(r.offloaded).toBe(0);
});

test("a short array of unique entities with no signal is not crushed", () => {
    const data = JSON.stringify(
        Array.from({ length: 8 }, (_, i) => ({ uuid: `id-${i}-${i * 97}`, name: `entity ${i}`, owner: `user${i}` })),
    );
    const r = compress(data);
    expect(r.offloaded).toBe(0);
    expect(r.compressed).toBe(data);
});

test("collapses repetitive logs but keeps error lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `2026-01-01T00:00:${String(i).padStart(2, "0")}Z INFO request handled in 12ms`);
    lines.splice(20, 0, "2026-01-01T00:00:20Z ERROR database connection refused");
    const r = compress(lines.join("\n"));
    expect(r.contentType).toBe("log");
    expect(r.offloaded).toBeGreaterThan(0);
    expect(r.compressed).toContain("ERROR database connection refused");
});

test("detector classifies common content types", () => {
    expect(detect('{"a":1}').type).toBe("json");
    expect(detect("function foo() { return 1; }").type).toBe("code");
    expect(detect("2026-01-01T00:00:00Z INFO started").type).toBe("log");
    expect(detect("diff --git a/x b/x\n@@ -1 +1 @@").type).toBe("diff");
    expect(detect("just some ordinary prose here").type).toBe("text");
});

test("code passes through (no blind lossy transform)", () => {
    const code = "function f() {\n" + "  doThing();\n".repeat(80) + "}\n";
    const r = compress(code);
    expect(r.contentType).toBe("code");
    expect(r.compressed).toBe(code);
    expect(r.offloaded).toBe(0);
});

test("records a per-content-type breakdown and the best single saving", () => {
    clearCcr();
    const r = compress(rows(200), { source: "cli" }); // a big JSON compression
    const s = readStats();
    expect(s.byType?.json).toBeDefined();
    expect(s.byType!.json!.tokensSaved).toBeGreaterThan(0);
    expect(s.best).toBe(r.tokensSaved); // single call -> best equals its saving
    // The history point carries source + content type for the recent-compressions table.
    const last = readHistory().at(-1)!;
    expect(last.s).toBe("cli");
    expect(last.c).toBe("json");
});

test("clearCcr wipes recorded data and resets the stats", () => {
    compress(rows(200));                        // record some stats + cache an original
    expect(readStats().calls).toBeGreaterThan(0);
    const { files } = clearCcr();
    expect(files).toBeGreaterThan(0);           // stats.json + history.jsonl + cache file(s)
    expect(readStats().calls).toBe(0);          // back to the empty baseline
});
