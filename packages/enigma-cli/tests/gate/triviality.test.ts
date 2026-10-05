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
    expect(size).toEqual({ files: 1, lines: 2, binary: false, sensitive: [] });
    expect(isTrivial(size, 20)).toBe(true);
});

test("size, breadth, binaries and the threshold all count", () => {
    expect(isTrivial(parseNumstat("15\t10\ta.ts\n"), 20)).toBe(false);
    expect(isTrivial(parseNumstat("1\t0\ta.ts\n1\t0\tb.ts\n1\t0\tc.ts\n1\t0\td.ts\n"), 20)).toBe(false);
    expect(isTrivial(parseNumstat("-\t-\tlogo.png\n"), 20)).toBe(false);
    expect(isTrivial(parseNumstat("1\t1\ta.ts\n"), 0)).toBe(false);
    expect(isTrivial(parseNumstat(""), 20)).toBe(false);
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
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
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
        expect(size).toEqual({ files: 1, lines: 1, binary: false, sensitive: [] });
        expect(isTrivial(size, 20)).toBe(true);
        expect(measureChange(dir, "not-a-ref")).toBeNull();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    // Process launches are slow on Windows with real-time scanning; four git calls can pass 5s.
}, 30_000);
