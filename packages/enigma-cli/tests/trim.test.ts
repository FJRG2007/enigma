/**
 * EOF trimmer: the conservative rule (content, then blank lines, then end of file), the
 * shapes it must never touch, line-ending preservation, and the tail/truncate mechanics that
 * keep it cheap on large files. Everything runs against real files in a temp dir, because the
 * whole point of the module is what it does to bytes on disk.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { trimFile, trailingBlankBytes, isSkipped, readIgnoreGlobs } from "../src/trim";

const DIR = mkdtempSync(join(tmpdir(), "enigma-trim-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
/** Write `input` verbatim, trim it, and return what is on disk afterwards. latin1 keeps bytes 1:1. */
async function run(input: string, name = "a.ts"): Promise<{ out: string; changed: boolean }> {
    const path = join(DIR, `${n++}-${name}`);
    writeFileSync(path, input, "latin1");
    const changed = await trimFile(path);
    return { out: readFileSync(path, "latin1"), changed };
}

test("removes the trailing blank line an agent leaves behind", async () => {
    expect(await run("a\n\n")).toEqual({ out: "a\n", changed: true });
    expect(await run("a\nb\n\n\n\n")).toEqual({ out: "a\nb\n", changed: true });
    // A line of only whitespace is still a blank line.
    expect(await run("a\n   \n")).toEqual({ out: "a\n", changed: true });
    expect(await run("a\n \n\t\n")).toEqual({ out: "a\n", changed: true });
});

test("leaves every file that is not content-then-blank exactly as it is", async () => {
    // The two shapes the rule exists to protect: nothing to remove, and nothing above it.
    for (const input of ["a\nb\n", "", "\n", "\n\n\n", "   \n\t\n"]) {
        expect(await run(input)).toEqual({ out: input, changed: false });
    }
    // No closing newline: the last line is unterminated content, not a blank line.
    expect(await run("a\nb")).toEqual({ out: "a\nb", changed: false });
    // Blank lines INSIDE the file are the author's, only the ones at the end go.
    expect(await run("a\n\n\nb\n\n")).toEqual({ out: "a\n\n\nb\n", changed: true });
});

test("never rewrites a content line, so trailing whitespace is left to its own convention", async () => {
    expect(await run("a   \n")).toEqual({ out: "a   \n", changed: false });
    expect(await run("a   \n\n")).toEqual({ out: "a   \n", changed: true });
});

test("preserves the file's line endings", async () => {
    expect(await run("a\r\nb\r\n\r\n")).toEqual({ out: "a\r\nb\r\n", changed: true });
    expect(await run("a\r\n\r\n\r\n")).toEqual({ out: "a\r\n", changed: true });
    expect(await run("a\r\n")).toEqual({ out: "a\r\n", changed: false });
});

test("truncates by bytes, so multi-byte characters at the end survive", async () => {
    // Decoded as utf8 the tail would be shorter than it is in bytes, and the cut would land
    // mid-character; latin1 keeps one char per byte, which is what makes this pass.
    const text = Buffer.from("café ✓\n", "utf8").toString("latin1");
    expect(await run(`${text}\n`)).toEqual({ out: text, changed: true });
});

test("skips binaries and the formats where a trailing blank line is data", async () => {
    expect(await run("PK\u0000\u0003data\n\n", "a.bin")).toEqual({ out: "PK\u0000\u0003data\n\n", changed: false });
    // A NUL is enough on its own, whatever the file is called.
    expect(await run("text\u0000more\n\n")).toEqual({ out: "text\u0000more\n\n", changed: false });
    expect(await run("a\n\n", "x.patch")).toEqual({ out: "a\n\n", changed: false });
    expect(isSkipped("src/__snapshots__/a.snap")).toBe(true);
    expect(isSkipped("tests/fixtures/sample.txt")).toBe(true);
    expect(isSkipped("src/app.ts")).toBe(false);
});

test("handles a blank run longer than one tail window, and a body it never reads", async () => {
    // Forces the widening re-read (the first window is 4 KB and is entirely blank).
    expect(await run(`a\n${"\n".repeat(5000)}`)).toEqual({ out: "a\n", changed: true });
    // A large file costs a stat, a small tail read and a truncate - the body is never touched.
    const big = "x".repeat(200_000);
    expect(await run(`${big}\n\n`)).toEqual({ out: `${big}\n`, changed: true });
});

test("trailingBlankBytes reports the exact byte count, and asks for more when it needs it", () => {
    expect(trailingBlankBytes("a\n\n", true)).toBe(1);
    expect(trailingBlankBytes("a\r\n\r\n", true)).toBe(2);
    expect(trailingBlankBytes("a\n", true)).toBe(0);
    expect(trailingBlankBytes("a", true)).toBe(0);
    // All blank: at the start of the file that is the whole file, otherwise look further back.
    expect(trailingBlankBytes("\n\n", true)).toBe(0);
    expect(trailingBlankBytes("\n\n", false)).toBe(-1);
});

test("never rewrites vendored or generated trees", () => {
    // Vendored content is somebody else's file: rewriting it diverges the copy from upstream,
    // and where the copy is integrity-checked (enigma's own skills-registry records a sha256
    // per file) a single trimmed byte invalidates the recorded hash.
    for (const path of [
        "vendor/lib/a.go", "third_party/x/a.js", "node_modules/pkg/index.js",
        "dist/main.js", "build/out.js", "coverage/lcov-report/index.html", ".next/server/page.js",
    ]) expect(isSkipped(path)).toBe(true);
    expect(isSkipped("src/dist-helper.ts")).toBe(false);   // a segment, not a substring
});

test("an ignore list marks a tree as deliberate, and is absent by default", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-trim-cfg-"));
    expect(readIgnoreGlobs(root)).toEqual([]);             // no config file at all
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(join(root, ".githooks", "enigma-trim.json"), '{ "ignore": ["assets/vendored/**", 7] }');
    expect(readIgnoreGlobs(root)).toEqual(["assets/vendored/**"]);   // non-strings dropped
    writeFileSync(join(root, ".githooks", "enigma-trim.json"), "{ not json");
    expect(readIgnoreGlobs(root)).toEqual([]);             // a hand-edited file never throws
    rmSync(root, { recursive: true, force: true });
});

test("a missing or unreadable path is a no-op, never a throw", async () => {
    expect(await trimFile(join(DIR, "does-not-exist.ts"))).toBe(false);
    expect(await trimFile(DIR)).toBe(false);
});
