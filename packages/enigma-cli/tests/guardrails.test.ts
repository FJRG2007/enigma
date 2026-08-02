/**
 * Guardrails engine: file-scope regex rules (UUID primary keys), project-scope checks
 * (Prisma as the default ORM), glob matching, custom/disabled rules from the config, and
 * the severity split. Temp HOME + ENIGMA_GUARDRAILS_CONFIG (set BEFORE import) isolate the
 * config file so the test never touches the real ~/.enigma-guardrails.json.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-guardrails-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const CONFIG = join(HOME, "guardrails.json");
process.env.ENIGMA_GUARDRAILS_CONFIG = CONFIG;

const { checkFile, checkPath, applyFixes, formatFindings, loadRules, findProjectRoot, recordFindings, readLedger, countLedger, summarizeLedger, BUILTIN_RULES } = await import("../src/guardrails");
const { disableRule, enableRule, addRule, removeRule } = await import("../src/guardrails-config");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));
beforeEach(() => rmSync(CONFIG, { force: true }));

test("does not flag a truncating flex item, which already shrinks", () => {
    // Measured in a browser before this test existed: a flex item's automatic minimum size
    // only applies while its computed overflow is visible, and `truncate` sets overflow:hidden,
    // so these all size correctly and must never be reported (an earlier rule flagged them).
    for (const markup of [
        '<div className="flex-1 truncate">{name}</div>',
        '<div className="truncate flex-auto">{name}</div>',
        '<span class="px-2 flex-1 text-sm truncate">{v}</span>',
    ]) expect(checkFile("src/Row.tsx", markup, null)).toEqual([]);
});

test("flags an ellipsis that cannot take effect, and only that", () => {
    const broken = ".name { text-overflow: ellipsis; white-space: nowrap; }";
    const fixed = ".name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }";
    const f = checkFile("src/app.css", broken, null);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe("fe-ellipsis-without-overflow");
    expect(checkFile("src/app.css", fixed, null)).toEqual([]);
});

test("flags every explicit auto-increment identity signal", () => {
    const cases = [
        "id SERIAL PRIMARY KEY",
        "id BIGSERIAL",
        "id INT NOT NULL AUTO_INCREMENT",
        "id INT IDENTITY(1,1)",
        "id bigint GENERATED ALWAYS AS IDENTITY",
        "id Int @id @default(autoincrement())",
    ];
    for (const line of cases) {
        const f = checkFile("db/migrations/001.sql", line, null);
        expect(f.length).toBe(1);
        expect(f[0]!.ruleId).toBe("db-uuid-pk");
        expect(f[0]!.severity).toBe("block");
        expect(f[0]!.line).toBe(1);
    }
});

test("flags a TypeORM auto-generated integer PK but not a uuid one", () => {
    expect(checkFile("src/entities/user.entity.ts", "@PrimaryGeneratedColumn()", null).length).toBe(1);
    expect(checkFile("src/entities/user.entity.ts", '@PrimaryGeneratedColumn("uuid")', null)).toEqual([]);
});

test("does not flag UUID keys or a plain INTEGER PRIMARY KEY", () => {
    expect(checkFile("db/x.sql", "id UUID PRIMARY KEY DEFAULT gen_random_uuid()", null)).toEqual([]);
    expect(checkFile("db/x.sql", "id INTEGER PRIMARY KEY", null)).toEqual([]); // enigma's own recall store uses this
    expect(checkFile("schema.prisma", "id String @id @default(uuid())", null)).toEqual([]);
    expect(checkFile("db/x.sql", "SET IDENTITY_INSERT dbo.T ON", null)).toEqual([]);
});

test("only scans files whose path matches a rule glob", () => {
    // A random source file is not a schema/migration - the UUID rule must not apply.
    expect(checkFile("src/app.ts", "const AUTO_INCREMENT = 1;", null)).toEqual([]);
    // Basename globs match at the repo root too, not only nested paths.
    expect(checkFile("schema.sql", "id SERIAL PRIMARY KEY", null).length).toBe(1);
});

test("project check flags a TS+relational project without Prisma, and clears with Prisma", () => {
    const proj = mkdtempSync(join(tmpdir(), "gr-proj-"));
    const pkg = (deps: Record<string, string>) => writeFileSync(join(proj, "package.json"), JSON.stringify({ dependencies: deps, devDependencies: { typescript: "^5" } }));
    pkg({ typeorm: "^0.3" });
    const flagged = checkFile(join(proj, "package.json"), "{}", proj);
    expect(flagged.some((f) => f.ruleId === "db-ts-orm-prisma" && f.severity === "warn")).toBe(true);

    pkg({ typeorm: "^0.3", "@prisma/client": "^5" });
    expect(checkFile(join(proj, "package.json"), "{}", proj).some((f) => f.ruleId === "db-ts-orm-prisma")).toBe(false);
    rmSync(proj, { recursive: true, force: true });
});

test("project rules skip when there is no project root", () => {
    expect(checkFile("package.json", "{}", null)).toEqual([]);
});

test("a custom JSON rule is applied", () => {
    addRule({ id: "no-select-star", label: "No SELECT *", files: ["*.sql"], scope: "file", pattern: "select\\s+\\*", flags: "i", message: "Avoid SELECT * on hot paths.", severity: "warn" });
    const f = checkFile("q.sql", "SELECT * FROM users", null);
    expect(f.some((x) => x.ruleId === "no-select-star")).toBe(true);
    removeRule("no-select-star");
    expect(checkFile("q.sql", "SELECT * FROM users", null)).toEqual([]);
});

test("a disabled built-in rule is skipped, and re-enabling restores it", () => {
    disableRule("db-uuid-pk");
    expect(loadRules().some((r) => r.id === "db-uuid-pk")).toBe(false);
    expect(checkFile("db/x.sql", "id SERIAL PRIMARY KEY", null)).toEqual([]);
    enableRule("db-uuid-pk");
    expect(checkFile("db/x.sql", "id SERIAL PRIMARY KEY", null).length).toBe(1);
});

test("a malformed custom rule is ignored, never thrown", () => {
    writeFileSync(CONFIG, JSON.stringify({ rules: [{ id: "bad" }], disabled: ["db-uuid-pk"] }));
    // The bad rule is dropped; the disabled built-in still applies.
    expect(() => loadRules()).not.toThrow();
    expect(loadRules().every((r) => r.id !== "bad")).toBe(true);
});

test("checkPath reads a real file and finds violations", () => {
    const file = join(HOME, "m.sql");
    writeFileSync(file, "CREATE TABLE t (\n  id SERIAL PRIMARY KEY\n);\n");
    const f = checkPath(file);
    expect(f.length).toBe(1);
    expect(f[0]!.line).toBe(2);
});

test("formatFindings labels block vs warn", () => {
    const out = formatFindings([
        { ruleId: "a", severity: "block", file: "x.sql", line: 3, message: "m", skill: "database-expert" },
        { ruleId: "b", severity: "warn", file: "y", message: "n" },
    ]);
    expect(out).toContain("MUST FIX x.sql:3 (a) [database-expert]: m");
    expect(out).toContain("SUGGESTED y (b): n");
});

test("flags a blank/spinner loading guard without a skeleton, but not when a skeleton is present", () => {
    // Whole-component guard returns null -> blank until data resolves. It BLOCKS: as a warn it
    // exited 0 and was never fed back to the model, which is why the defect kept shipping.
    expect(checkFile("src/Panel.tsx", "if (isLoading) return null;", null).some((x) => x.ruleId === "fe-skeleton-loading" && x.severity === "block")).toBe(true);
    // A bare spinner for the whole component also flags.
    expect(checkFile("src/Panel.tsx", "if (loading) return <Spinner/>;", null).some((x) => x.ruleId === "fe-skeleton-loading")).toBe(true);
    // A skeleton anywhere in the file clears it (absent mechanism).
    expect(checkFile("src/Panel.tsx", "if (isLoading) return null;\nfunction Row(){ return <Skeleton/>; }", null).some((x) => x.ruleId === "fe-skeleton-loading")).toBe(false);
    // Returning an actual skeleton is the correct pattern - never flagged.
    expect(checkFile("src/Panel.tsx", "if (isLoading) return <CardSkeleton/>;", null).some((x) => x.ruleId === "fe-skeleton-loading")).toBe(false);
    // Other placeholder libs also clear it (react-content-loader, a <Placeholder> component).
    expect(checkFile("src/Panel.tsx", "if (isLoading) return null;\nimport ContentLoader from 'react-content-loader';", null).some((x) => x.ruleId === "fe-skeleton-loading")).toBe(false);
    expect(checkFile("src/Panel.tsx", "if (loading) return null;\nreturn <Placeholder as={Card}/>;", null).some((x) => x.ruleId === "fe-skeleton-loading")).toBe(false);
});

test("flags an HTML document missing the viewport meta, but not one that has it", () => {
    expect(checkFile("index.html", "<html>\n<head>\n<title>x</title>\n</head>", null).some((x) => x.ruleId === "fe-viewport-meta" && x.severity === "warn")).toBe(true);
    // Present anywhere in the file -> skipped.
    expect(checkFile("index.html", "<head>\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n</head>", null).some((x) => x.ruleId === "fe-viewport-meta")).toBe(false);
    // A fragment with no <head> is not a full document -> never flagged.
    expect(checkFile("card.html", "<div class=\"card\">hi</div>", null).some((x) => x.ruleId === "fe-viewport-meta")).toBe(false);
});

test("viewport rule never flags email/print docs (cross-stack false-positive guard)", () => {
    // An email template legitimately has a <head> and no viewport - Outlook conditional / mso- / reset are the tell.
    expect(checkFile("welcome.html", "<head>\n<!--[if mso]><style>td{font-family:Arial}</style><![endif]-->\n</head>", null).some((x) => x.ruleId === "fe-viewport-meta")).toBe(false);
    expect(checkFile("receipt.html", "<head><style>.x{mso-line-height-rule:exactly}</style></head>", null).some((x) => x.ruleId === "fe-viewport-meta")).toBe(false);
    // Files under an email/pdf/print tree are excluded outright.
    expect(checkFile("src/emails/welcome.html", "<head><title>hi</title></head>", null).some((x) => x.ruleId === "fe-viewport-meta")).toBe(false);
    expect(checkFile("server/pdf/invoice.html", "<head><title>inv</title></head>", null).some((x) => x.ruleId === "fe-viewport-meta")).toBe(false);
});

test("flags hand-rolled AI chat UI, and never an RBAC role check", () => {
    const hit = (file: string, src: string) => checkFile(file, src, null).some((x) => x.ruleId === "fe-ai-elements-chat");
    // Branching on an assistant message role in JSX is chat rendering.
    expect(checkFile("src/Chat.tsx", "{m.role === \"assistant\" ? <Bubble/> : <User/>}", null).some((x) => x.ruleId === "fe-ai-elements-chat" && x.severity === "warn")).toBe(true);
    expect(hit("src/Chat.jsx", "if (message.role === 'assistant') return <Md text={message.content}/>;")).toBe(true);
    // RBAC vocabulary must never match - this is why the rule keys on "assistant" alone.
    for (const role of ["user", "admin", "owner", "member"]) {
        expect(hit("src/Nav.tsx", `if (user.role === "${role}") return <AdminMenu/>;`)).toBe(false);
    }
    // Already using AI Elements (or another chat kit) -> nothing to suggest.
    expect(hit("src/Chat.tsx", "import { Message } from \"@/components/ai-elements/message\";\n{m.role === \"assistant\" && <Message/>}")).toBe(false);
    expect(hit("src/Chat.tsx", "import { Thread } from \"@assistant-ui/react\";\n{m.role === \"assistant\" && <Thread/>}")).toBe(false);
    // Non-JSX and build output are out of scope.
    expect(hit("src/api/route.ts", "if (m.role === \"assistant\") tokens += n;")).toBe(false);
    expect(hit("apps/_build/x/Chat.tsx", "{m.role === \"assistant\" && <Bubble/>}")).toBe(false);
});

test("flags a typographic dash in UI copy, never one the code is handling", () => {
    // Built from their code points so this file stays ASCII; the content passed to checkFile
    // holds the real U+2014 / U+2013.
    const EM = String.fromCharCode(0x2014);
    const EN = String.fromCharCode(0x2013);
    const hit = (file: string, src: string) => checkFile(file, src, null).some((x) => x.ruleId === "ui-no-em-dash");
    // Copy a person reads, in markup and in the module that holds the strings.
    expect(checkFile("src/Card.tsx", `<p>Saves tokens ${EM} automatically</p>`, null).some((x) => x.ruleId === "ui-no-em-dash" && x.severity === "block")).toBe(true);
    expect(hit("src/copy.ts", `export const EMPTY = "No results ${EM} try another filter";`)).toBe(true);
    expect(hit("index.html", `<h1>Fast ${EN} and quiet</h1>`)).toBe(true);
    // Code that HANDLES the character is data, not copy - never flagged.
    expect(hit("src/clean.ts", `const s = raw.replace(/${EM}/g, "-");`)).toBe(false);
    expect(hit("src/text.ts", `export const normalizeDashes = (s: string) => s.split("${EM}").join("-");`)).toBe(false);
    expect(hit("src/entities.ts", `const mdash = "${EM}";`)).toBe(false);
    expect(hit("src/ascii.ts", `if (ch === String.fromCharCode(0x2014)) out += "${EM}";`)).toBe(false);
    // A developer note is not UI copy: the engine only skips a line that STARTS as a comment,
    // so a trailing one is excluded here. A URL keeps its slashes without silencing the line.
    expect(hit("src/pool.ts", `const web = toWeb(res); // one stream ${EM} one consumer`)).toBe(false);
    expect(hit("src/Link.tsx", `<a href="https://x.dev">Read the guide ${EM} it is short</a>`)).toBe(true);
    // Both escape hatches: a marked line, and a file-wide opt-out for quoted text.
    expect(hit("src/Quote.tsx", `<blockquote>{"To be ${EM} or not"}</blockquote> // enigma: verbatim quote`)).toBe(false);
    expect(hit("src/Quote.tsx", `// enigma:allow-dash - verbatim source text\nexport const q = "To be ${EM} or not";`)).toBe(false);
    // The standalone glyph is a symbol, not copy: an empty-cell placeholder, a separator or a
    // CLI bullet stays untouched. This is what keeps the rule quiet on real UI code.
    expect(hit("src/table.tsx", `const cell = (v) => v ?? "${EM}";`)).toBe(false);
    expect(hit("src/Row.tsx", `<span className="muted">${EM}</span>`)).toBe(false);
    expect(hit("src/log.ts", `out(\`  \${yellow("${EN}")} \${label}\`);`)).toBe(false);
    // A plain hyphen is the correct form, and prose files/tests/build output are out of scope.
    expect(hit("src/Card.tsx", "<p>Saves tokens - automatically</p>")).toBe(false);
    expect(hit("docs/guide.md", `Saves tokens ${EM} automatically`)).toBe(false);
    expect(hit("src/__tests__/Card.test.tsx", `<p>x ${EM} y</p>`)).toBe(false);
    expect(hit("apps/dist/main.js", `t("x ${EM} y")`)).toBe(false);
});

test("flags an agent memory file over its context budget, and only that file kind", () => {
    const big = `# notes\n${"a".repeat(45_000)}`;
    const f = checkFile("CLAUDE.md", big, null);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe("ctx-memory-budget");
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.message).toContain("45008 bytes");
    expect(checkFile("docs/notes/dashboard.md", big, null)).toEqual([]);
    expect(checkFile("CLAUDE.md", "# notes\nan index, not a knowledge base\n", null)).toEqual([]);
});

test("flags a wide named import of a project module, and points at the module and the count", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`).join(", ");
    const f = checkFile("src/registry.ts", `import { ${names(10)} } from "./config";\n`, null);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe("ts-import-namespace");
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.line).toBe(1);
    expect(f[0]!.message).toContain('10 bindings from "./config"');
    // The budget is the whole file's use of that module, so splitting the statement does not dodge it.
    const split = `import { ${names(5)} } from "./config";\nimport type { A, B, C, D, E } from "./config";\n`;
    expect(checkFile("src/registry.ts", split, null).map((x) => x.ruleId)).toEqual(["ts-import-namespace"]);
    // Nor does spreading the list over several lines.
    expect(checkFile("src/registry.ts", `import {\n    ${names(10).replace(/, /g, ",\n    ")}\n} from "./db";\n`, null).length).toBe(1);
    // A path alias is still the project's own module.
    expect(checkFile("src/registry.ts", `import { ${names(10)} } from "@/lib/config";\n`, null).length).toBe(1);
});

test("leaves imports that are already fine, and honours the deliberate exception", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`).join(", ");
    // At the budget, not over it.
    expect(checkFile("src/a.ts", `import { ${names(9)} } from "./config";\n`, null)).toEqual([]);
    // The fix.
    expect(checkFile("src/a.ts", `import * as conf from "./config";\n`, null)).toEqual([]);
    // A bare specifier is a fixed surface the ecosystem writes as named imports.
    expect(checkFile("src/a.ts", `import { ${names(12)} } from "node:fs";\n`, null)).toEqual([]);
    expect(checkFile("src/a.ts", `import { ${names(12)} } from "@clack/prompts";\n`, null)).toEqual([]);
    // Escape hatch on the import line, and generated/declaration files stay out of scope.
    expect(checkFile("src/a.ts", `import { ${names(10)} } from "./gen"; // enigma: generated surface\n`, null)).toEqual([]);
    expect(checkFile("src/types.d.ts", `import { ${names(10)} } from "./config";\n`, null)).toEqual([]);
    expect(checkFile("dist/bundle.js", `import { ${names(10)} } from "./config";\n`, null)).toEqual([]);
});

test("flags a spawn that can pop a console window on Windows", () => {
    const src = 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["log"], { encoding: "utf8" });\n';
    const f = checkFile("src/repo.ts", src, null);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe("proc-windows-hide");
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.line).toBe(2);
    expect(f[0]!.message).toContain("execFileSync");
    // The options object is read by balancing parens, so a call spanning lines is judged whole.
    const multiline = 'import { execFile } from "node:child_process";\nexecFile(\n    name,\n    args,\n    { signal, encoding: "utf8" },\n    cb\n);\n';
    expect(checkFile("src/gh.ts", multiline, null).map((x) => x.ruleId)).toEqual(["proc-windows-hide"]);
    // A rename is still the same function.
    const aliased = 'import { spawnSync as run } from "node:child_process";\nrun("git", ["log"], { encoding: "utf8" });\n';
    expect(checkFile("src/repo.ts", aliased, null).length).toBe(1);
});

test("never flags a spawn that is fine, deliberate, or unknowable", () => {
    const head = 'import { spawn, spawnSync, execFile } from "node:child_process";\n';
    for (const call of [
        "spawnSync('git', ['log'], { encoding: 'utf8', windowsHide: true });",       // the fix
        "spawn(bin, args, { stdio: 'inherit', env });",                              // runs in the user's terminal
        "spawn(bin, args, opts);",                                                   // options come from a variable
        "spawn(bin, args, { ...spawnOpts, env });",                                  // the spread may carry it
        "spawn(bin, args, { detached: true, windowsHide: false });",                 // deliberately visible
        "spawn(bin, args, { detached: true }); // enigma: opens a terminal on purpose",
    ]) expect(checkFile("src/a.ts", `${head}${call}\n`, null)).toEqual([]);
    // Only bindings imported from child_process count, so these two common shapes stay quiet.
    expect(checkFile("src/a.ts", `const RE = /x/g;\nRE.exec(s);\ndb.exec({ a: 1 });\n`, null)).toEqual([]);
    // A test runs in a terminal that already has a console, so it is out of scope.
    const bad = `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["log"], { encoding: "utf8" });\n`;
    expect(checkFile("tests/repo.test.ts", bad, null)).toEqual([]);
});

test("the shell renders while only the waiting region is a placeholder", () => {
    // The correct shape the blocking rule exists to push toward: the component returns its
    // layout on the first tick and the skeleton stands in for the missing rows alone.
    const shell = "export function Panel() {\n    return <Table header={<Th/>} rows={isLoading ? <RowSkeleton /> : rows} />;\n}\n";
    expect(checkFile("src/Panel.tsx", shell, null)).toEqual([]);
});

test("flags an icon that will be squashed by the text beside it", () => {
    // The reported shape: a flex row whose label is long and whose icon carries a size but no guard.
    const row = '<a class="flex items-center gap-2 text-sm text-primary" href="/x">Monitor Samsung Odyssey Neo G95NC 57"<svg class="lucide lucide-external-link h-3.5 w-3.5"><path d="M15 3h6v6"/></svg></a>';
    const f = checkFile("src/Row.tsx", row, null);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe("fe-icon-shrink");
    expect(f[0]!.severity).toBe("block");
    // A component tag counts as the icon, and a stylesheet rule sizing one is the same defect.
    expect(checkFile("src/Row.tsx", '<div className="flex items-center gap-2"><ExternalLink className="h-4 w-4" /><span>{name}</span></div>', null).map((x) => x.ruleId)).toEqual(["fe-icon-shrink"]);
    expect(checkFile("src/app.css", ".achip svg { width: 14px; height: 14px; display: block; }", null).map((x) => x.ruleId)).toEqual(["fe-icon-shrink"]);
});

test("never flags an icon that is pinned, or a picture that should shrink", () => {
    for (const [file, markup] of [
        // The fix, in both styling models.
        ["src/Row.tsx", '<div className="flex items-center gap-2"><ExternalLink className="h-4 w-4 shrink-0" /><span className="truncate">{name}</span></div>'],
        ["src/app.css", ".achip svg { width: 14px; height: 14px; flex-shrink: 0; }"],
        // A picture at 640px is not an icon: pinning it would break the responsive sizing.
        ["src/app.css", ".hero img { width: 640px; height: 320px; }"],
        // Not an icon element, and not in a flex row.
        ["src/app.css", ".chart canvas { width: 32px; }"],
        ["src/Row.tsx", '<div className="grid gap-2"><Card className="h-4 w-4" /></div>'],
        ["src/Row.tsx", '<CheckIcon className="size-3.5" />'],
        // The escape hatch and a commented-out rule.
        ["src/Row.tsx", '<div className="flex"><Icon className="h-4 w-4" /></div> {/* enigma: shrinks on purpose */}'],
        ["src/app.css", "/* .achip svg { width: 14px; } was the old rule */"],
    ] as [string, string][]) expect(checkFile(file, markup, null)).toEqual([]);
    // A file that already pins an icon anywhere has made the decision; the base rule is the fix.
    const guarded = "svg { flex-shrink: 0; }\n.achip svg { width: 14px; height: 14px; }\n";
    expect(checkFile("src/app.css", guarded, null)).toEqual([]);
});

