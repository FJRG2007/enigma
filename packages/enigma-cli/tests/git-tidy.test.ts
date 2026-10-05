/**
 * Branch tidying, tested against real git repositories rather than mocks - the whole
 * feature is a set of refusals, and a refusal that only holds against a fake is worth
 * nothing. Every case that must NOT lose work gets its own repo: unmerged commits, a
 * squash merge (which ancestry alone gets wrong), a dirty tree, a stash, another
 * worktree, a remote that is ahead, a remote that cannot be read.
 *
 * Temp HOME (set BEFORE import) isolates the undo ledger. ENIGMA_CONFIG_HOME is the one
 * that actually does it: bun on Linux resolves the os home helper from the OS account and
 * ignores a reassigned $HOME, so setting HOME alone left the ledger in the runner's real
 * home - which passed every assertion here except the one that blocks the ledger path and
 * expects the deletion to stop, and that is the assertion protecting the work.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-tidy-home-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { planTidy, tidy, readLedger, restoreCommand } = await import("../src/git-tidy");

const dirs: string[] = [];
afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, name: string, body = name): void {
    writeFileSync(join(dir, name), `${body}\n`);
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", name);
}

/** A repo on `main` with one commit, plus a `remote` bare it can push to. */
function repo(label: string): { dir: string; remote: string; } {
    const dir = mkdtempSync(join(tmpdir(), `enigma-tidy-${label}-`));
    const remote = mkdtempSync(join(tmpdir(), `enigma-tidy-${label}-remote-`));
    dirs.push(dir, remote);
    git(remote, "init", "-q", "--bare", "-b", "main", ".");
    git(dir, "init", "-q", "-b", "main", ".");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "user.email", "t@e.test");
    commit(dir, "base.txt");
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "-u", "origin", "main");
    git(dir, "remote", "set-head", "origin", "main");
    return { dir, remote };
}

/** Branch off main, commit, and come back. */
function branchWithWork(dir: string, branch: string, file: string): void {
    git(dir, "checkout", "-q", "-b", branch);
    commit(dir, file);
    git(dir, "checkout", "-q", "main");
}

test("a merged branch is tidied, locally and on the remote", async () => {
    const { dir } = repo("merged");
    branchWithWork(dir, "feat/done", "done.txt");
    git(dir, "push", "-q", "origin", "feat/done");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/done");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "checkout", "-q", "feat/done");

    const result = await tidy(dir);
    expect(result.problems).toEqual([]);
    expect(result.switched).toBe(true);
    expect(result.deleted).toContain("feat/done");
    expect(result.deletedRemote).toContain("feat/done");
    expect(git(dir, "branch", "--list", "feat/done")).toBe("");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // The work itself is still there - that is the whole point of the containment check.
    expect(existsSync(join(dir, "done.txt"))).toBe(true);
});

test("a squash-merged branch is recognised, which ancestry alone gets wrong", async () => {
    const { dir } = repo("squash");
    branchWithWork(dir, "feat/squashed", "squashed.txt");
    git(dir, "merge", "-q", "--squash", "feat/squashed");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "squashed");

    // git's own merged-branch listing does not see it...
    expect(git(dir, "branch", "--merged", "main")).not.toContain("feat/squashed");
    // ...but the content is in main, so tidying does.
    const plan = await planTidy(dir, "");
    expect(plan.verdicts.find((v) => v.branch === "feat/squashed")?.tidyable).toBe(true);

    // And it is actually removed: `git branch -d` refuses a squash merge on ancestry, so
    // this is the case that exercises the re-proved forced delete.
    const result = await tidy(dir, { remote: "" });
    expect(result.problems).toEqual([]);
    expect(result.deleted).toContain("feat/squashed");
    expect(git(dir, "branch", "--list", "feat/squashed")).toBe("");
    expect(existsSync(join(dir, "squashed.txt"))).toBe(true);
});

