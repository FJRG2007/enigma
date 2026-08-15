/**
 * Native code graph: indexing a project extracts symbols (with their span and signature) and
 * imports per language, resolves intra-project import edges and symbol-to-symbol wiring, detects
 * drift by stat, and answers architecture/search/schema queries - all in-process, no external
 * tool. The store dir is pinned via ENIGMA_CODEGRAPH_DIR (and HOME/config via ENIGMA_CONFIG_HOME)
 * BEFORE import so nothing touches the real machine state.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-codegraph-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CODEGRAPH_DIR = join(HOME, "store");

const cg = await import("../src/codegraph");

// A tiny multi-language project to index.
const PROJ = mkdtempSync(join(tmpdir(), "enigma-cg-proj-"));
mkdirSync(join(PROJ, "src"), { recursive: true });
mkdirSync(join(PROJ, "node_modules", "junk"), { recursive: true });
writeFileSync(join(PROJ, "src", "util.ts"), "export function helper(x: number) { return x + 1; }\nexport class Widget {}\n");
writeFileSync(join(PROJ, "src", "index.ts"), 'import { helper, Widget } from "./util";\nimport fs from "node:fs";\nexport function main() { return helper(new Widget() ? 1 : 2); }\n');
writeFileSync(join(PROJ, "app.py"), "import os\ndef run():\n    return 1\nclass Thing:\n    pass\n");
writeFileSync(join(PROJ, "node_modules", "junk", "x.ts"), "export function shouldBeIgnored() {}\n");

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJ, { recursive: true, force: true });
    delete process.env.ENIGMA_CODEGRAPH_DIR;
    delete process.env.ENIGMA_CONFIG_HOME;
});

test("indexing extracts symbols + imports and skips ignored dirs", () => {
    const entry = cg.indexProject(PROJ);
    expect(entry.files).toBe(3);                       // util.ts, index.ts, app.py (node_modules ignored)
    expect(entry.symbols).toBeGreaterThanOrEqual(5);   // helper, Widget, main, run, Thing
    const projects = cg.listProjects();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe(entry.name);
});

test("search finds symbols by name and kind", () => {
    const byName = cg.searchGraph(undefined, { name: "helper" });
    expect(byName.some((h) => h.name === "helper" && h.kind === "function" && h.file === "src/util.ts")).toBe(true);
    const classes = cg.searchGraph(undefined, { kind: "class" });
    expect(classes.map((h) => h.name).sort()).toEqual(["Thing", "Widget"]);
    // Python def and class are picked up too.
    expect(cg.searchGraph(undefined, { name: "run" }).some((h) => h.file === "app.py")).toBe(true);
});

test("architecture reports languages, entry points, hotspots and external deps", () => {
    const a = cg.codeGraphArchitecture()!;
    expect(a).not.toBeNull();
    expect(a.languages.ts).toBe(2);
    expect(a.languages.python).toBe(1);
    expect(a.entryPoints).toContain("src/index.ts");   // no file imports index.ts + it matches /index\./
    // helper/Widget are referenced by index.ts -> they appear as hotspots.
    expect(a.hotspots.some((h) => h.name === "helper")).toBe(true);
    // node:fs is an unresolved (external) import.
    expect(a.externalModules.some((m) => m.name === "node:fs")).toBe(true);
});

test("schema counts nodes and edges", () => {
    const s = cg.codeGraphSchema()!;
    expect(s.nodes.File).toBe(3);
    expect(s.nodes.Function).toBeGreaterThanOrEqual(2);
    expect(s.nodes.Class).toBeGreaterThanOrEqual(2);
    expect(s.edges.IMPORTS).toBeGreaterThanOrEqual(1); // index.ts -> util.ts resolved
    expect(s.edges.CONTAINS).toBeGreaterThanOrEqual(5);
    expect((s.edges.CALLS ?? 0) + (s.edges.REFERENCES ?? 0)).toBeGreaterThanOrEqual(1);
});

test("symbols carry a full span and a signature, not just a declaration line", () => {
    const graph = cg.loadGraph()!;
    const util = graph.files.find((f) => f.path === "src/util.ts")!;
    const helper = util.symbols.find((s) => s.name === "helper")!;
    expect(helper.line).toBe(1);
    expect(helper.endLine).toBe(1);                     // whole definition fits on its own line
    expect(helper.signature).toContain("export function helper");
    const py = graph.files.find((f) => f.path === "app.py")!;
    const run = py.symbols.find((s) => s.name === "run")!;
    expect(run.endLine).toBeGreaterThan(run.line);      // indentation-scoped body
});

test("a definition is not swallowed by a brace inside a regex literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-cg-span-"));
    writeFileSync(join(dir, "a.ts"), [
        "export function withRegex() {",
        "    return /^[^;{)]*\\{/.test(\"x\");",
        "}",
        "export function after() {",
        "    return 2;",
        "}",
        "",
    ].join("\n"));
    cg.indexProject(dir);
    const graph = cg.loadGraph()!;
    const syms = graph.files.find((f) => f.path === "a.ts")!.symbols;
    // Without sibling clamping the unbalanced brace runs `withRegex` to the end of the file and
    // every later symbol is reported as living inside it.
    expect(syms.find((s) => s.name === "withRegex")!.endLine).toBeLessThan(4);
    rmSync(dir, { recursive: true, force: true });
});

test("a private class member does not end a definition early", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-cg-hash-"));
    writeFileSync(join(dir, "a.ts"), [
        "export class Store {",
        "    #items = new Map();",
        "    has(key: string) {",
        "        if (this.#items.has(key)) {",
        "            return true;",
        "        }",
        "        return false;",
        "    }",
        "}",
        "export function after() {",
        "    return 2;",
        "}",
        "",
    ].join("\n"));
    cg.indexProject(dir);
    const syms = cg.loadGraph()!.files.find((f) => f.path === "a.ts")!.symbols;
    // `#` is a private member here, not a comment: stopping the scan at it drops the `{` that
    // opens the if-block, and the class then closes a whole block early.
    expect(syms.find((s) => s.name === "Store")!.endLine).toBe(9);
    rmSync(dir, { recursive: true, force: true });
});

test("a cross-file reference needs a real import binding, not just a shared name", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-cg-bind-"));
    writeFileSync(join(dir, "lib.ts"), "export function collect() { return 1; }\nexport function unused() { return 2; }\n");
    // Imports lib.ts, but binds only `collect`. Its own local `unused` must NOT bind to lib's.
    writeFileSync(join(dir, "app.ts"), [
        'import { collect } from "./lib";',
        "export function run() {",
        "    const unused = 5;",
        "    return collect() + unused;",
        "}",
        "",
    ].join("\n"));
    cg.indexProject(dir);
    const graph = cg.loadGraph()!;
    // `contains` is structural (lib.ts holds both symbols); only the dependency edges are the claim.
    const edges = graph.edges.filter(([, target, rel]) => target.startsWith("lib.ts#") && rel !== "contains");
    expect(edges.some(([source, target]) => source === "app.ts#run" && target === "lib.ts#collect")).toBe(true);
    expect(edges.some(([, target]) => target === "lib.ts#unused")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
});

test("a query from a subdirectory indexes the project root, not the subdirectory", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-root-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "caller.ts"), 'import { target } from "./deep/inner";\nexport function outer() { return target(); }\n');
    writeFileSync(join(root, "src", "deep", "inner.ts"), "export function target() { return 1; }\n");
    const cwd = process.cwd();
    process.chdir(join(root, "src", "deep"));
    try {
        const id = cg.ensureProjectForCwd();
        // Indexing the working directory alone would build a graph blind to `outer`, which is
        // precisely the caller a question asked from here needs to find.
        expect(cg.loadGraph(id)!.files.some((f) => f.path === "src/caller.ts")).toBe(true);
    } finally {
        process.chdir(cwd);
        rmSync(root, { recursive: true, force: true });
    }
});

test("drift is detected by stat alone and cleared by re-indexing", () => {
    cg.indexProject(PROJ);
    const before = cg.probeDrift(cg.loadGraph(cg.listProjects().find((p) => p.root === PROJ)!.id)!);
    expect(cg.isCleanDrift(before)).toBe(true);
    writeFileSync(join(PROJ, "src", "extra.ts"), "export function added() {}\n");
    const id = cg.listProjects().find((p) => p.root === PROJ)!.id;
    const after = cg.probeDrift(cg.loadGraph(id)!);
    expect(after.added).toContain("src/extra.ts");
    expect(cg.driftCount(after)).toBe(1);
    rmSync(join(PROJ, "src", "extra.ts"), { force: true });
});

test("re-indexing the same root does not duplicate the project; reset clears the store", () => {
    const roots = new Set(cg.listProjects().map((p) => p.root));
    cg.indexProject(PROJ);
    expect(cg.listProjects().filter((p) => p.root === PROJ).length).toBe(1);
    expect(cg.listProjects().length).toBe(roots.size);
    cg.resetCodeGraph();
    expect(cg.listProjects().length).toBe(0);
});