// --- TypeScript module graph (path alias, import extensions, modern resolution) --------
//
// These three rules are decided against the project's tsconfig, not the edited line, so each
// test builds a real project on disk. `id` keeps every project in its own directory, which also
// keeps the engine's per-directory tsconfig cache from carrying one test's answer into the next.
let projectId = 0;
function project(tsconfig: string, files: Record<string, string> = {}): string {
    const root = join(HOME, `proj-${++projectId}`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), tsconfig);
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    return root;
}

const BUNDLER = '{ "compilerOptions": { "target": "es2022", "module": "esnext", "moduleResolution": "bundler" } }';
const ALIASED = '{ "compilerOptions": { "target": "es2022", "moduleResolution": "bundler", "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }';

test("flags a module specifier carrying a file extension, and says what to write instead", () => {
    const root = project(BUNDLER);
    const f = checkFile(join(root, "src/client.ts"), 'import { compress } from "./compress.js";\n', root);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe("ts-import-extension");
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.line).toBe(1);
    expect(f[0]!.message).toContain('"./compress.js" -> "./compress"');
    // A TypeScript extension gets no file-system pass: the source file always exists under that
    // name, so the existence guard would silence the very shape the rule is for.
    const tsx = checkFile(join(root, "src/main.tsx"), 'import App from "./App.tsx";\n', root);
    expect(tsx.map((x) => x.ruleId)).toEqual(["ts-import-extension"]);
});

