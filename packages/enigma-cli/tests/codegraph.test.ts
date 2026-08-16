/**
 * Native code graph: indexing a project extracts symbols (with their span and signature) and
 * imports per language, resolves intra-project import edges and symbol-to-symbol wiring, detects
 * drift by stat, and answers architecture/search/schema queries - all in-process, no external
 * tool. The store dir is pinned via ENIGMA_CODEGRAPH_DIR (and HOME/config via ENIGMA_CONFIG_HOME)
 * BEFORE import so nothing touches the real machine state.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";

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

test("module-path imports resolve to the project file they name, in every spelling of them", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-mods-"));
    mkdirSync(join(root, "src", "utils"), { recursive: true });
    mkdirSync(join(root, "src", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "utils", "basics.py"), "def helper():\n    return 1\n");
    writeFileSync(join(root, "src", "pkg", "__init__.py"), "def pkg_entry():\n    return 2\n");
    // Python writes its own modules as dotted paths and its siblings with leading dots - neither
    // of which starts with "./", the one form resolution used to understand.
    writeFileSync(join(root, "main.py"), "import os\nfrom src.utils.basics import helper\nfrom src.pkg import pkg_entry\n\ndef run():\n    return helper()\n");
    writeFileSync(join(root, "src", "sibling.py"), "from .utils.basics import helper\n\ndef near():\n    return helper()\n");
    // A bundler alias is the same problem wearing a different prefix.
    writeFileSync(join(root, "src", "aliased.ts"), 'import { thing } from "@/src/utils/lib";\nexport function useIt() { return thing(); }\n');
    writeFileSync(join(root, "src", "utils", "lib.ts"), "export function thing() { return 3; }\n");

    const entry = cg.indexProject(root);
    const graph = cg.loadGraph(entry.id)!;
    const edges = graph.importEdges.map(([from, to]) => `${from} -> ${to}`);
    expect(edges).toContain("main.py -> src/utils/basics.py");
    expect(edges).toContain("main.py -> src/pkg/__init__.py");
    expect(edges).toContain("src/sibling.py -> src/utils/basics.py");
    expect(edges).toContain("src/aliased.ts -> src/utils/lib.ts");
    // A module of the project's own is not a dependency of it: whatever resolves must leave the
    // external list, which is what the architecture view reports as the third-party surface.
    expect(Object.keys(graph.externalModules)).toContain("os");
    expect(Object.keys(graph.externalModules)).not.toContain("src.utils.basics");
    rmSync(root, { recursive: true, force: true });
});

test("a go import resolves through go.mod to every file of the package it names", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-go-"));
    mkdirSync(join(root, "internal", "store"), { recursive: true });
    writeFileSync(join(root, "go.mod"), "module github.com/acme/thing\n\ngo 1.22\n");
    writeFileSync(join(root, "main.go"), 'package main\n\nimport (\n\t"fmt"\n\t"github.com/acme/thing/internal/store"\n)\n\nfunc main() { fmt.Println(store.Load()) }\n');
    writeFileSync(join(root, "internal", "store", "load.go"), "package store\n\nfunc Load() string { return \"x\" }\n");
    writeFileSync(join(root, "internal", "store", "save.go"), "package store\n\nfunc Save(v string) {}\n");

    const entry = cg.indexProject(root);
    const graph = cg.loadGraph(entry.id)!;
    const targets = graph.importEdges.filter(([from]) => from === "main.go").map(([, to]) => to).sort();
    // An import binds the directory, so both files of the package are reachable from it.
    expect(targets).toEqual(["internal/store/load.go", "internal/store/save.go"]);
    expect(Object.keys(graph.externalModules)).toContain("fmt");
    rmSync(root, { recursive: true, force: true });
});

test("a stored graph from an older shape is re-indexed, never rendered as if current", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-vers-"));
    writeFileSync(join(root, "a.ts"), 'import { b } from "./b";\nexport function a() { return b(); }\n');
    writeFileSync(join(root, "b.ts"), "export function b() { return 1; }\n");
    const entry = cg.indexProject(root);
    const file = join(HOME, "store", `${entry.id}.json`);
    // Exactly what an install upgraded across a shape change finds on disk: the old fields, and
    // none of the ones this build reads. Rendering it reported an edgeless graph for a codebase
    // that has edges - a wrong answer indistinguishable from a real one.
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...stored, version: 1, edges: [], importEdges: [] }));

    const schema = cg.codeGraphSchema(entry.id)!;
    expect(schema.edges.CONTAINS).toBeGreaterThan(0);
    expect(cg.codeGraphArchitecture(entry.id)!.importEdges).toBe(1);
    expect(cg.loadGraph(entry.id)!.version).toBe(cg.GRAPH_VERSION);
    rmSync(root, { recursive: true, force: true });
});

const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;

test.skipIf(!HAS_GIT)("in a repository the scan indexes what git owns, not whatever sits in the tree", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-git-"));
    const git = (...args: string[]): void => { spawnSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true }); };
    git("init");
    mkdirSync(join(root, "data", "dump"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "data/\n");
    writeFileSync(join(root, "app.ts"), "export function app() { return 1; }\n");
    // A data or download directory beside the source is the case that made a 250-file project cost
    // 18 s per scan - and the scan runs on every drift probe, so that was per query.
    for (let i = 0; i < 40; i++) writeFileSync(join(root, "data", "dump", `gen${i}.ts`), `export function gen${i}() {}\n`);

    const scanned = cg.scanFiles(root);
    expect(scanned.files.map((f) => f.path)).toEqual(["app.ts"]);
    expect(scanned.truncated).toBe(false);
    rmSync(root, { recursive: true, force: true });
});

test("a project whose root is gone is dropped from the list and its graph deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-gone-"));
    writeFileSync(join(root, "a.ts"), "export function a() { return 1; }\n");
    const entry = cg.indexProject(root);
    expect(existsSync(join(HOME, "store", `${entry.id}.json`))).toBe(true);

    // Anything that indexes a temporary checkout leaves an entry behind - the quality gate runs in
    // a throwaway worktree, so every run left a project named after its run id and a graph nothing
    // would read again. A graph is derived, so dropping it costs a re-index and nothing else.
    rmSync(root, { recursive: true, force: true });
    expect(cg.listProjects().some((p) => p.id === entry.id)).toBe(false);
    expect(existsSync(join(HOME, "store", `${entry.id}.json`))).toBe(false);
    expect(existsSync(join(HOME, "store", `${entry.id}.bodies.json`))).toBe(false);
});

test("resolving a project for a hook never indexes on the caller's clock", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-cold-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "a.ts"), "export function a() { return 1; }\n");
    const before = cg.listProjects().length;
    // The per-prompt hook has 10 s between the user pressing enter and the model seeing the turn.
    // A cold index is seconds, and the host discards the output when the hook overruns - so the
    // lookup must answer "not indexed" instead of paying for one inline.
    expect(cg.findProjectForCwd(root)).toBeNull();
    expect(cg.listProjects().length).toBe(before);
    // The indexing variant is for callers that can afford it (the CLI, the MCP tools).
    expect(cg.ensureProjectForCwd(root)).toBeTruthy();
    expect(cg.findProjectForCwd(root)).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
});

test("enigma's own managed directory is never a project", () => {
    const worktree = join(HOME, ".enigma", "gate", "worktrees", "abc123", "01M04CKE0P0GTY1T5WM6BFGJ8D");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "a.ts"), "export function a() { return 1; }\n");
    // A gate run works in a throwaway checkout. Indexing it duplicated a repo the user already had
    // indexed, under a name that is a run id, and left ~25 MB behind when the worktree went.
    expect(() => cg.indexProject(worktree)).toThrow(/managed directory/);
    expect(cg.listProjects().some((p) => p.root === worktree)).toBe(false);
});

test("hotspots and entry points are ranked by what the rest of the project depends on", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-rank-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "shared.ts"), "export function sharedHelper() { return 1; }\n");
    // A local name used over and over inside its own file. Counting every reference put this kind
    // of name at the top of the panel, above the function half the codebase imports.
    writeFileSync(join(root, "src", "noisy.ts"), [
        "export function noisy() {",
        "    const localValue = 1;",
        ...Array.from({ length: 12 }, () => "    console.log(localValue);"),
        "    return localValue;",
        "}",
        "",
    ].join("\n"));
    writeFileSync(join(root, "src", "one.ts"), 'import { sharedHelper } from "./shared";\nexport function one() { return sharedHelper(); }\n');
    writeFileSync(join(root, "src", "two.ts"), 'import { sharedHelper } from "./shared";\nexport function two() { return sharedHelper(); }\n');
    writeFileSync(join(root, "main.ts"), 'import { one } from "./src/one";\nimport { two } from "./src/two";\nimport { noisy } from "./src/noisy";\nexport function run() { return one() + two() + noisy(); }\n');

    const entry = cg.indexProject(root);
    const arch = cg.codeGraphArchitecture(entry.id)!;
    const names = arch.hotspots.map((h) => h.name);
    expect(names).toContain("sharedHelper");
    expect(names).not.toContain("localValue");
    // main.ts pulls in the most, so it leads - not whichever path happens to sort first.
    expect(arch.entryPoints[0]).toBe("main.ts");
    rmSync(root, { recursive: true, force: true });
});

test("a name shared across two languages is a coincidence, not a reference", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-cg-lang-"));
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "core.ts"), "export function sharedName() { return 1; }\n");
    // Ruby cannot call a TypeScript function, but nothing in name-based resolution said so: on this
    // repo 9761 of 21232 cross-file edges pointed from one language at another, which is how a
    // vendored Ruby SDK came to own the hub list of a TypeScript monorepo.
    writeFileSync(join(root, "lib", "other.rb"), "def uses_it\n  sharedName\nend\n");
    // Same family though: a .mjs script importing a .ts module is a real dependency.
    writeFileSync(join(root, "script.mjs"), 'import { sharedName } from "./lib/core";\nexport function go() { return sharedName(); }\n');

    const entry = cg.indexProject(root);
    const edges = cg.loadGraph(entry.id)!.edges.filter(([, to, rel]) => to.startsWith("lib/core.ts#") && rel !== "contains");
    expect(edges.some(([from]) => from.startsWith("script.mjs"))).toBe(true);
    expect(edges.some(([from]) => from.startsWith("lib/other.rb"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
});
