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

test("no-url-imports: flags URL/CDN imports, accepts package names", () => {
    assert.ok(flags("import a from \"https://esm.sh/a\";\n", "no-url-imports"));
    assert.ok(!flags("import a from \"axios\";\n", "no-url-imports"));
});

test("file-hygiene: flags trailing whitespace and missing final newline", () => {
    assert.ok(flags("const x = 1; \n", "file-hygiene"));
    assert.ok(flags("const x = 1;", "file-hygiene"));
    assert.ok(!flags("const x = 1;\n", "file-hygiene"));
});

test("no-hardcoded-secrets: detects assembled credential patterns", () => {
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    const openai = "sk-" + "proj-" + "a".repeat(24);
    assert.ok(flags(`const a = "${aws}";\n`, "no-hardcoded-secrets"));
    assert.ok(flags(`const b = "${openai}";\n`, "no-hardcoded-secrets"));
    assert.ok(!flags("const c = \"just a normal string\";\n", "no-hardcoded-secrets"));
});

test("no-hardcoded-secrets: exempts test/example files", () => {
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    assert.ok(!lintText("thing.test.ts", `const a = "${aws}";\n`).some((v) => v.rule === "no-hardcoded-secrets"));
    assert.ok(!lintText("config.example.ts", `const a = "${aws}";\n`).some((v) => v.rule === "no-hardcoded-secrets"));
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