test("never flags an extension that is required or real", () => {
    // Node's own ESM resolution: the extension is mandatory there, so flagging it would be wrong.
    const nodenext = project('{ "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext" } }');
    expect(checkFile(join(nodenext, "src/a.ts"), 'import { b } from "./b.js";\n', nodenext)).toEqual([]);
    // A real JS module imported from TS: the extension IS the file's name.
    const root = project(BUNDLER, { "src/legacy.js": "export const x = 1;\n" });
    expect(checkFile(join(root, "src/a.ts"), 'import { x } from "./legacy.js";\n', root)).toEqual([]);
    // A non-module asset keeps its extension, and a bare specifier is never a relative import.
    expect(checkFile(join(root, "src/a.ts"), 'import s from "./table.css";\nimport z from "zod";\n', root)).toEqual([]);
    // The escape hatch, and a declaration file is out of scope.
    expect(checkFile(join(root, "src/a.ts"), 'import { b } from "./b.js"; // enigma: emitted by tsc\n', root)).toEqual([]);
    expect(checkFile(join(root, "src/a.d.ts"), 'import { b } from "./b.js";\n', root)).toEqual([]);
});

test("flags a deep relative import when the project declares an alias covering it", () => {
    const root = project(ALIASED);
    const f = checkFile(join(root, "src/gate/pipeline/steps/ci.ts"), 'import { open } from "../../db";\n', root);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe("ts-alias-deep-relative");
    expect(f[0]!.severity).toBe("block");
    // The suggestion resolves against the importing file, so it points at src/gate/db - not src/db.
    expect(f[0]!.message).toContain('"../../db" -> "@/gate/db"');
});

