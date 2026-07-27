/**
 * Guardrails engine: file-scope regex rules (UUID primary keys), project-scope checks
 * (Prisma as the default ORM), glob matching, custom/disabled rules from the config, and
 * the severity split. Temp HOME + ENIGMA_GUARDRAILS_CONFIG (set BEFORE import) isolate the
 * config file so the test never touches the real ~/.enigma-guardrails.json.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-guardrails-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const CONFIG = join(HOME, "guardrails.json");
process.env.ENIGMA_GUARDRAILS_CONFIG = CONFIG;

const { checkFile, checkPath, formatFindings, loadRules, findProjectRoot, BUILTIN_RULES } = await import("../src/guardrails");
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
    // Whole-component guard returns null -> blank until data resolves.
    expect(checkFile("src/Panel.tsx", "if (isLoading) return null;", null).some((x) => x.ruleId === "fe-skeleton-loading" && x.severity === "warn")).toBe(true);
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

test("built-in rules cover the documented conventions", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    for (const id of ["db-uuid-pk", "db-ts-orm-prisma", "be-validate-input-ts", "be-validate-input-py", "fe-password-input", "fe-no-native-dialog", "fe-skeleton-loading", "fe-viewport-meta"]) {
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

test("findProjectRoot locates the nearest package.json ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "gr-root-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(findProjectRoot(join(root, "a", "b", "f.ts"))).toBe(root);
    rmSync(root, { recursive: true, force: true });
});
