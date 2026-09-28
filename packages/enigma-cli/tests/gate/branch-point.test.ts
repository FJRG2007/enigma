/**
 * The base a new branch's first gate run is sized against. A push that creates a branch
 * carries a zero old SHA, and `git diff 0000..head` is not a range git accepts - so every
 * first push of a branch used to run the whole pipeline. Its real base is where it left the
 * default branch.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { branchPoint } from "@/gate/daemon/manager";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const DIR = mkdtempSync(join(tmpdir(), "enigma-branch-point-"));
afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

const git = (...args: string[]): string => execFileSync("git", args, { cwd: DIR, encoding: "utf8" }).trim();

test("a new branch is sized from where it left the default branch", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(DIR, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const fork = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "feat/x");
    writeFileSync(join(DIR, "b.txt"), "b\n");
    git("add", "-A");
    git("commit", "-qm", "feature");
    const head = git("rev-parse", "HEAD");
    // main moves on after the fork; the branch point must not follow it.
    git("checkout", "-q", "main");
    writeFileSync(join(DIR, "c.txt"), "c\n");
    git("add", "-A");
    git("commit", "-qm", "later");

    const repo = { workingPath: DIR, defaultBranch: "main" } as Parameters<typeof branchPoint>[0];
    expect(await branchPoint(repo, head)).toBe(fork);
    // No default branch to measure from: the caller falls back to running every step.
    await expect(branchPoint({ ...repo, defaultBranch: "" }, head)).rejects.toThrow();
}, 120_000);