test("leaves a relative import that is right, or that the alias cannot express", () => {
    const root = project(ALIASED);
    const file = join(root, "src/gate/pipeline/steps/ci.ts");
    // A sibling and a parent say "this belongs with me", which is information worth keeping.
    expect(checkFile(file, 'import { a } from "./common";\nimport { b } from "../types";\n', root)).toEqual([]);
    // The fix.
    expect(checkFile(file, 'import { open } from "@/gate/db";\n', root)).toEqual([]);
    // Climbing out of the aliased root: there is no alias to write instead.
    expect(checkFile(file, 'import { s } from "../../../../scripts/seed";\n', root)).toEqual([]);
    // Escape hatch, test files, and a project with no alias at all.
    expect(checkFile(file, 'import { open } from "../../db"; // enigma: keeps the codemod honest\n', root)).toEqual([]);
    expect(checkFile(join(root, "tests/gate/db.test.ts"), 'import { open } from "../../src/gate/db";\n', root)).toEqual([]);
    const plain = project(BUNDLER);
    expect(checkFile(join(plain, "src/a/b/c.ts"), 'import { open } from "../../db";\n', plain)).toEqual([]);
});

test("flags a TypeScript project that declares no path alias", () => {
    const root = project(BUNDLER);
    const cfg = join(root, "tsconfig.json");
    const f = checkFile(cfg, readFileSync(cfg, "utf8"), root);
    expect(f.map((x) => x.ruleId)).toEqual(["ts-alias-paths"]);
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.message).toContain("no alias for ./src");
    // Declared, inherited from a base config, or nothing to alias: all clear.
    const aliased = project(ALIASED);
    expect(checkFile(join(aliased, "tsconfig.json"), readFileSync(join(aliased, "tsconfig.json"), "utf8"), aliased)).toEqual([]);
    expect(checkFile(cfg, '{ "extends": "astro/tsconfigs/strict" }', root)).toEqual([]);
    expect(checkFile(join(HOME, "docs/tsconfig.json"), BUNDLER, HOME)).toEqual([]);
    // The split config a bundler generates compiles one config file and is not in scope.
    expect(checkFile(join(root, "tsconfig.node.json"), BUNDLER, root)).toEqual([]);
});