test("the forced delete is refused when main stops containing the branch", async () => {
    const { dir } = repo("reverted");
    branchWithWork(dir, "feat/reverted", "reverted.txt");
    git(dir, "merge", "-q", "--squash", "feat/reverted");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "squashed");
    // main takes the work back out. The branch is the only place that content survives.
    rmSync(join(dir, "reverted.txt"));
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "revert");

    const plan = await planTidy(dir, "");
    expect(plan.verdicts.find((v) => v.branch === "feat/reverted")?.reason).toBe("not-contained");
    const result = await tidy(dir, { remote: "" });
    expect(result.deleted).toEqual([]);
    expect(git(dir, "branch", "--list", "feat/reverted").trim()).toContain("feat/reverted");
    expect(git(dir, "show", "feat/reverted:reverted.txt").trim()).toBe("reverted.txt");
});

test("an unmerged branch is never touched", async () => {
    const { dir } = repo("unmerged");
    branchWithWork(dir, "feat/wip", "wip.txt");

    const plan = await planTidy(dir, "");
    const verdict = plan.verdicts.find((v) => v.branch === "feat/wip")!;
    expect(verdict.tidyable).toBe(false);
    expect(verdict.reason).toBe("not-contained");

    const result = await tidy(dir, { remote: "" });
    expect(result.deleted).toEqual([]);
    expect(git(dir, "branch", "--list", "feat/wip").trim()).toContain("feat/wip");
    expect(git(dir, "cat-file", "-t", git(dir, "rev-parse", "feat/wip"))).toBe("commit");
});

test("a partially merged branch keeps its unmerged commit", async () => {
    const { dir } = repo("partial");
    git(dir, "checkout", "-q", "-b", "feat/half");
    commit(dir, "first.txt");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/half");
    git(dir, "checkout", "-q", "feat/half");
    commit(dir, "second.txt");
    git(dir, "checkout", "-q", "main");

    const plan = await planTidy(dir, "");
    expect(plan.verdicts.find((v) => v.branch === "feat/half")?.reason).toBe("not-contained");
});

