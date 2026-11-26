/**
 * Convention checks, the catalog: parsing and bounding untrusted check files, layering built-in,
 * user and project sources, turning a check off, and picking the checks a changed file needs.
 * HOME is a temp dir, set BEFORE the imports.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-checks-home-"));
process.env.ENIGMA_CONFIG_HOME = HOME;

const checks = await import("../../src/checks");

const REPO = mkdtempSync(join(tmpdir(), "enigma-checks-repo-"));
afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(REPO, { recursive: true, force: true });
    delete process.env.ENIGMA_CONFIG_HOME;
});

const file = (name: string, extra = "", body = "The rule.\nFails: x.\nPasses: y."): string =>
    `---\nname: ${name}\ndescription: ${name} description\nfiles: ["*.tsx"]\n${extra}---\n\n${body}\n`;

test("a valid check parses with its globs, prefilter and severity", () => {
    const c = checks.parseCheck(file("my-check", "exclude: *.test.*, **/tests/**\nwhen: <pre|textarea\nseverity: warn\n"), "project", "x.md")!;
    expect(c.name).toBe("my-check");
    expect(c.files).toEqual(["*.tsx"]);
    expect(c.exclude).toEqual(["*.test.*", "**/tests/**"]);
    expect(c.when?.test("<pre>")).toBe(true);
    expect(c.severity).toBe("warn");
});

test("malformed, oversized, unnamed or disabled files are dropped, not trusted", () => {
    expect(checks.parseCheck("no frontmatter", "project", "x")).toBeNull();
    expect(checks.parseCheck(file("Bad Name"), "project", "x")).toBeNull();
    expect(checks.parseCheck(file("ok", "when: (unclosed\n"), "project", "x")).toBeNull();
    expect(checks.parseCheck(file("ok", "enabled: false\n"), "project", "x")).toBeNull();
    expect(checks.parseCheck(file("ok", "", "x".repeat(9000)), "project", "x")).toBeNull();
    expect(checks.parseCheck(file("ok", "", ""), "project", "x")).toBeNull();
});

test("a missing files list covers every file, like Continue's checks", () => {
    const c = checks.parseCheck("---\nname: any\ndescription: d\n---\nbody\n", "project", "x")!;
    expect(checks.anyCheckFor([c], "deep/dir/a.py")).toBe(true);
});

test("sources layer by name: project replaces user replaces built-in, and enabled:false removes one", () => {
    const builtins = checks.loadChecks(null);
    expect(builtins.map((c) => c.name)).toContain("code-highlighting");
    expect(builtins.map((c) => c.name)).toContain("live-state");
    // A navigation list is not a data table: the table check is not even sent for one.
    const table = builtins.find((c) => c.name === "data-view-affordances")!;
    expect(checks.applicableChecks([table], "src/DmList.tsx", "{chats.map((c) => <li key={c.id}>{c.name}</li>)}")).toHaveLength(0);
    expect(checks.applicableChecks([table], "src/Orders.tsx", "<table><thead><tr><th>Id</th></tr></thead></table>")).toHaveLength(1);
    mkdirSync(checks.userChecksDir(), { recursive: true });
    writeFileSync(join(checks.userChecksDir(), "code-highlighting.md"), file("code-highlighting", "", "User version."));
    expect(checks.loadChecks(null).find((c) => c.name === "code-highlighting")?.source).toBe("user");
    mkdirSync(join(REPO, ".agents", "checks"), { recursive: true });
    writeFileSync(join(REPO, ".agents", "checks", "off.md"), "---\nname: code-highlighting\ndescription: d\nenabled: false\n---\nx\n");
    writeFileSync(join(REPO, ".agents", "checks", "mine.md"), file("project-rule"));
    const project = checks.loadChecks(REPO).map((c) => c.name);
    expect(project).not.toContain("code-highlighting");
    expect(project).toContain("project-rule");
});

test("a file gets only the checks its path, exclusions and added lines call for", () => {
    const c = checks.parseCheck(file("hl", "exclude: *.test.*\nwhen: <pre\n"), "builtin", "x")!;
    expect(checks.applicableChecks([c], "src/A.tsx", "<pre>{code}</pre>")).toHaveLength(1);
    expect(checks.applicableChecks([c], "src/A.tsx", "<span/>")).toHaveLength(0);
    expect(checks.applicableChecks([c], "src/A.test.tsx", "<pre>")).toHaveLength(0);
    expect(checks.applicableChecks([c], "src/a.py", "<pre>")).toHaveLength(0);
});

test("a rendered proposal loads back as a check", () => {
    const text = checks.renderCheck({ name: "x-rule", description: "d", files: ["*.ts"], when: "fetch\\(", body: "Rule." });
    expect(checks.parseCheck(text, "user", "x")?.when?.test("fetch(url)")).toBe(true);
});

test("the forms-on-demand check is sent for a view with a form, not for a plain list", () => {
    const forms = checks.loadChecks(null).find((c) => c.name === "forms-on-demand")!;
    expect(forms).toBeDefined();
    expect(checks.applicableChecks([forms], "src/Hosts.tsx", "<form onSubmit={handleSubmit(add)}><Input name=\"address\" /></form>")).toHaveLength(1);
    // Generated forms often skip <form>: an input and a button wired with onClick.
    expect(checks.applicableChecks([forms], "src/Hosts.tsx", "<Input value={address} onChange={setAddress} /><Button onClick={add}>Add</Button>")).toHaveLength(1);
    expect(checks.applicableChecks([forms], "src/Hosts.tsx", "<InputGroup />{hosts.map((h) => <li key={h.id}>{h.name}</li>)}")).toHaveLength(0);
    expect(checks.applicableChecks([forms], "src/Hosts.test.tsx", "<form onSubmit={add} />")).toHaveLength(0);
});