test("flags a legacy module resolution or target, and only those", () => {
    // A config with no source tree beside it, so only the resolution rule can speak here.
    const cfg = join(HOME, "standalone/tsconfig.json");
    const legacy = '{\n  "compilerOptions": {\n    "moduleResolution": "node",\n    "target": "es2022"\n  }\n}';
    const f = checkFile(cfg, legacy, null);
    expect(f.map((x) => x.ruleId)).toEqual(["ts-legacy-module-resolution"]);
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.line).toBe(3);
    expect(checkFile(cfg, '{ "compilerOptions": { "target": "es5" } }', null).map((x) => x.ruleId)).toEqual(["ts-legacy-module-resolution"]);
    // The two modern answers, and the deliberate exception.
    expect(checkFile(cfg, '{ "compilerOptions": { "moduleResolution": "bundler", "target": "es2022" } }', null)).toEqual([]);
    // The gate stops short of the advice on purpose: es2017 is create-next-app's own default, and
    // blocking the ecosystem's stock template is how a rule teaches people to ignore it.
    expect(checkFile(cfg, '{ "compilerOptions": { "moduleResolution": "bundler", "target": "ES2017" } }', null)).toEqual([]);
    expect(checkFile(cfg, '{ "compilerOptions": { "moduleResolution": "nodenext", "target": "es2023" } }', null)).toEqual([]);
    expect(checkFile(cfg, '{ "compilerOptions": { "target": "es5" } } // enigma: ships to IE11', null)).toEqual([]);
});

