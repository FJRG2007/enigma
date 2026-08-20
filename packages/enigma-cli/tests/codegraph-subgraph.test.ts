/**
 * The drawable slice of the code graph: seeding (ranked overview, file/import overview, a focus),
 * the induced edge set, the node cap, the hidden-neighbour count, and the DOT rendering.
 *
 * The store dir is pinned via ENIGMA_CODEGRAPH_DIR (and HOME/config via ENIGMA_CONFIG_HOME) BEFORE
 * import so nothing touches the real machine state.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-cgsub-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CODEGRAPH_DIR = join(HOME, "store");

const cg = await import("../src/codegraph");
const sub = await import("../src/codegraph-subgraph");
const fmt = await import("../src/codegraph-format");

// A chain deep enough to tell depth 1 from depth 2 apart: api -> session -> config, with a second
// consumer of the hub so it outranks everything else on cross-file in-degree.
const PROJ = mkdtempSync(join(tmpdir(), "enigma-cgsub-proj-"));
mkdirSync(join(PROJ, "src"), { recursive: true });

writeFileSync(join(PROJ, "src", "config.ts"), [
    "export function readSettings(): { retryLimit: number; } {",
    "    return { retryLimit: 3 };",
    "}",
    "",
].join("\n"));

writeFileSync(join(PROJ, "src", "session.ts"), [
    'import { readSettings } from "./config";',
    "",
    "export function refreshSessionToken(token: string): string {",
    "    const settings = readSettings();",
    "    return token.repeat(settings.retryLimit);",
    "}",
    "",
].join("\n"));

writeFileSync(join(PROJ, "src", "api.ts"), [
    'import { refreshSessionToken } from "./session";',
    "",
    "export function handleRequest(token: string): string {",
    "    return refreshSessionToken(token);",
    "}",
    "",
].join("\n"));

writeFileSync(join(PROJ, "src", "worker.ts"), [
    'import { readSettings } from "./config";',
    "",
    "export function runWorker(): number {",
    "    return readSettings().retryLimit;",
    "}",
    "",
].join("\n"));

writeFileSync(join(PROJ, "src", "island.ts"), [
    "export function formatBanner(): string {",
    '    return "banner";',
    "}",
    "",
].join("\n"));

const PROJECT = cg.indexProject(PROJ).id;
const base = { project: PROJECT, refresh: false };

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJ, { recursive: true, force: true });
    delete process.env.ENIGMA_CODEGRAPH_DIR;
    delete process.env.ENIGMA_CONFIG_HOME;
});

test("an unfocused slice is seeded by what the rest of the codebase depends on", () => {
    const r = sub.codeGraphSubgraph(base)!;
    expect(r.focus).toBeNull();
    expect(r.scope).toBe("symbols");
    const seeds = r.nodes.filter((n) => n.depth === 0).map((n) => n.name);
    expect(seeds).toContain("readSettings");
    expect(r.totals.files).toBe(5);
});

test("a focus centres the slice and reports what it resolved to", () => {
    const r = sub.codeGraphSubgraph({ ...base, focus: "refreshSessionToken" })!;
    expect(r.focus!.map((f) => f.name)).toEqual(["refreshSessionToken"]);
    const names = r.nodes.map((n) => n.name);
    expect(names).toContain("refreshSessionToken");
    // One hop reaches both sides at once - a neighbourhood is not a direction.
    expect(names).toContain("handleRequest");
    expect(names).toContain("readSettings");
    expect(names).not.toContain("formatBanner");
});

test("depth widens the neighbourhood and records the hop each node was reached at", () => {
    const one = sub.codeGraphSubgraph({ ...base, focus: "handleRequest", depth: 1 })!;
    expect(one.nodes.map((n) => n.name)).not.toContain("readSettings");
    const two = sub.codeGraphSubgraph({ ...base, focus: "handleRequest", depth: 2 })!;
    const reached = new Map(two.nodes.map((n) => [n.name, n.depth]));
    expect(reached.get("handleRequest")).toBe(0);
    expect(reached.get("refreshSessionToken")).toBe(1);
    expect(reached.get("readSettings")).toBe(2);
});

test("a node id resolves to exactly that node, without re-running name resolution", () => {
    const byName = sub.codeGraphSubgraph({ ...base, focus: "readSettings" })!;
    const id = byName.focus![0].id;
    expect(id).toContain("#");
    const byId = sub.codeGraphSubgraph({ ...base, focus: id })!;
    expect(byId.focus!.map((f) => f.id)).toEqual([id]);
});

test("edges are induced, so a cross-link between two kept nodes is drawn", () => {
    const r = sub.codeGraphSubgraph({ ...base, focus: "readSettings", depth: 2 })!;
    const kept = new Set(r.nodes.map((n) => n.id));
    // Nothing may point at a node the slice does not carry, or the picture draws a dangling line.
    expect(r.edges.every((e) => kept.has(e.source) && kept.has(e.target))).toBe(true);
    const named = new Map(r.nodes.map((n) => [n.id, n.name]));
    const pairs = r.edges.map((e) => `${named.get(e.source)}->${named.get(e.target)}`);
    expect(pairs).toContain("refreshSessionToken->readSettings");
    expect(pairs).toContain("handleRequest->refreshSessionToken");
});

test("neighbours left outside the slice are counted, never silently dropped", () => {
    const r = sub.codeGraphSubgraph({ ...base, focus: "readSettings", depth: 1, limit: 2 })!;
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(2);
    expect(r.nodes.some((n) => n.hidden > 0)).toBe(true);
});

test("a hidden neighbour is one expanding could actually reveal, never a symbol's own file", () => {
    // Wide enough to reach the whole fixture, so anything still counted as hidden is a phantom.
    // Every symbol has a `contains` edge from its file, and the walk never crosses one: counting
    // it would badge every node in every symbol slice with a "+" that adds nothing.
    const r = sub.codeGraphSubgraph({ ...base, focus: "readSettings", depth: 3 })!;
    expect(r.nodes.length).toBeGreaterThan(3);
    expect(r.nodes.every((n) => n.hidden === 0)).toBe(true);
});

test("hidden is the whole-graph neighbour count minus what the slice draws", () => {
    const r = sub.codeGraphSubgraph({ ...base, focus: "readSettings", depth: 1 })!;
    const kept = new Set(r.nodes.map((n) => n.id));
    for (const n of r.nodes) {
        const drawn = r.edges.filter((e) => (e.source === n.id) || (e.target === n.id && e.relation !== "contains")).length;
        expect(n.neighbours).toBe(drawn + n.hidden);
        expect(kept.has(n.id)).toBe(true);
    }
});

test("the cap binds the seeds too, and says so when it does", () => {
    // A file seed carries every symbol it defines, which is how a request for one node used to
    // answer with a whole file's worth and still report itself complete.
    const r = sub.codeGraphSubgraph({ ...base, focus: "src/config.ts", limit: 1 })!;
    expect(r.nodes.length).toBe(1);
    expect(r.focus!.map((f) => f.path)).toEqual(["src/config.ts"]);
    expect(r.truncated).toBe(true);
    expect(r.nodes[0].hidden).toBeGreaterThan(0);
});

test("an overview that dropped ranked seeds reports truncated, not just the walk", () => {
    const r = sub.codeGraphSubgraph({ ...base, limit: 3 })!;
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(3);
});

test("the file scope stays the import graph when a focus is given", () => {
    // The result labels itself `scope: "files"`, so it has to BE the file graph - a symbol slice
    // under a file label makes the scope control a no-op the moment the focus box is filled.
    const r = sub.codeGraphSubgraph({ ...base, scope: "files", focus: "readSettings" })!;
    expect(r.scope).toBe("files");
    expect(r.nodes.every((n) => n.kind === "file")).toBe(true);
    expect(r.edges.every((e) => e.relation === "imports")).toBe(true);
    // A symbol focus centres on the file it lives in, and says so rather than reporting a symbol
    // no edge in this pool could reach.
    expect(r.focus!.map((f) => f.path)).toEqual(["src/config.ts"]);
    expect(r.nodes.map((n) => n.path)).toContain("src/worker.ts");
});

test("the file scope draws the import graph, with file nodes on both ends", () => {
    const r = sub.codeGraphSubgraph({ ...base, scope: "files" })!;
    expect(r.nodes.every((n) => n.kind === "file")).toBe(true);
    expect(r.edges.every((e) => e.relation === "imports")).toBe(true);
    const named = new Map(r.nodes.map((n) => [n.id, n.path]));
    expect(r.edges.map((e) => `${named.get(e.source)}->${named.get(e.target)}`)).toContain("src/session.ts->src/config.ts");
});

test("--in narrows the slice to one subtree", () => {
    const r = sub.codeGraphSubgraph({ ...base, in: "src", focus: "readSettings" })!;
    expect(r.nodes.every((n) => n.path.startsWith("src/"))).toBe(true);
    expect(sub.codeGraphSubgraph({ ...base, in: "nowhere", focus: "readSettings" })!.nodes).toEqual([]);
});

test("a focus that resolves to nothing says so instead of drawing the overview", () => {
    const r = sub.codeGraphSubgraph({ ...base, focus: "noSuchSymbol" })!;
    expect(r.nodes).toEqual([]);
    expect(r.focus).toEqual([]);
    expect(r.note).toContain("noSuchSymbol");
});

test("an unindexed project answers null rather than an empty picture", () => {
    expect(sub.codeGraphSubgraph({ project: "no-such-project", refresh: false })).toBeNull();
});

test("DOT carries every node and edge, with quotes and backslashes escaped", () => {
    const r = sub.codeGraphSubgraph({ ...base, focus: "refreshSessionToken" })!;
    const dot = sub.subgraphToDot(r);
    expect(dot.startsWith("digraph ")).toBe(true);
    expect(dot.trimEnd().endsWith("}")).toBe(true);
    expect(dot.split("\n").filter((l) => l.includes(" -> ")).length).toBe(r.edges.length);
    for (const n of r.nodes) expect(dot).toContain(`"${n.id}"`);
    // A signature full of quotes must not close the tooltip attribute early.
    expect(/tooltip="[^"]*(\\")?[^"]*"/.test(dot)).toBe(true);
});

test("the text rendering states both caps and never rounds a real share down to nothing", () => {
    const capped = sub.codeGraphSubgraph({ ...base, focus: "readSettings", limit: 2 })!;
    const text = fmt.formatSubgraph(capped);
    expect(text).toContain("TRUNCATED");
    expect(text).not.toContain("- 0% of the graph's wiring");
});

test("the share is read against the edge population the scope draws from", () => {
    // A file slice carries import edges only; measuring it against the symbol graph's total
    // reports a complete picture as a fraction of itself.
    const r = sub.codeGraphSubgraph({ ...base, scope: "files" })!;
    expect(r.edges.length).toBe(r.totals.importEdges);
    expect(r.totals.importEdges).toBeLessThan(r.totals.edges);
    expect(fmt.formatSubgraph(r)).toContain("100% of the graph's wiring");
});
