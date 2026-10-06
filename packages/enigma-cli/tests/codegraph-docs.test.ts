/**
 * Docs, schemas and config in the code graph; edge provenance; functional areas and the repo
 * report a session starts with. Store and home are pinned to temp dirs BEFORE import.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-codegraph-docs-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CODEGRAPH_DIR = join(HOME, "store");

const cg = await import("../src/codegraph");
const { extractDocFile } = await import("../src/codegraph-extract-docs");
const { clusterFiles } = await import("../src/codegraph-cluster");
const { codeGraphReport, formatReport } = await import("../src/codegraph-report");
const { parityReport } = await import("../src/verify-parity");
const { scanFiles } = await import("../src/codegraph-extract");

const PROJ = mkdtempSync(join(tmpdir(), "enigma-cg-docs-proj-"));
const write = (rel: string, text: string): void => {
    mkdirSync(join(PROJ, rel, ".."), { recursive: true });
    writeFileSync(join(PROJ, rel), text);
};
write("src/auth/session.ts", "import { hashToken } from \"./crypto\";\nexport function refreshSession(t: string) { return hashToken(t); }\n");
write("src/auth/crypto.ts", "export function hashToken(t: string) { return t; }\n");
write("src/billing/invoice.ts", "import { taxFor } from \"./tax\";\nexport function buildInvoice() { return taxFor(1); }\n");
write("src/billing/tax.ts", "export function taxFor(n: number) { return n; }\n");
write("lib/legacy.rb", "def legacy_total\n  1\nend\n");
write("lib/caller.rb", "def use_it\n  legacy_total\nend\n");
write("docs/auth.md", "# Auth\n\nSessions are renewed by `refreshSession`; see [crypto](../src/auth/crypto.ts).\n\n## Details\n\nThe word buildInvoice in prose is not a link.\n\n#### Deep heading\n\n```md\n# not a heading\n```\n");
write("README.md", "# Demo project\n");
write("db/schema.sql", "CREATE TABLE users (\n  id serial primary key\n);\nCREATE TABLE orders (\n  user_id int REFERENCES users(id)\n);\nCREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\n");
write("docker-compose.yml", "version: \"3\"\nservices:\n  web:\n    image: app\n  db:\n    image: postgres\n");
write("vendor/sdk/README.md", "# Somebody else's SDK\n");

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJ, { recursive: true, force: true });
    delete process.env.ENIGMA_CODEGRAPH_DIR;
    delete process.env.ENIGMA_CONFIG_HOME;
});

test("markdown: sections to level 3, spans to the next heading, fenced headings ignored, relative links kept", () => {
    const md = "# A\n\ntext [x](./b.md#part) [web](https://example.com)\n\n## B\n\n#### C\n\n```\n# fenced\n```\n# D\n";
    const out = extractDocFile("markdown", md);
    expect(out.symbols.map((s) => [s.name, s.kind, s.line, s.endLine])).toEqual([["A", "section", 1, 11], ["B", "section", 5, 11], ["D", "section", 12, 12]]);
    expect(out.imports).toEqual(["./b.md"]);
});

test("sql, prisma, yaml and toml become tables, keys and functions with real spans", () => {
    const sql = extractDocFile("sql", "CREATE TABLE IF NOT EXISTS public.\"users\" (\n id int\n);\nCREATE FUNCTION f() AS $$\nselect 1;\n$$;\n");
    expect(sql.symbols.map((s) => [s.name, s.kind, s.line, s.endLine])).toEqual([["users", "table", 1, 3], ["f", "function", 4, 6]]);
    const prisma = extractDocFile("prisma", "model User {\n  id Int\n}\nenum Role {\n  ADMIN\n}\n");
    expect(prisma.symbols.map((s) => [s.name, s.kind])).toEqual([["User", "table"], ["Role", "enum"]]);
    const yaml = extractDocFile("yaml", "name: ci\njobs:\n  build:\n    runs-on: x\n  test:\n    steps:\n      - run: y\n");
    expect(yaml.symbols.map((s) => s.signature)).toEqual(["name: ci", "jobs:", "jobs.build", "jobs.test"]);
    const toml = extractDocFile("toml", "[package]\nname = \"x\"\n[[bin]]\nname = \"y\"\n");
    expect(toml.symbols.map((s) => [s.name, s.endLine])).toEqual([["package", 2], ["bin", 4]]);
});

test("docs link and name code; prose does not; schemas reference each other; provenance is recorded", () => {
    cg.indexProject(PROJ);
    const graph = cg.loadGraph(PROJ)!;
    const nodes = new Map(cg.graphNodes(graph).map((n) => [n.id, n]));
    const edge = (fromPath: string, toName: string) => graph.edges.find((e) => e[2] !== "contains" && nodes.get(e[0])?.path === fromPath && nodes.get(e[1])?.name === toName);
    // A markdown link is an import of the file it points at.
    expect(graph.importEdges).toContainEqual(["docs/auth.md", "src/auth/crypto.ts"]);
    // `refreshSession` in inline code binds to the one definition with that name, marked inferred.
    const mention = edge("docs/auth.md", "refreshSession");
    expect(mention?.[2]).toBe("references");
    expect(mention?.[3]).toBe(1);
    // The same name in plain prose is a coincidence, never an edge.
    expect(edge("docs/auth.md", "buildInvoice")).toBeUndefined();
    // A foreign key names its table.
    expect(edge("db/schema.sql", "users")?.[2]).toBe("references");
    // An import that binds the name is read, not guessed; a Ruby name match is a guess.
    expect(edge("src/auth/session.ts", "hashToken")?.[3]).toBeUndefined();
    expect(edge("lib/caller.rb", "legacy_total")?.[3]).toBe(1);
    // Somebody else's docs stay out; their code would not.
    expect(graph.files.some((f) => f.path.startsWith("vendor/"))).toBe(false);
    expect(graph.files.find((f) => f.path === "docker-compose.yml")?.symbols.map((s) => s.name)).toEqual(["version", "services", "web", "db"]);
});

test("clustering splits two dense groups joined by a weak link, deterministically", () => {
    const links: [string, string, number][] = [["a", "b", 3], ["b", "c", 3], ["a", "c", 3], ["x", "y", 3], ["y", "z", 3], ["x", "z", 3], ["c", "x", 1]];
    const first = clusterFiles(["z", "a", "b", "c", "x", "y", "solo"], links);
    expect(first.get("a")).toBe(first.get("c"));
    expect(first.get("x")).toBe(first.get("z"));
    expect(first.get("a")).not.toBe(first.get("x"));
    expect([...clusterFiles(["solo", "y", "x", "c", "b", "a", "z"], links)]).toEqual([...first]);
});

test("the report names areas by their code, attaches docs by what they mention, and lists the project's notes", () => {
    const r = codeGraphReport({ project: PROJ, refresh: false })!;
    const labels = r.areas.map((a) => a.label);
    expect(labels).toContain("src/auth/");
    expect(labels).toContain("src/billing/");
    expect(r.areas.find((a) => a.label === "src/auth/")?.docs).toEqual(["docs/auth.md"]);
    expect(r.docs.map((d) => d.path)).toEqual(["README.md", "docs/auth.md"]);
    expect(r.docs[0].title).toBe("Demo project");
    const text = formatReport(r);
    expect(text).toContain("repo report");
    expect(text.length).toBeLessThan(4000);
});

test("a parity check counts code only", () => {
    const target = mkdtempSync(join(tmpdir(), "enigma-cg-docs-target-"));
    try {
        for (const rel of ["src/auth/session.ts", "src/auth/crypto.ts", "src/billing/invoice.ts", "src/billing/tax.ts", "lib/legacy.rb", "lib/caller.rb"]) {
            mkdirSync(join(target, rel, ".."), { recursive: true });
            writeFileSync(join(target, rel), require("node:fs").readFileSync(join(PROJ, rel), "utf8"));
        }
        const report = parityReport(PROJ, target);
        expect(report.absent).toEqual([]);
        expect(report.coverage).toBe(100);
    } finally {
        rmSync(target, { recursive: true, force: true });
    }
});

test("without git, a docs-heavy tree does not push source out of the walk", () => {
    const tree = mkdtempSync(join(tmpdir(), "enigma-cg-docs-walk-"));
    try {
        for (let i = 0; i < 8100; i++) writeFileSync(join(tree, `note-${i}.md`), "# Note\n");
        mkdirSync(join(tree, "src"));
        writeFileSync(join(tree, "src", "main.ts"), "export function main(): void {}\n");
        const { files } = scanFiles(tree);
        expect(files.some((f) => f.path === "src/main.ts")).toBe(true);
    } finally {
        rmSync(tree, { recursive: true, force: true });
    }
}, 60_000);