test("built-in rules cover the documented conventions", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    for (const id of ["db-uuid-pk", "db-ts-orm-prisma", "be-validate-input-ts", "be-validate-input-py", "val-email-normalize", "db-sqlite-app-datastore", "fe-password-input", "fe-name-input-capitalize", "fe-name-value-normalize", "sec-password-breach-check", "fe-tracking-before-consent", "fe-no-native-dialog", "fe-skeleton-loading", "fe-viewport-meta", "fe-ai-elements-chat", "ui-no-em-dash", "fe-icon-shrink", "ts-import-namespace", "ts-alias-paths", "ts-alias-deep-relative", "ts-import-extension", "ts-legacy-module-resolution", "proc-windows-hide"]) {
        expect(ids).toContain(id);
    }
    // Go/Rust input-validation rules are deliberately absent (imprecise - see guardrails.ts).
    expect(ids).not.toContain("be-validate-input-go");
});

test("comment lines never trigger a rule (no false positive from a mention in a comment)", () => {
    expect(checkFile("db/x.sql", "-- id SERIAL PRIMARY KEY (legacy, now uuid)", null)).toEqual([]);
    expect(checkFile("src/a.ts", "// reads req.body then validates it elsewhere", null)).toEqual([]);
    expect(checkFile("src/a.ts", " * @example req.body.name", null)).toEqual([]);
    expect(checkFile("api/v.py", "# request.get_json() is validated by the decorator", null)).toEqual([]);
});

test("the fixer repairs a plain input in place, and the finding is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "gr-fix-"));
    const file = join(dir, "register.html");
    writeFileSync(file, "<form>\n  <input id=\"surname\" type=\"text\">\n</form>\n");
    const before = checkPath(file);
    expect(before.some((f) => f.ruleId === "fe-name-input-capitalize")).toBe(true);
    const { fixed, remaining } = applyFixes(file, before);
    expect(fixed.map((f) => f.ruleId)).toEqual(["fe-name-input-capitalize"]);
    // Written to disk, with the HTML attribute casing, and only that line touched.
    expect(readFileSync(file, "utf8")).toBe("<form>\n  <input autocapitalize=\"words\" id=\"surname\" type=\"text\">\n</form>\n");
    expect(remaining.some((f) => f.ruleId === "fe-name-input-capitalize")).toBe(false);
    // The value-normalization half is NOT fixable by code, so it survives for the agent.
    expect(remaining.some((f) => f.ruleId === "fe-name-value-normalize")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
});

