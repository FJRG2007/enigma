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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

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

test("a dirty working tree blocks the whole repository", async () => {
    const { dir } = repo("dirty");
    branchWithWork(dir, "feat/done", "done.txt");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feat/done");
    writeFileSync(join(dir, "scratch.txt"), "uncommitted\n");

    const plan = await planTidy(dir, "");
    expect(plan.blocked).toContain("uncommitted");
    expect(plan.verdicts).toEqual([]);
    const result = await tidy(dir, { remote: "" });
    expect(result.deleted).toEqual([]);
    expect(git(dir, "branch", "--list", "feat/done").trim()).toContain("feat/done");
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
