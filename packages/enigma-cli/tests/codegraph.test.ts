/**
 * Native code graph: indexing a project extracts symbols and imports per language, resolves
 * intra-project import edges, counts cross-file references, and answers architecture/search/schema
 * queries - all in-process, no external tool. The store dir is pinned via ENIGMA_CODEGRAPH_DIR (and
 * HOME/config via ENIGMA_CONFIG_HOME) BEFORE import so nothing touches the real machine state.
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
    expect(s.edges.REFERENCES).toBeGreaterThanOrEqual(1);
});

test("re-indexing the same root does not duplicate the project; reset clears the store", () => {
    cg.indexProject(PROJ);
    expect(cg.listProjects().length).toBe(1);
    cg.resetCodeGraph();
    expect(cg.listProjects().length).toBe(0);
});