test("the fixer declines what it cannot fix safely and leaves the file untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "gr-nofix-"));
    // A custom component may not forward an attribute it does not know: writing one there would
    // clear the rule and leave the field broken, so the fixer must decline and let the agent fix it.
    const jsx = join(dir, "profile.tsx");
    const source = "<TextField autoComplete=\"given-name\" label=\"First name\" />\n";
    writeFileSync(jsx, source);
    const found = checkPath(jsx);
    const r = applyFixes(jsx, found);
    expect(r.fixed).toEqual([]);
    expect(readFileSync(jsx, "utf8")).toBe(source);
    expect(r.remaining.some((f) => f.ruleId === "fe-name-input-capitalize")).toBe(true);
    // Two inputs on one line: which one the finding points at is ambiguous, so it declines too.
    const two = join(dir, "pair.html");
    const pair = "<input id=\"first_name\"><input id=\"last_name\">\n";
    writeFileSync(two, pair);
    expect(applyFixes(two, checkPath(two)).fixed).toEqual([]);
    expect(readFileSync(two, "utf8")).toBe(pair);
    rmSync(dir, { recursive: true, force: true });
});

test("the fixer writes JSX property casing in a .tsx file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gr-fix-jsx-"));
    const file = join(dir, "signup.tsx");
    writeFileSync(file, "export const F = () => <input autoComplete=\"name\" placeholder=\"Your name\" />;\n");
    applyFixes(file, checkPath(file));
    expect(readFileSync(file, "utf8")).toContain("<input autoCapitalize=\"words\" autoComplete=\"name\"");
    rmSync(dir, { recursive: true, force: true });
});

test("findProjectRoot locates the nearest package.json ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "gr-root-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(findProjectRoot(join(root, "a", "b", "f.ts"))).toBe(root);
    rmSync(root, { recursive: true, force: true });
});

test("a diff-stage rule is invisible to the post-edit stage and fires in the sweep", () => {
    const source = [
        "export function Rows({ items, setItems }) {",
        "    const remove = async (id) => {",
        "        await fetch(`/api/items/${id}`, { method: \"DELETE\" });",
        "        setItems((prev) => prev.filter((item) => item.id !== id));",
        "    };",
        "}",
    ].join("\n");
    // Edit stage sees a whole file, where this defect is common in existing code; it must stay
    // silent there, or every unrelated edit to a legacy component blocks.
    expect(checkFile("src/Rows.tsx", source, null)).toEqual([]);
    const swept = checkFile("src/Rows.tsx", source, null, "diff");
    expect(swept.length).toBe(1);
    expect(swept[0]!.ruleId).toBe("fe-server-first-mutation");
    expect(swept[0]!.severity).toBe("block");
    expect(swept[0]!.line).toBe(3);
});

test("the server-first check clears optimistic code, the escape hatch, and response-derived state", () => {
    const cases = [
        // The update is applied first and restored on failure: the pattern the rule asks for.
        [
            "const remove = async (id) => {",
            "    const previous = items;",
            "    setItems((prev) => prev.filter((i) => i.id !== id));",
            "    const res = await fetch(`/api/items/${id}`, { method: \"DELETE\" });",
            "    if (!res.ok) setItems(previous);",
            "};",
        ],
        // The escape hatch, for an action whose result the UI may not assume.
        [
            "const charge = async (id) => {",
            "    await fetch(`/api/charge/${id}`, { method: \"POST\" }); // enigma:allow-server-first",
            "    setRows((prev) => prev.filter((r) => r.id !== id));",
            "};",
        ],
        // The new value comes from the server, so it cannot be applied before the call.
        [
            "const rename = async (id, name) => {",
            "    const updated = await api(`/api/items/${id}`, { method: \"PATCH\", body: { name } });",
            "    setItems((cur) => cur.map((i) => (i.id === id ? updated : i)));",
            "};",
        ],
        // Chrome flags are not the entity: every handler resets one, including correct ones.
        [
            "const save = async () => {",
            "    await fetch(\"/api/save\", { method: \"POST\" });",
            "    setSaving(false);",
            "    setOpen(false);",
            "};",
        ],
    ];
    for (const lines of cases) expect(checkFile("src/Panel.tsx", lines.join("\n"), null, "diff")).toEqual([]);
});

test("a response used only as a guard does not excuse the wait", () => {
    // Regression pin: testing the whole line read `if (res.ok) setItems(...)` as response-derived
    // and let the defect through, when the response is a GUARD there and the update still waits.
    const source = [
        "const remove = async (id) => {",
        "    const res = await fetch(`/api/items/${id}`, { method: \"DELETE\" });",
        "    if (res.ok) setItems((prev) => prev.filter((item) => item.id !== id));",
        "};",
    ].join("\n");
    const found = checkFile("src/List.jsx", source, null, "diff");
    expect(found.length).toBe(1);
    expect(found[0]!.ruleId).toBe("fe-server-first-mutation");
});

