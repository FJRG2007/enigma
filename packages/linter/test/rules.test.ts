/**
 * Per-rule tests for @enigmax/linter. Each rule gets a violating case and a clean
 * case, asserted by the specific rule name so unrelated findings don't matter.
 *
 * Secret-pattern fixtures are assembled at runtime (concatenation) so no full
 * secret literal appears in this file - that keeps commit-time secret scanners
 * from flagging the test itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintText } from "../src/index";

/** True if `text` produces a violation for `rule`. */
function flags(text: string, rule: string): boolean {
    return lintText("snippet.ts", text).some((v) => v.rule === rule);
}

test("length-sorted-imports: flags out-of-order, accepts sorted", () => {
    assert.ok(flags("import { aVeryLongImportName } from \"x\";\nimport a from \"y\";\n", "length-sorted-imports"));
    assert.ok(!flags("import a from \"y\";\nimport { aVeryLongImportName } from \"x\";\n", "length-sorted-imports"));
});

test("prefer-double-quotes: flags single quotes, accepts double", () => {
    assert.ok(flags("const x = 'a';\n", "prefer-double-quotes"));
    assert.ok(!flags("const x = \"a\";\n", "prefer-double-quotes"));
    // single quotes are allowed when the content has a double quote
    assert.ok(!flags("const x = 'say \"hi\"';\n", "prefer-double-quotes"));
});

test("no-useless-concat: flags string concatenation, accepts template literal", () => {
    assert.ok(flags("const x = \"a\" + b;\n", "no-useless-concat"));
    assert.ok(!flags("const x = `a${b}`;\n", "no-useless-concat"));
    assert.ok(!flags("const n = 1 + 2;\n", "no-useless-concat"));
});

test("require-semicolons: flags missing semicolon, accepts present", () => {
    assert.ok(flags("const x = 1\n", "require-semicolons"));
    assert.ok(!flags("const x = 1;\n", "require-semicolons"));
});

test("require-semicolons: enforced for declarations, imports, exports, directives, class fields", () => {
    const missing = [
        "let x = 1\n",
        "var y = 2\n",
        "const f = () => {}\n",
        "const g = function () {}\n",
        "\"use strict\"\n",
        "import a from \"b\"\n",
        "export { a }\n",
        "export default a\n",
        "export const z = 1\n",
        "class C { x = 1 }\n",
    ];
    for (const src of missing) assert.ok(flags(src, "require-semicolons"), src);
    // Function and class declarations end with their body, so no trailing semicolon is required.
    assert.ok(!flags("function f() {}\n", "require-semicolons"));
    assert.ok(!flags("class C {}\n", "require-semicolons"));
    assert.ok(!flags("class C { f() {} }\n", "require-semicolons"));
});

test("no-url-imports: flags URL/CDN imports, accepts package names", () => {
    assert.ok(flags("import a from \"https://esm.sh/a\";\n", "no-url-imports"));
    assert.ok(!flags("import a from \"axios\";\n", "no-url-imports"));
});

test("file-hygiene: flags trailing whitespace and missing final newline", () => {
    assert.ok(flags("const x = 1; \n", "file-hygiene"));
    assert.ok(flags("const x = 1;", "file-hygiene"));
    assert.ok(!flags("const x = 1;\n", "file-hygiene"));
});

test("no-consecutive-blank-lines: flags 2+ blank lines, accepts a single one", () => {
    assert.ok(flags("const a = 1;\n\n\nconst b = 2;\n", "no-consecutive-blank-lines"));
    assert.ok(!flags("const a = 1;\n\nconst b = 2;\n", "no-consecutive-blank-lines"));
});

test("no-consecutive-blank-lines: ignores blanks inside strings and block comments", () => {
    assert.ok(!flags("const a = `x\n\n\ny`;\n", "no-consecutive-blank-lines"));
    assert.ok(!flags("/*\n\n\n*/\nconst a = 1;\n", "no-consecutive-blank-lines"));
});