test("a dirty working tree does not stop branches it has nothing to do with", async () => {
    // The blanket "dirty tree blocks the repository" rule is what made this feature never
    // run: a repo an agent works in is dirty nearly all the time, and 95 of 96 automatic
    // cleanups were skipped for it. Deleting a ref that is not HEAD touches no file.
    const { dir } = repo("dirty-other");
    branchWithWork(dir, "feat/done", "done.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/done");
    writeFileSync(join(dir, "scratch.txt"), "uncommitted\n");

    const plan = await planTidy(dir, "");
    expect(plan.blocked).toBeUndefined();
    const result = await tidy(dir, { remote: "" });
    expect(result.deleted).toContain("feat/done");
    expect(result.switched).toBe(false);
    // The uncommitted work is still there, untouched, on the branch it belongs to.
    expect(existsSync(join(dir, "scratch.txt"))).toBe(true);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

test("a dirty working tree still refuses the branch it is checked out on", async () => {
    // The one thing the dirty check ever protected: deleting the CURRENT branch needs the
    // checkout moved off it, and that is the move uncommitted changes would lose.
    const { dir } = repo("dirty-current");
    branchWithWork(dir, "feat/done", "done.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/done");
    git(dir, "checkout", "-q", "feat/done");
    writeFileSync(join(dir, "scratch.txt"), "uncommitted\n");

    const plan = await planTidy(dir, "");
    expect(plan.verdicts.find((v) => v.branch === "feat/done")?.reason).toBe("dirty-worktree");
    const result = await tidy(dir, { remote: "" });
    expect(result.deleted).toEqual([]);
    expect(result.switched).toBe(false);
    expect(git(dir, "branch", "--list", "feat/done").trim()).toContain("feat/done");
    expect(existsSync(join(dir, "scratch.txt"))).toBe(true);
});

test("a branch with a stash based on it is left alone", async () => {
    const { dir } = repo("stash");
    git(dir, "checkout", "-q", "-b", "feat/stashed");
    commit(dir, "stashed.txt");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/stashed");
    git(dir, "checkout", "-q", "feat/stashed");
    writeFileSync(join(dir, "stashed.txt"), "work in progress\n");
    git(dir, "stash", "push", "-q", "-m", "wip");
    git(dir, "checkout", "-q", "main");

    const plan = await planTidy(dir, "");
    expect(plan.verdicts.find((v) => v.branch === "feat/stashed")?.reason).toBe("has-stash");
});

test("a branch checked out in another worktree is left alone", async () => {
    const { dir } = repo("worktree");
    branchWithWork(dir, "feat/elsewhere", "elsewhere.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/elsewhere");
    const wt = mkdtempSync(join(tmpdir(), "enigma-tidy-wt-"));
    dirs.push(wt);
    rmSync(wt, { recursive: true, force: true });
    git(dir, "worktree", "add", "-q", wt, "feat/elsewhere");

    const plan = await planTidy(dir, "");
    expect(plan.verdicts.find((v) => v.branch === "feat/elsewhere")?.reason).toBe("checked-out-elsewhere");
    git(dir, "worktree", "remove", "--force", wt);
});

test("a remote copy holding extra work blocks the delete entirely", async () => {
    const { dir, remote } = repo("remote-ahead");
    branchWithWork(dir, "feat/ahead", "ahead.txt");
    git(dir, "push", "-q", "origin", "feat/ahead");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/ahead");
    git(dir, "push", "-q", "origin", "main");

    // Someone else pushes one more commit to the branch, which this checkout never saw.
    const other = mkdtempSync(join(tmpdir(), "enigma-tidy-other-"));
    dirs.push(other);
    git(other, "clone", "-q", remote, ".");
    git(other, "config", "user.name", "t");
    git(other, "config", "user.email", "t@e.test");
    git(other, "checkout", "-q", "feat/ahead");
    commit(other, "theirs.txt");
    git(other, "push", "-q", "origin", "feat/ahead");

    const plan = await planTidy(dir, "origin");
    const verdict = plan.verdicts.find((v) => v.branch === "feat/ahead")!;
    expect(verdict.tidyable).toBe(false);
    expect(verdict.reason).toBe("remote-ahead");

    const result = await tidy(dir);
    expect(result.deleted).toEqual([]);
    expect(git(dir, "ls-remote", "origin", "refs/heads/feat/ahead")).toContain("feat/ahead");
});

test("an unreadable remote keeps the remote branch but still tidies locally", async () => {
    const { dir } = repo("offline");
    branchWithWork(dir, "feat/local", "local.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/local");
    git(dir, "remote", "set-url", "origin", join(tmpdir(), "enigma-tidy-does-not-exist.git"));

    const plan = await planTidy(dir, "origin");
    const verdict = plan.verdicts.find((v) => v.branch === "feat/local");
    // Either the default branch stops resolving (whole repo blocked) or the branch is
    // tidyable locally with the remote left alone. Both are safe; neither deletes remotely.
    if (!plan.blocked) {
        expect(verdict?.tidyable).toBe(true);
        expect(verdict?.remote).toBe(false);
        const result = await tidy(dir, { remote: "origin" });
        expect(result.deletedRemote).toEqual([]);
    }
});

test("the default branch and protected names are never candidates", async () => {
    const { dir } = repo("protected");
    git(dir, "branch", "develop");
    git(dir, "branch", "trunk");

    const plan = await planTidy(dir, "");
    expect(plan.verdicts.find((v) => v.branch === "main")?.reason).toBe("default-branch");
    expect(plan.verdicts.find((v) => v.branch === "develop")?.reason).toBe("protected-name");
    expect(plan.verdicts.find((v) => v.branch === "trunk")?.reason).toBe("protected-name");
    expect(plan.verdicts.every((v) => !v.tidyable)).toBe(true);
});

test("a dry run reports the plan and deletes nothing", async () => {
    const { dir } = repo("dry");
    branchWithWork(dir, "feat/dry", "dry.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/dry");

    const result = await tidy(dir, { remote: "", dryRun: true });
    expect(result.deleted).toEqual([]);
    expect(result.plan.verdicts.find((v) => v.branch === "feat/dry")?.tidyable).toBe(true);
    expect(git(dir, "branch", "--list", "feat/dry").trim()).toContain("feat/dry");
});

test("`only` limits the deletion to the branches named", async () => {
    const { dir } = repo("only");
    branchWithWork(dir, "feat/one", "one.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge one", "feat/one");
    branchWithWork(dir, "feat/two", "two.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge two", "feat/two");

    const result = await tidy(dir, { remote: "", only: ["feat/one"] });
    expect(result.deleted).toEqual(["feat/one"]);
    expect(git(dir, "branch", "--list", "feat/two").trim()).toContain("feat/two");
});

test("every deletion is written down with the command that undoes it", async () => {
    const { dir } = repo("ledger");
    branchWithWork(dir, "feat/logged", "logged.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/logged");
    const sha = git(dir, "rev-parse", "feat/logged");

    await tidy(dir, { remote: "" });
    const entry = readLedger().find((e) => e.branch === "feat/logged");
    expect(entry).toBeDefined();
    expect(entry!.sha).toBe(sha);
    expect(entry!.repo).toBe(dir);

    // The recorded restore command actually restores it.
    execFileSync("git", restoreCommand("feat/logged", entry!.sha).split(" ").slice(1), { cwd: dir });
    expect(git(dir, "rev-parse", "feat/logged")).toBe(sha);
});

test("a repository with no default branch is blocked rather than guessed at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-tidy-bare-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main", ".");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "user.email", "t@e.test");
    commit(dir, "base.txt");
    git(dir, "checkout", "-q", "-b", "feat/orphan");
    commit(dir, "orphan.txt");

    const plan = await planTidy(dir, "origin");
    if (!plan.blocked) expect(plan.verdicts.find((v) => v.branch === "feat/orphan")?.tidyable).toBe(false);
    const result = await tidy(dir, { remote: "origin" });
    expect(result.deleted).toEqual([]);
});

