/**
 * The trivial-change classifier behind the gate's fast path: small, non-sensitive, text-only
 * changes skip the pipeline; anything touching auth, dependencies, CI, migrations or a binary
 * never does, whatever its size.
 *
 * Run: bun test tests/gate/triviality.test.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isTrivial, measureChange, parseNumstat } from "../../src/gate/triviality";

test("a one-line style fix is trivial", () => {
    const size = parseNumstat("1\t1\tsrc/components/tasks/Comments.tsx\n");
    expect(size).toEqual({ files: 1, assets: 0, companions: 0, companionLines: 0, lines: 2, binary: false, sensitive: [] });
    expect(isTrivial(size, 20)).toBe(true);
});

test("size, breadth, binaries and the threshold all count", () => {
    expect(isTrivial(parseNumstat("15\t10\ta.ts\n"), 20)).toBe(false);
    expect(isTrivial(parseNumstat("1\t0\ta.ts\n1\t0\tb.ts\n1\t0\tc.ts\n1\t0\td.ts\n"), 20)).toBe(false);
    expect(isTrivial(parseNumstat("-\t-\tbuild/app.wasm\n"), 20)).toBe(false);
    expect(isTrivial(parseNumstat("1\t1\ta.ts\n"), 0)).toBe(false);
    expect(isTrivial(parseNumstat(""), 20)).toBe(false);
});

test("a logo or icon swap is trivial: image and font assets add no size", () => {
    const swap = parseNumstat("-\t-\tpublic/logo.png\n-\t-\tpublic/favicon.ico\n-\t-\tpublic/apple-touch-icon.png\n240\t180\tsrc/assets/logo.svg\n");
    expect(swap).toEqual({ files: 0, assets: 4, companions: 0, companionLines: 0, lines: 0, binary: false, sensitive: [] });
    expect(isTrivial(swap, 20)).toBe(true);
    // Alongside a small text change it stays trivial; a large text change or a sensitive path does not.
    expect(isTrivial(parseNumstat("-\t-\tpublic/logo.webp\n2\t2\tsrc/Header.tsx\n"), 20)).toBe(true);
    expect(isTrivial(parseNumstat("-\t-\tpublic/logo.webp\n30\t2\tsrc/Header.tsx\n"), 20)).toBe(false);
    expect(isTrivial(parseNumstat("-\t-\tsrc/auth/logo.png\n"), 20)).toBe(false);
});

test("sensitive paths are never trivial, however small", () => {
    for (const path of [
        "package.json", "apps/web/pnpm-lock.yaml", ".github/workflows/ci.yml", "db/migrations/0003_add.sql",
        "src/auth/session.ts", "src/lib/permissions.ts", "Dockerfile", ".env.production", "infra/main.tf", ".enigma.json",
    ]) {
        expect(isTrivial(parseNumstat(`1\t0\t${path}\n`), 20)).toBe(false);
    }
});

test("a rename is judged by both names", () => {
    expect(parseNumstat("0\t0\tsrc/{util => auth}/x.ts\n").sensitive).toHaveLength(1);
    expect(parseNumstat("0\t0\told.ts => new.ts\n").sensitive).toHaveLength(0);
});

test("measureChange reads what HEAD adds on top of a base", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-trivial-"));
    const git = (...args: string[]) => execFileSync("git", args, { windowsHide: true, cwd: dir, encoding: "utf8" }).trim();
    try {
        git("init", "-q");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");
        git("config", "commit.gpgsign", "false");
        writeFileSync(join(dir, "a.css"), ".a { color: red; }\n.b { border-top: 1px solid; }\n");
        git("add", "-A");
        git("commit", "-qm", "base", "--no-verify");
        const base = git("rev-parse", "HEAD");
        writeFileSync(join(dir, "a.css"), ".a { color: red; }\n");
        git("commit", "-qam", "remove duplicate divider", "--no-verify");
        const size = measureChange(dir, base)!;
        expect(size).toEqual({ files: 1, assets: 0, companions: 0, companionLines: 0, lines: 1, binary: false, sensitive: [] });
        expect(isTrivial(size, 20)).toBe(true);
        expect(measureChange(dir, "not-a-ref")).toBeNull();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    // Process launches are slow on Windows with real-time scanning; four git calls can pass 5s.
}, 30_000);

test("a regression test and its prose do not make a small change non-trivial", () => {
    // Measured on a real logo swap: 17 lines of code came with an 18-line test and a bug write-up,
    // and those pushed it to 4 files and 78 lines - a full pipeline and a PR for a logo.
    const size = parseNumstat([
        "13\t4\tapps/web/src/components/marks.tsx",
        "18\t0\tapps/web/test/marks.test.ts",
        "42\t0\tdocs/bugs/BUG-0001-missing-logo.md",
        "1\t0\tdocs/bugs/README.md",
    ].join("\n"));
    expect(size.files).toBe(1);
    expect(size.companions).toBe(3);
    expect(isTrivial(size, 20)).toBe(true);
    // The code alone is still judged: 30 lines of it is not trivial, whatever accompanies it.
    expect(isTrivial(parseNumstat("30\t0\tsrc/a.ts\n5\t0\ttests/a.test.ts\n"), 20)).toBe(false);
    // Companions cannot hide a rewrite: past the copy bound the change goes through the gate.
    expect(isTrivial(parseNumstat("2\t0\tsrc/a.ts\n500\t0\tdocs/guide.md\n"), 20)).toBe(false);
    // A sensitive path stays sensitive as a doc too.
    expect(isTrivial(parseNumstat("2\t0\tsrc/a.ts\n3\t0\tdocs/security.md\n"), 20)).toBe(false);
});