test("no-hardcoded-secrets: detects assembled credential patterns", () => {
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    const openai = "sk-" + "proj-" + ["T3a9", "Kf2b", "Lp7Q", "x1Rz", "8Wm4", "Vn6h"].join("");
    assert.ok(flags(`const a = "${aws}";\n`, "no-hardcoded-secrets"));
    assert.ok(flags(`const b = "${openai}";\n`, "no-hardcoded-secrets"));
    assert.ok(!flags("const c = \"just a normal string\";\n", "no-hardcoded-secrets"));
});

test("no-hardcoded-secrets: ignores obvious placeholders and low-entropy fakes", () => {
    const zeros = "sk-" + "proj-" + "0".repeat(24);
    const repeated = "sk-" + "proj-" + "a".repeat(24);
    const awsZeros = "AKIA" + "0000000000000000";
    assert.ok(!flags(`const a = "${zeros}";\n`, "no-hardcoded-secrets"));
    assert.ok(!flags(`const b = "${repeated}";\n`, "no-hardcoded-secrets"));
    assert.ok(!flags(`const c = "${awsZeros}";\n`, "no-hardcoded-secrets"));
    assert.ok(!flags("const apiKey = \"your_api_key_here_xx\";\n", "no-hardcoded-secrets"));
});

test("no-hardcoded-secrets: exempts test/example files", () => {
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    assert.ok(!lintText("thing.test.ts", `const a = "${aws}";\n`).some((v) => v.rule === "no-hardcoded-secrets"));
    assert.ok(!lintText("config.example.ts", `const a = "${aws}";\n`).some((v) => v.rule === "no-hardcoded-secrets"));
});

/** True if linting `file` with `text` produces a violation for `rule`. */
function flagsIn(file: string, text: string, rule: string): boolean {
    return lintText(file, text).some((v) => v.rule === rule);
}

test("languages: unknown extensions are not linted", () => {
    assert.equal(lintText("notes.txt", "x = 1  \n\n\n").length, 0);
});

test("python: JS/TS-only rules do not run", () => {
    assert.ok(!flagsIn("a.py", "x = 1\n", "require-semicolons"));
    assert.ok(!flagsIn("a.py", "x = 'a'\n", "prefer-double-quotes"));
});

test("python: universal rules run (blank lines, hygiene, secrets)", () => {
    assert.ok(flagsIn("a.py", "x = 1\n\n\ny = 2\n", "no-consecutive-blank-lines"));
    assert.ok(flagsIn("a.py", "x = 1 \n", "file-hygiene"));
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    assert.ok(flagsIn("a.py", `KEY = "${aws}"\n`, "no-hardcoded-secrets"));
});

test("python: blank lines inside a docstring are not collapsed", () => {
    const src = "def f():\n    \"\"\"\n    a\n\n    b\n    \"\"\"\n    return 1\n";
    assert.ok(!flagsIn("a.py", src, "no-consecutive-blank-lines"));
});

test("rust: blank lines inside a block comment are not collapsed, real ones are", () => {
    assert.ok(!flagsIn("a.rs", "/*\n\n\n*/\nfn main() {}\n", "no-consecutive-blank-lines"));
    assert.ok(flagsIn("a.rs", "fn a() {}\n\n\nfn b() {}\n", "no-consecutive-blank-lines"));
});

test("rust: a char literal holding a quote does not open a string", () => {
    assert.ok(flagsIn("a.rs", "let c = '\"';\n\n\nlet d = 1;\n", "no-consecutive-blank-lines"));
});

test("prisma: universal rules run", () => {
    assert.ok(flagsIn("schema.prisma", "model A {\n\n\n  id Int @id\n}\n", "no-consecutive-blank-lines"));
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    assert.ok(flagsIn("schema.prisma", `key = "${aws}"\n`, "no-hardcoded-secrets"));
});

test("categories option restricts the rule set", () => {
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    const text = `const a = 'x' + b\nconst c = "${aws}"\n`;
    const audit = lintText("snippet.ts", text, { categories: ["audit"] });
    assert.ok(audit.every((v) => v.category === "audit"));
    assert.ok(audit.some((v) => v.rule === "no-hardcoded-secrets"));
    const style = lintText("snippet.ts", text, { categories: ["style"] });
    assert.ok(style.every((v) => v.category === "style"));
});