test("nothing is deleted while the undo ledger cannot be written", async () => {
    const { dir } = repo("ledger-fail");
    branchWithWork(dir, "feat/unwritable", "unwritable.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/unwritable");

    // Put a directory where the ledger file belongs, so writing it fails.
    const ledger = join(HOME, ".enigma", "deleted-branches.json");
    rmSync(ledger, { force: true });
    mkdirSync(ledger, { recursive: true });
    try {
        const result = await tidy(dir, { remote: "" });
        expect(result.deleted).toEqual([]);
        expect(result.problems.join(" ")).toContain("restore point");
        expect(git(dir, "branch", "--list", "feat/unwritable").trim()).toContain("feat/unwritable");
    } finally {
        rmSync(ledger, { recursive: true, force: true });
    }
});

test("work merged on the remote is proved against it, however far behind the local default branch is", async () => {
    const { dir, remote } = repo("stale-main");
    branchWithWork(dir, "feat/landed", "landed.txt");
    git(dir, "push", "-q", "origin", "feat/landed");
    // The merge happens in another clone, so this checkout's `main` never sees it.
    const other = mkdtempSync(join(tmpdir(), "enigma-tidy-stale-main-other-"));
    dirs.push(other);
    git(other, "clone", "-q", remote, ".");
    git(other, "-c", "user.name=t", "-c", "user.email=t@e.test", "merge", "-q", "--no-ff", "-m", "merge", "origin/feat/landed");
    git(other, "push", "-q", "origin", "main");

    const plan = await planTidy(dir);
    expect(plan.baseRef).toBe("origin/main");
    expect(plan.verdicts.find((v) => v.branch === "feat/landed")?.tidyable).toBe(true);
});

