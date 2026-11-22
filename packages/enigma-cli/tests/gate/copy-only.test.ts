/**
 * The copy-only half of the gate's fast path: a change that only edits text (string literals, tag
 * text, prose and translation files) is trivial at any breadth up to MAX_COPY_LINES; one changed
 * token of code, a sensitive path or a binary is not.
 *
 * Run: bun test tests/gate/copy-only.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { copyOnlyDiff, isTrivialChange } from "../../src/gate/triviality";

const hunk = (file: string, minus: string[], plus: string[]): string =>
    [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join("\n");

test("text inside string literals and tags is copy", () => {
    expect(copyOnlyDiff(hunk("src/Hero.tsx", ["<h1>Welcome back</h1>", "const t = \"Save\";"], ["<h1>Welcome home</h1>", "const t = \"Save changes\";"]))).toBe(true);
    expect(copyOnlyDiff(hunk("src/a.ts", ["toast(`Saved ${n} items`)"], ["toast(`Stored ${n} items`)"]))).toBe(true);
});

test("prose and translation files are copy whatever the lines hold", () => {
    expect(copyOnlyDiff(hunk("README.md", ["old"], ["new", "more"]))).toBe(true);
    expect(copyOnlyDiff(hunk("src/locales/es.json", ["\"a\": 1"], ["\"a\": 2", "\"b\": 3"]))).toBe(true);
});

test("any change outside the copy, an added code line, a sensitive path or a binary is not", () => {
    expect(copyOnlyDiff(hunk("src/a.ts", ["if (a) save(\"x\");"], ["if (b) save(\"x\");"]))).toBe(false);
    expect(copyOnlyDiff(hunk("src/a.ts", [], ["call();"]))).toBe(false);
    expect(copyOnlyDiff(hunk("src/auth/Login.tsx", ["<p>Sign in</p>"], ["<p>Log in</p>"]))).toBe(false);
    expect(copyOnlyDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ")).toBe(false);
    expect(copyOnlyDiff("")).toBe(false);
});

test("a copy edit across many files skips the gate; the same breadth with a code change does not", () => {
    const repo = mkdtempSync(join(tmpdir(), "enigma-copy-only-"));
    const git = (...args: string[]): string => execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8", windowsHide: true });
    try {
        git("init", "-q");
        mkdirSync(join(repo, "src"));
        for (let i = 0; i < 8; i++) writeFileSync(join(repo, "src", `C${i}.tsx`), `export const C${i} = () => <p>Old text ${i}</p>;\n`.repeat(4));
        git("add", "."); git("commit", "-q", "-m", "base");
        const base = git("rev-parse", "HEAD").trim();
        for (let i = 0; i < 8; i++) writeFileSync(join(repo, "src", `C${i}.tsx`), `export const C${i} = () => <p>New text ${i}</p>;\n`.repeat(4));
        git("commit", "-qam", "copy");
        const copy = isTrivialChange(repo, base, 20);
        expect(copy).toMatchObject({ trivial: true, copyOnly: true });
        writeFileSync(join(repo, "src", "C0.tsx"), "export const C0 = () => <p data-x>New text 0</p>;\n");
        git("commit", "-qam", "code");
        expect(isTrivialChange(repo, base, 20).trivial).toBe(false);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
