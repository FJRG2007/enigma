/**
 * Base-SHA resolution and the name-only diff funnel.
 *
 * The failure this guards against is silent: git reads an empty left side of a
 * range as HEAD, so a blank base turns `<base>..<head>` into HEAD..HEAD, exits 0
 * with no output, and the review step reports "no reviewable changes" on a run
 * that reviewed nothing. A green pipeline cannot see that, so the invariants are
 * asserted here against real temp repositories: resolveBaseSHA never returns an
 * empty string, every empty-tree substitution reaches the run-visible channel,
 * a cancelled run is never diagnosed as a broken base, and diffNameOnly refuses
 * a blank base instead of returning an empty list.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "@/gate/git";
import { execFileSync } from "node:child_process";
import { test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolveBaseSHA, resolveCommitSHA, unresolvedDefaultBranchTip } from "@/gate/pipeline/steps/commonGit";

// Every test here drives real git (some of them the real CLI), several process spawns each.
// Bun defaults to 5s per test, which is fine on an idle machine and not on a loaded one -
// process spawn is the slow part, on Windows especially. Set once for the file so a test
// added later inherits it instead of being remembered one at a time.
setDefaultTimeout(60_000);

const ZERO_SHA = "0000000000000000000000000000000000000000";
const GARBAGE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const roots: string[] = [];

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function run(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function commit(dir: string, name: string): void {
    writeFileSync(join(dir, name), `${name}\n`);
    run(dir, "add", name);
    run(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", name);
}

/** A repo on `main` with one commit, plus whatever the caller adds. */
function newRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "enigma-common-git-"));
    roots.push(dir);
    run(dir, "init", "-q", "-b", "main");
    commit(dir, "first.txt");
    return dir;
}

/** Collects what a step would print on the run-visible channel (`sctx.log`). */
function newNotifier(): { lines: string[]; notify: (text: string) => void; } {
    const lines: string[] = [];
    return { lines, notify: (text: string) => lines.push(text) };
}

const live = (): AbortSignal => new AbortController().signal;

test("a base git resolves is returned canonicalized, not substituted", async () => {
    const dir = newRepo();
    const head = run(dir, "rev-parse", "HEAD");
    const { lines, notify } = newNotifier();

    expect(await resolveBaseSHA(live(), dir, head, "main", notify)).toBe(head);
    expect(await resolveBaseSHA(live(), dir, head.slice(0, 8), "main", notify)).toBe(head);
    expect(await resolveBaseSHA(live(), dir, ` ${head}\n`, "main", notify)).toBe(head);
    expect(lines).toEqual([]);
});

test("an empty or garbage base never resolves to an empty string", async () => {
    const dir = newRepo();
    const first = run(dir, "rev-parse", "HEAD");
    run(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "second.txt");

    for (const base of ["", "   ", GARBAGE_SHA, "no-such-ref"]) {
        const { lines, notify } = newNotifier();
        const resolved = await resolveBaseSHA(live(), dir, base, "main", notify);
        expect(resolved).toBe(first);
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain("does not resolve to a commit in this worktree");
        expect(lines[0]).toContain(first);
    }
});

test("an orphaned base with no merge-base falls back to the empty tree, loudly", async () => {
    const dir = newRepo();
    run(dir, "checkout", "-q", "--orphan", "orphan");
    run(dir, "rm", "-q", "-rf", ".");
    commit(dir, "only.txt");
    const { lines, notify } = newNotifier();

    expect(await resolveBaseSHA(live(), dir, GARBAGE_SHA, "main", notify)).toBe(git.EMPTY_TREE_SHA);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("does not resolve to a commit in this worktree");
    expect(lines[0]).toContain("treats every tracked file as changed");
});

test("the zero ref announces the empty-tree substitution too", async () => {
    const dir = newRepo();
    run(dir, "checkout", "-q", "--orphan", "orphan");
    run(dir, "rm", "-q", "-rf", ".");
    commit(dir, "only.txt");
    const { lines, notify } = newNotifier();

    expect(await resolveBaseSHA(live(), dir, ZERO_SHA, "main", notify)).toBe(git.EMPTY_TREE_SHA);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("zero ref");
    expect(lines[0]).toContain("treats every tracked file as changed");
});

test("an empty default branch still cannot yield an empty base", async () => {
    const dir = newRepo();
    const { lines, notify } = newNotifier();

    expect(await resolveBaseSHA(live(), dir, ZERO_SHA, "", notify)).toBe(git.EMPTY_TREE_SHA);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("the default branch");
});

test("the zero ref resolving to a merge-base is the expected path, not a warning", async () => {
    const dir = newRepo();
    const first = run(dir, "rev-parse", "HEAD");
    run(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "second.txt");
    const { lines, notify } = newNotifier();

    expect(await resolveBaseSHA(live(), dir, ZERO_SHA, "main", notify)).toBe(first);
    expect(lines).toEqual([]);
});

test("an unresolvable default-branch tip announces its empty-tree fallback", async () => {
    const dir = newRepo();
    const { lines, notify } = newNotifier();

    const tip = await unresolvedDefaultBranchTip(live(), dir, GARBAGE_SHA, "no-such-branch", notify);
    expect(tip).toBe(git.EMPTY_TREE_SHA);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("treats every tracked file as changed");
});

test("a cancelled run is not diagnosed as a broken base", async () => {
    const dir = newRepo();
    const signal = AbortSignal.abort();
    const { lines, notify } = newNotifier();

    await expect(resolveCommitSHA(signal, dir, "HEAD")).rejects.toThrow();
    await expect(resolveBaseSHA(signal, dir, GARBAGE_SHA, "main", notify)).rejects.toThrow();
    expect(lines).toEqual([]);
});

test("diffNameOnly refuses a blank base instead of reporting no changes", async () => {
    const dir = newRepo();
    commit(dir, "second.txt");

    for (const base of ["", "   "]) {
        await expect(git.diffNameOnly(dir, base, "HEAD")).rejects.toThrow("empty base revision");
        await expect(git.diffNameOnly(dir, base, "")).rejects.toThrow("empty base revision");
    }
    await expect(git.diff(dir, "", "HEAD")).rejects.toThrow("empty base revision");
});

test("the empty-tree base lists every tracked file rather than nothing", async () => {
    const dir = newRepo();
    commit(dir, "second.txt");

    const files = await git.diffNameOnly(dir, git.EMPTY_TREE_SHA, "HEAD");
    expect(files.sort()).toEqual(["first.txt", "second.txt"]);
});

test("a real range still diffs only what changed", async () => {
    const dir = newRepo();
    const first = run(dir, "rev-parse", "HEAD");
    commit(dir, "second.txt");

    expect(await git.diffNameOnly(dir, first, "HEAD")).toEqual(["second.txt"]);
});