test("a squash-merged branch stays tidyable after the base edits the same file elsewhere", async () => {
    const { dir } = repo("squash-edited");
    commit(dir, "list.txt", "a\nb\nc\nd\ne");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "checkout", "-q", "-b", "feat/sq");
    commit(dir, "list.txt", "a\nB\nc\nd\ne");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", "feat/sq");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "squash");
    // Base moves on and edits the same file on another line: the content proof alone refuses.
    commit(dir, "list.txt", "a\nB\nc\nd\nE");
    git(dir, "push", "-q", "origin", "main");

    const verdict = (await planTidy(dir)).verdicts.find((v) => v.branch === "feat/sq");
    expect(verdict?.tidyable).toBe(true);

    // The same shape with work base does NOT have is still refused.
    git(dir, "checkout", "-q", "-b", "feat/more", "feat/sq");
    commit(dir, "list.txt", "a\nB\nC\nd\ne");
    git(dir, "checkout", "-q", "main");
    const more = (await planTidy(dir)).verdicts.find((v) => v.branch === "feat/more");
    expect(more?.tidyable).toBe(false);
    expect(more?.reason).toBe("not-contained");
});

// An abandoned agent worktree pins its branch as "checked out elsewhere" forever - measured in
// one repository, 34 of 41 branches were held that way. tidy removes a worktree only when it is
// clean, merged and idle; any one of those missing keeps it.
test("an idle, clean, merged worktree is removed and its branch freed; a dirty, fresh or unmerged one is kept", async () => {
    const { utimesSync } = await import("node:fs");
    const { dir } = repo("worktrees");
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const age = (path: string): void => {
        const gitDir = git(path, "rev-parse", "--absolute-git-dir");
        for (const f of [path, join(gitDir, "HEAD"), join(gitDir, "index"), join(gitDir, "logs", "HEAD")]) {
            try { utimesSync(f, old, old); } catch { /* absent */ }
        }
    };
    const add = (name: string, merged: boolean): string => {
        const path = mkdtempSync(join(tmpdir(), `enigma-tidy-wt-${name}-`));
        rmSync(path, { recursive: true, force: true });
        dirs.push(path);
        git(dir, "worktree", "add", "-q", "-b", name, path, "main");
        commit(path, `${name}.txt`);
        if (merged) { git(dir, "merge", "-q", "--no-edit", name); git(dir, "push", "-q", "origin", "main"); }
        return path;
    };
    const done = add("done", true);
    const dirty = add("dirty", true);
    writeFileSync(join(dirty, "scratch.txt"), "uncommitted\n");
    const fresh = add("fresh", true);
    const open = add("open", false);
    for (const p of [done, dirty, open]) age(p);

    const result = await tidy(dir);
    const slashes = (p: string): string => p.split("\\").join("/");
    expect(result.worktrees.map(slashes)).toEqual([slashes(done)]);
    expect(existsSync(done)).toBe(false);
    expect(result.deleted).toContain("done");
    for (const kept of [dirty, fresh, open]) expect(existsSync(kept)).toBe(true);
    expect(git(dir, "branch", "--list", "dirty", "fresh", "open").split("\n").length).toBe(3);
}, 120_000);

// The turn-end hook tidies in the background at most once an hour per repository.
test("a background tidy is claimed once an hour per repository", async () => {
    const { claimBackgroundTidy } = await import("../src/git-tidy");
    const now = Date.now();
    expect(claimBackgroundTidy("C:/repo/a", now)).toBe(true);
    expect(claimBackgroundTidy("C:/repo/a", now + 60_000)).toBe(false);
    expect(claimBackgroundTidy("C:/REPO/A", now + 60_000)).toBe(false);
    expect(claimBackgroundTidy("C:/repo/b", now)).toBe(true);
});