test("the ledger records what happened to each finding and reports it per rule", () => {
    const log = join(HOME, "ledger.jsonl");
    process.env.ENIGMA_GUARDRAILS_LOG = log;
    rmSync(log, { force: true });
    const finding = { ruleId: "fe-server-first-mutation", severity: "block" as const, file: "src/Rows.tsx", line: 3, message: "m" };
    recordFindings([finding], "blocked", "diff");
    recordFindings([finding], "warned", "diff");
    recordFindings([{ ...finding, ruleId: "fe-name-input-capitalize", severity: "block" as const }], "fixed");
    const entries = readLedger();
    expect(entries.length).toBe(3);
    expect(entries[0]!.stage).toBe("diff");
    const rows = summarizeLedger(entries);
    expect(rows[0]!.rule).toBe("fe-server-first-mutation");
    expect(rows[0]!.blocked).toBe(1);
    expect(rows[0]!.warned).toBe(1);
    expect(rows[1]!.fixed).toBe(1);
    // A day window drops nothing recorded now, and everything recorded long ago.
    expect(readLedger(1).length).toBe(3);
    writeFileSync(log, `${JSON.stringify({ at: "2000-01-01T00:00:00.000Z", rule: "old", severity: "warn", outcome: "warned", stage: "edit", file: "a.ts" })}\nnot json\n`);
    expect(readLedger(1)).toEqual([]);
    expect(readLedger().length).toBe(1);
    delete process.env.ENIGMA_GUARDRAILS_LOG;
});

test("the sweep does not re-count a violation it already recorded today", () => {
    // The turn-end sweep reads the whole branch diff every turn, so an unfixed violation is found
    // again on every later turn - including conversational ones. Appending each of those turned one
    // violation into dozens of rows, all in the "got away with it" column the ledger exists for.
    const log = join(HOME, "dedupe.jsonl");
    process.env.ENIGMA_GUARDRAILS_LOG = log;
    rmSync(log, { force: true });
    const finding = { ruleId: "fe-server-first-mutation", severity: "block" as const, file: "src/Rows.tsx", line: 3, message: "m" };
    recordFindings([finding], "warned", "diff");
    recordFindings([finding], "warned", "diff");
    recordFindings([finding, finding], "warned", "diff");
    expect(readLedger().length).toBe(1);
    expect(countLedger()).toBe(1);
    // A different outcome, line or rule is a different encounter, not a repeat of this one.
    recordFindings([finding], "blocked", "diff");
    recordFindings([{ ...finding, line: 9 }], "warned", "diff");
    expect(readLedger().length).toBe(3);
    // The post-edit stage keeps every row: there each one is an edit the model made and was
    // answered on, which is a real encounter rather than the same finding seen again.
    recordFindings([finding], "warned");
    recordFindings([finding], "warned");
    expect(readLedger().length).toBe(5);
    expect(countLedger(1)).toBe(5);
    delete process.env.ENIGMA_GUARDRAILS_LOG;
});

test("a mutation handler is judged on its own block, not on the code after it", () => {
    // Regression pin: the block scan inferred "found" from `start !== index`, so a handler that
    // OPENS its block on the flagged line never tripped the sentinel - the scan snapped to the
    // enclosing component and the forward window reached an unrelated handler's state write.
    const source = [
        "export function Panel(props) {",
        "    const charge = async (id) => { await fetch(\"/api/charge/\" + id, { method: \"POST\" });",
        "        toast(\"charged\");",
        "    };",
        "    const dropLocally = (id) => {",
        "        props.setItems((prev) => prev.filter((i) => i.id !== id));",
        "    };",
        "}",
    ].join("\n");
    expect(checkFile("src/Panel.tsx", source, null, "diff")).toEqual([]);
});

test("the server-first escape hatch exempts the handler it marks, not the whole file", () => {
    // The rule's message says to mark the line, so honouring the marker file-wide granted a much
    // wider exemption than the one that was asked for - and silently.
    const source = [
        "export function Panel({ setRows, setItems }) {",
        "    const charge = async (id) => {",
        "        await fetch(\"/api/charge\", { method: \"POST\" }); // enigma:allow-server-first",
        "        setRows((prev) => prev.filter((r) => r.id !== id));",
        "    };",
        "    const remove = async (id) => {",
        "        await fetch(\"/api/items\", { method: \"DELETE\" });",
        "        setItems((prev) => prev.filter((i) => i.id !== id));",
        "    };",
        "}",
    ].join("\n");
    const found = checkFile("src/Panel.tsx", source, null, "diff");
    expect(found.length).toBe(1);
    expect(found[0]!.line).toBe(7);
});

test("an explicit check of one file runs every listed rule, diff-stage ones included", () => {
    // `list` shows the rule as [on] and `stats` reports it by name, so the command a person uses to
    // reproduce a finding must be able to report it too.
    const dir = mkdtempSync(join(tmpdir(), "enigma-guardrails-check-"));
    const file = join(dir, "Rows.tsx");
    writeFileSync(file, [
        "export function Rows({ setItems }) {",
        "    const remove = async (id) => {",
        "        await fetch(\"/api/items/\" + id, { method: \"DELETE\" });",
        "        setItems((prev) => prev.filter((item) => item.id !== id));",
        "    };",
        "}",
    ].join("\n"));
    expect(checkPath(file).some((f) => f.ruleId === "fe-server-first-mutation")).toBe(false);
    expect(checkPath(file, "diff").some((f) => f.ruleId === "fe-server-first-mutation")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
});
