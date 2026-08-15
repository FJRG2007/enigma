/**
 * Code-graph retrieval: ask (lexical rank blended with a graph walk), trace (callers and blast
 * radius), skeleton (signatures only), map (clusters, hubs, hotspots), grep (hits grouped by the
 * enclosing symbol) and the freshness report - all deterministic, in-process, no model or network.
 *
 * The store dir is pinned via ENIGMA_CODEGRAPH_DIR (and HOME/config via ENIGMA_CONFIG_HOME) BEFORE
 * import so nothing touches the real machine state.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-cgquery-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CODEGRAPH_DIR = join(HOME, "store");

const cg = await import("../src/codegraph");
const q = await import("../src/codegraph-query");
const fmt = await import("../src/codegraph-format");

// A small project with a real dependency chain: config -> session -> api, plus a test file and an
// unrelated module that shares vocabulary with the query (the lexical-collision case).
const PROJ = mkdtempSync(join(tmpdir(), "enigma-cgq-proj-"));
mkdirSync(join(PROJ, "src"), { recursive: true });
mkdirSync(join(PROJ, "tests"), { recursive: true });

writeFileSync(join(PROJ, "src", "config.ts"), [
    "export interface Settings { retryLimit: number; }",
    "",
    "export function readSettings(): Settings {",
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

writeFileSync(join(PROJ, "src", "unrelated.ts"), [
    "export function formatBanner(): string {",
    '    return "banner";',
    "}",
    "",
].join("\n"));

writeFileSync(join(PROJ, "tests", "session.test.ts"), [
    'import { refreshSessionToken } from "../src/session";',
    "",
    "export function testRefreshSessionToken(): void {",
    "    refreshSessionToken(\"a\");",
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

test("ask ranks the definition a task is about, above the test that exercises it", () => {
    const r = q.codeGraphAsk("refresh session token", base)!;
    expect(r.mode).toBe("lexical");
    expect(r.hits[0].name).toBe("refreshSessionToken");
    expect(r.hits[0].path).toBe("src/session.ts");
    const test_ = r.hits.findIndex((h) => h.path.startsWith("tests/"));
    expect(test_ === -1 || test_ > 0).toBe(true);
    // An unrelated module sharing no query vocabulary must not be pulled in.
    expect(r.hits.some((h) => h.name === "formatBanner")).toBe(false);
});

test("ask inlines the source of each hit only when asked to", () => {
    expect(q.codeGraphAsk("refresh session token", base)!.hits[0].code).toBeUndefined();
    const withSource = q.codeGraphAsk("refresh session token", { ...base, source: true })!;
    expect(withSource.hits[0].code).toContain("token.repeat");
    expect(withSource.saved!.files).toBeGreaterThan(0);
});

test("ask answers a wiring question from edges, not word overlap", () => {
    const r = q.codeGraphAsk("who calls refreshSessionToken", base)!;
    expect(r.mode).toBe("structural");
    expect(r.subject).toBe("refreshSessionToken");
    expect(r.hits.every((h) => h.kind === "caller")).toBe(true);
    expect(r.hits.some((h) => h.name === "handleRequest")).toBe(true);
});

test("ask narrows to a subtree with `in`, segment-aware", () => {
    const r = q.codeGraphAsk("refresh session token", { ...base, in: "tests" })!;
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.path.startsWith("tests/"))).toBe(true);
});

test("trace walks callers one level, and the blast radius further out", () => {
    const one = q.codeGraphTrace("refreshSessionToken", { ...base, depth: 1 })!;
    expect(one.matched[0].path).toBe("src/session.ts");
    expect(one.hits.some((h) => h.name === "handleRequest")).toBe(true);
    expect(one.hits.some((h) => h.name === "testRefreshSessionToken")).toBe(true);

    // readSettings reaches handleRequest only through session.ts, so it needs the second hop.
    const shallow = q.codeGraphTrace("readSettings", { ...base, depth: 1 })!;
    expect(shallow.hits.some((h) => h.name === "handleRequest")).toBe(false);
    const deep = q.codeGraphTrace("readSettings", { ...base, depth: 3 })!;
    expect(deep.hits.some((h) => h.name === "handleRequest")).toBe(true);
    // Every node is reported once, at the depth it was first reached.
    expect(new Set(deep.hits.map((h) => h.id)).size).toBe(deep.hits.length);
});

test("trace outward reports what a symbol depends on", () => {
    const out = q.codeGraphTrace("refreshSessionToken", { ...base, direction: "out", depth: 1 })!;
    expect(out.hits.some((h) => h.name === "readSettings")).toBe(true);
    expect(out.hits.some((h) => h.name === "handleRequest")).toBe(false);
});

test("trace says so plainly when the symbol does not exist", () => {
    const r = q.codeGraphTrace("noSuchSymbol", base)!;
    expect(r.hits).toEqual([]);
    expect(r.note).toContain("noSuchSymbol");
});

test("skeleton lists a file's signatures without its bodies", () => {
    const r = q.codeGraphSkeleton("src/session.ts", base)!;
    expect(r.entries.map((e) => e.name)).toContain("refreshSessionToken");
    expect(r.entries[0].signature).toContain("export function refreshSessionToken");
    expect(fmt.formatSkeleton(r)).not.toContain("token.repeat"); // the body never appears
    // A bare filename resolves when it is unambiguous.
    expect(q.codeGraphSkeleton("config.ts", base)!.file).toBe("src/config.ts");
});

test("map clusters directories and ranks hubs by what depends on them across files", () => {
    const r = q.codeGraphMap(base)!;
    expect(r.totals.files).toBe(5);
    expect(r.dirs.map((d) => d.path)).toContain("src");
    // readSettings and refreshSessionToken are imported by other files; formatBanner is not.
    expect(r.hotspots.some((h) => h.name === "refreshSessionToken")).toBe(true);
    expect(r.hotspots.some((h) => h.name === "formatBanner")).toBe(false);
});

test("grep groups hits by the enclosing symbol and names what it dropped", () => {
    const r = q.codeGraphGrep("retryLimit", base)!;
    expect(r.totalHits).toBeGreaterThanOrEqual(2);
    const inside = r.groups.find((g) => g.symbol?.name === "refreshSessionToken");
    expect(inside).toBeDefined();
    expect(inside!.hits[0].text).toContain("retryLimit");
    expect(r.truncated.hits).toBe(0);

    const capped = q.codeGraphGrep("token", { ...base, maxHits: 1 })!;
    expect(capped.totalHits).toBe(1);
    expect(capped.truncated.hits).toBeGreaterThan(0);
    expect(fmt.formatGrep(capped)).toContain("past the cap");
});

test("grep treats a pattern as a literal string when asked", () => {
    expect(q.codeGraphGrep("retryLimit: number", { ...base, fixed: true })!.totalHits).toBe(1);
    expect(q.codeGraphGrep("RETRYLIMIT", { ...base, ignoreCase: true })!.totalHits).toBeGreaterThan(0);
});

test("check reports drift without repairing it", () => {
    const clean = q.codeGraphCheck(PROJECT)!;
    expect(clean.stale).toBe(0);
    writeFileSync(join(PROJ, "src", "unrelated.ts"), "export function formatBanner(): string { return \"changed\"; }\n");
    const dirty = q.codeGraphCheck(PROJECT)!;
    expect(dirty.drift.changed).toContain("src/unrelated.ts");
    expect(fmt.formatFreshness(dirty)).toContain("drifted");
    // Still drifted: check is the report, so it must never have re-indexed behind our back.
    expect(q.codeGraphCheck(PROJECT)!.stale).toBe(1);
});

test("a query refreshes the graph first, so it describes the code as it is now", () => {
    writeFileSync(join(PROJ, "src", "added.ts"), "export function brandNewHelper(): number { return 1; }\n");
    expect(q.codeGraphAsk("brandNewHelper", { project: PROJECT, refresh: false })!.hits.some((h) => h.name === "brandNewHelper")).toBe(false);
    expect(q.codeGraphAsk("brandNewHelper", { project: PROJECT })!.hits.some((h) => h.name === "brandNewHelper")).toBe(true);
    expect(q.codeGraphCheck(PROJECT)!.stale).toBe(0);
});