// A branch that exists only on the remote is deleted there only when it is merged, nothing is in
// review on it, AND a merged PR had it as head at that very sha; an unreadable list keeps them all.
// A long-lived branch (the base of some PR, or the head of several merged PRs) is always kept.
test("a remote-only branch goes only when merged through a PR at its tip", async () => {
    const { remoteOnlyBranches } = await import("../src/git-tidy");
    const { dir } = repo("remote-only");
    for (const name of ["merged-a", "in-review", "unmerged", "staging", "moved-on", "release/1", "next"]) {
        git(dir, "checkout", "-q", "-b", name, "main");
        commit(dir, `${name.replace("/", "-")}.txt`);
        git(dir, "push", "-q", "origin", name);
        git(dir, "checkout", "-q", "main");
    }
    git(dir, "merge", "-q", "--no-edit", "merged-a", "in-review", "staging", "moved-on", "release/1", "next");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "fetch", "-q", "origin");
    const tip = (name: string) => git(dir, "rev-parse", name).trim();
    const merged = new Map([["merged-a", [tip("merged-a")]], ["moved-on", ["0".repeat(40)]], ["release/1", [tip("release/1")]], ["next", ["1".repeat(40), tip("next")]]]);
    for (const name of ["merged-a", "in-review", "unmerged", "staging", "moved-on", "release/1", "next"]) git(dir, "branch", "-q", "-D", name);

    const plan = await planTidy(dir);
    const found = await remoteOnlyBranches(dir, "origin", plan, async () => ({ open: new Set(["in-review"]), merged, bases: new Set(["main", "release/1"]) }));
    expect(found.verdicts.map((v) => v.branch)).toEqual(["merged-a"]);
    const unreadable = await remoteOnlyBranches(dir, "origin", plan, async () => null);
    expect(unreadable.verdicts).toEqual([]);
    expect(unreadable.note).toContain("left alone");
}, 120_000);

// The background run never moves the checkout: a branch just created for the next turn has no
// commits yet, so it is contained in main, and deleting it would put that turn's work on main.
test("keepCurrent never switches off or deletes the checked-out branch", async () => {
    const { dir } = repo("keep-current");
    git(dir, "checkout", "-q", "-b", "feat/fresh", "main");
    const result = await tidy(dir, { remote: "", keepCurrent: true });
    expect(result.switched).toBe(false);
    expect(result.deleted).not.toContain("feat/fresh");
    expect(git(dir, "branch", "--show-current").trim()).toBe("feat/fresh");
}, 120_000);

test("tidy prunes remote-tracking refs whose branch is gone on the remote", async () => {
    const { dir, remote } = repo("prune");
    git(dir, "push", "-q", "origin", "main:gone");
    git(dir, "fetch", "-q", "origin");
    git(remote, "branch", "-q", "-D", "gone");
    const result = await tidy(dir);
    expect(result.pruned).toBe(1);
    expect(git(dir, "branch", "-r")).not.toContain("origin/gone");
}, 120_000);

/** A gate mirror where enigma keeps it (`<home>/.enigma/gate/repos/<id>.git`), wired as the `gate` remote. */
function gateMirror(dir: string, id: string): string {
    const bare = join(HOME, ".enigma", "gate", "repos", `${id}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main", ".");
    git(dir, "remote", "add", "gate", bare);
    return bare;
}

/** Make a ref in a bare repo look last moved `hours` ago. */
function age(bare: string, branch: string, hours: number): void {
    const when = new Date(Date.now() - hours * 3600_000);
    utimesSync(join(bare, "refs", "heads", ...branch.split("/")), when, when);
}

test("merged, idle branches leave the gate mirror; unmerged or recent ones stay", async () => {
    const { dir } = repo("mirror");
    const bare = gateMirror(dir, "mirror1");
    branchWithWork(dir, "feat/landed", "landed.txt");
    branchWithWork(dir, "feat/open", "open.txt");
    branchWithWork(dir, "feat/fresh", "fresh.txt");
    git(dir, "push", "-q", "gate", "feat/landed", "feat/open", "feat/fresh", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge landed", "feat/landed");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge fresh", "feat/fresh");
    git(dir, "push", "-q", "origin", "main");
    for (const b of ["feat/landed", "feat/open", "feat/fresh"]) git(dir, "branch", "-D", b);
    git(dir, "fetch", "-q", "gate");
    age(bare, "feat/landed", 24);
    age(bare, "feat/open", 24);

    const dry = await tidy(dir, { dryRun: true });
    expect(dry.mirror.map((m) => m.branch)).toEqual(["feat/landed"]);
    expect(git(bare, "branch", "--list", "feat/landed")).not.toBe("");

    const result = await tidy(dir);
    expect(result.problems).toEqual([]);
    expect(result.mirror.map((m) => m.branch)).toEqual(["feat/landed"]);
    expect(git(bare, "branch", "--list", "feat/landed")).toBe("");
    expect(git(bare, "branch", "--list", "feat/open")).not.toBe("");
    expect(git(bare, "branch", "--list", "feat/fresh")).not.toBe("");
    expect(git(dir, "branch", "-r", "--list", "gate/feat/landed")).toBe("");
    expect(git(dir, "branch", "-r", "--list", "gate/feat/open")).not.toBe("");
    // Written down first, and restorable from what the report prints.
    const entry = readLedger().find((e) => e.branch === "gate/feat/landed");
    expect(entry?.sha).toBe(result.mirror[0]!.sha);
    git(dir, `--git-dir=${bare}`, "branch", "feat/landed", entry!.sha);
    expect(git(bare, "rev-parse", "feat/landed")).toBe(entry!.sha);
});

test("a remote called gate that is not enigma's mirror is never touched", async () => {
    const { dir } = repo("not-mirror");
    const elsewhere = mkdtempSync(join(tmpdir(), "enigma-tidy-foreign-gate-"));
    dirs.push(elsewhere);
    git(elsewhere, "init", "-q", "--bare", "-b", "main", ".");
    git(dir, "remote", "add", "gate", elsewhere);
    branchWithWork(dir, "feat/theirs", "theirs.txt");
    git(dir, "push", "-q", "gate", "feat/theirs");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/theirs");
    git(dir, "branch", "-D", "feat/theirs");
    git(dir, "fetch", "-q", "gate");
    const when = new Date(Date.now() - 48 * 3600_000);
    utimesSync(join(elsewhere, "refs", "heads", "feat", "theirs"), when, when);
    const result = await tidy(dir);
    expect(result.mirror).toEqual([]);
    expect(git(elsewhere, "branch", "--list", "feat/theirs")).not.toBe("");
});

test("tracking refs of a remote that no longer exists go when merged, stay when they hold work", async () => {
    const { dir } = repo("orphan-refs");
    branchWithWork(dir, "feat/merged", "m.txt");
    branchWithWork(dir, "feat/only-there", "o.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/merged");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "update-ref", "refs/remotes/gone/main", git(dir, "rev-parse", "feat/merged"));
    git(dir, "update-ref", "refs/remotes/gone/wip", git(dir, "rev-parse", "feat/only-there"));
    const result = await tidy(dir, { only: ["none"] });
    expect(result.orphanRefs.map((r) => r.ref)).toEqual(["refs/remotes/gone/main"]);
    expect(git(dir, "for-each-ref", "refs/remotes/gone")).toContain("refs/remotes/gone/wip");
    expect(git(dir, "for-each-ref", "refs/remotes/gone")).not.toContain("refs/remotes/gone/main");
    expect(result.notes.some((n) => n.includes("gone/wip"))).toBe(true);
});
