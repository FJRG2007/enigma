/**
 * The push guard refuses a `git push` that would erase commits someone else pushed. The real
 * case: an agent force-pushed a shared `develop` and a teammate's commit vanished from the
 * remote. Pinned against real repositories, since the verdict comes from what the remote holds.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { applyGitPushGuard, foreignLostCommits, parsePush, prePushRefusal, pushRefusal, runPushGuardHook } from "@/push-guard";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(label: string): string {
    const d = mkdtempSync(join(tmpdir(), `enigma-push-guard-${label}-`));
    dirs.push(d);
    return d;
}

function git(dir: string, email: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=x", "-c", `user.email=${email}`, "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, email: string, file: string, message: string): void {
    writeFileSync(join(dir, file), `${message}\n`);
    git(dir, email, "add", "-A");
    git(dir, email, "commit", "-q", "-m", message);
}

/** A bare remote with develop, the agent's clone (me@e.test) and a teammate's clone. */
function scenario(): { me: string; mate: string; } {
    const remote = tmp("remote");
    git(remote, "me@e.test", "init", "-q", "--bare", "-b", "develop", ".");
    const me = tmp("me");
    git(me, "me@e.test", "init", "-q", "-b", "develop", ".");
    git(me, "me@e.test", "config", "user.email", "me@e.test");
    commit(me, "me@e.test", "base.txt", "base");
    git(me, "me@e.test", "remote", "add", "origin", remote);
    git(me, "me@e.test", "push", "-q", "-u", "origin", "develop");
    const mate = tmp("mate");
    git(mate, "mate@e.test", "clone", "-q", remote, ".");
    return { me, mate };
}

const payload = (command: string, cwd: string): string => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });

test("parses the shapes that rewrite a branch and ignores the ones that do not", () => {
    expect(parsePush("git push", ".")!.targets).toEqual([]);
    expect(parsePush("git push origin develop", ".")!.targets).toEqual([]);
    expect(parsePush("git push --force-if-includes origin develop", ".")!.targets).toEqual([]);
    expect(parsePush("git push -f", ".")!.targets).toEqual([{ branch: "HEAD", source: "HEAD" }]);
    expect(parsePush("git push --force-with-lease origin develop", ".")!.targets).toEqual([{ branch: "develop", source: "develop" }]);
    expect(parsePush("git push origin +HEAD:refs/heads/develop", ".")!.targets).toEqual([{ branch: "develop", source: "HEAD" }]);
    expect(parsePush("git push origin :develop", ".")!.targets).toEqual([{ branch: "develop", source: null }]);
    expect(parsePush("git push -d origin develop", ".")!.targets).toEqual([{ branch: "develop", source: null }]);
    expect(parsePush("git push --mirror", ".")!.wholesale).toBe("--mirror");
    expect(parsePush("git push --all origin", ".")!.wholesale).toBe("");
    expect(parsePush("git push --all -f origin", ".")!.wholesale).toBe("--all");
    expect(parsePush("git -C sub -c a=b push -uf origin x", "/r")!.targets).toEqual([{ branch: "x", source: "x" }]);
    expect(parsePush("git status", ".")).toBeNull();
});

test("a lost commit counts only when it has no rebase on the pushed side and is not the user's", () => {
    const cherry = "+ aaa\n- bbb\n+ ccc";
    const log = "aaa\x1fMate\x1fmate@e.test\x1ffeat: alerts\nbbb\x1fMate\x1fmate@e.test\x1fx\nccc\x1fMe\x1fME@e.test\x1fmine";
    expect(foreignLostCommits(cherry, log, "me@e.test").map((c) => c.sha)).toEqual(["aaa"]);
});

test("refuses a force push that would erase a teammate's commit, and the remote keeps it", async () => {
    const { me, mate } = scenario();
    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop");
    commit(me, "me@e.test", "docs.txt", "docs: mine");
    git(me, "me@e.test", "fetch", "-q", "origin");
    for (const command of ["git push --force origin develop", "git push -f", "cd . && git push --force-with-lease origin develop", "git push origin +develop", "git push origin --delete develop", "bash -c \"git push -f origin develop\"", "powershell -Command \"git push --force origin develop\""]) {
        expect(await pushRefusal(command, me)).toContain("feat: usage alerts");
        expect(await runPushGuardHook(payload(command, me))).toBe(2);
    }
}, 120_000);

test("lets through a plain push, a rewrite of the user's own commits, and a rebase onto the teammate", async () => {
    const { me, mate } = scenario();
    commit(me, "me@e.test", "docs.txt", "docs: first");
    git(me, "me@e.test", "push", "-q", "origin", "develop");
    git(me, "me@e.test", "commit", "-q", "--amend", "-m", "docs: amended");
    expect(await runPushGuardHook(payload("git push --force-with-lease origin develop", me))).toBe(0);
    git(me, "me@e.test", "push", "-q", "--force-with-lease", "origin", "develop");

    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "pull", "-q", "--rebase", "origin", "develop");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop");
    git(me, "me@e.test", "pull", "-q", "--rebase", "origin", "develop");
    git(me, "me@e.test", "commit", "-q", "--amend", "-m", "docs: amended again");
    expect(await runPushGuardHook(payload("git push origin develop", me))).toBe(0);
    expect(await pushRefusal("git push --force origin develop", me)).toBe("");
}, 120_000);

test("refuses a force push it cannot verify, and --mirror outright", async () => {
    const { me } = scenario();
    expect(await pushRefusal("git push --force nowhere develop", me)).toContain("could not verify");
    expect(await pushRefusal("git push --mirror origin", me)).toContain("every branch");
    expect(await runPushGuardHook("not json")).toBe(0);
}, 120_000);

test("refuses once the shared time budget is spent instead of letting the push through", async () => {
    const { me } = scenario();
    expect(await pushRefusal("git push --force origin develop", me, Date.now() - 1)).toContain("ran out of time");
}, 120_000);

test("a push without a remote is judged where git sends it, not against origin", async () => {
    const { me, mate } = scenario();
    const fork = tmp("fork");
    git(fork, "me@e.test", "init", "-q", "--bare", ".");
    git(me, "me@e.test", "remote", "rename", "origin", "upstream");
    git(me, "me@e.test", "remote", "add", "origin", fork);
    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop:shared");
    git(me, "me@e.test", "fetch", "-q", "upstream");
    git(me, "me@e.test", "branch", "-q", "-u", "upstream/shared");
    git(me, "me@e.test", "config", "push.default", "upstream");
    expect(await pushRefusal("git push -f", me)).toContain("upstream/shared would erase");
}, 120_000);

test("a deletion counts only the branches the remote holds now, not stale tracking refs", async () => {
    const { me, mate } = scenario();
    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop", "develop:old");
    git(me, "me@e.test", "fetch", "-q", "origin");
    git(mate, "mate@e.test", "push", "-q", "origin", "--delete", "old");
    expect(git(me, "me@e.test", "rev-parse", "--verify", "-q", "origin/old")).not.toBe("");
    expect(await pushRefusal("git push origin --delete develop", me)).toContain("feat: usage alerts");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop:kept");
    expect(await pushRefusal("git push origin --delete develop", me)).toBe("");
}, 120_000);

test("reads a remote tip it has never fetched without leaving a ref or moving origin/<branch>", async () => {
    const { me, mate } = scenario();
    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop", "develop:side");
    const tracking = git(me, "me@e.test", "rev-parse", "origin/develop");
    expect(await pushRefusal("git push -f origin develop", me)).toContain("feat: usage alerts");
    expect(await pushRefusal("git push origin :side", me)).toBe("");
    expect(git(me, "me@e.test", "for-each-ref", "refs/enigma/")).toBe("");
    expect(git(me, "me@e.test", "rev-parse", "origin/develop")).toBe(tracking);
}, 120_000);

/** Pushes from `dir` with only a global config holding the pre-push entry; returns git's exit code and stderr. */
function pushThroughHook(dir: string, globalConfig: string, ...args: string[]): { code: number; stderr: string; } {
    const cli = join(import.meta.dir, "..", "src", "bin", "enigma.ts").replace(/\\/g, "/");
    writeFileSync(globalConfig, `[hook "enigma-push-guard"]\n\tcommand = bun "${cli}" __pre-push-guard\n\tevent = pre-push\n`);
    try {
        execFileSync("git", ["push", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig } });
        return { code: 0, stderr: "" };
    } catch (err) {
        const e = err as { status: number; stderr: string; };
        return { code: e.status, stderr: e.stderr };
    }
}

test("git's own pre-push hook refuses the force push from any tool, and lets a normal push through", async () => {
    const { me, mate } = scenario();
    const config = join(tmp("gitconfig"), ".gitconfig");
    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop");
    commit(me, "me@e.test", "docs.txt", "docs: mine");
    const before = git(mate, "mate@e.test", "ls-remote", "origin", "refs/heads/develop");

    const forced = pushThroughHook(me, config, "--force", "origin", "develop");
    expect(forced.code).not.toBe(0);
    expect(forced.stderr).toContain("feat: usage alerts");
    expect(git(mate, "mate@e.test", "ls-remote", "origin", "refs/heads/develop")).toBe(before);
    expect(pushThroughHook(me, config, "origin", ":develop").stderr).toContain("deleting");

    git(me, "me@e.test", "pull", "-q", "--rebase", "origin", "develop");
    expect(pushThroughHook(me, config, "origin", "develop").code).toBe(0);
    expect(await prePushRefusal("origin", "refs/heads/develop abc refs/tags/v1 0000000000000000000000000000000000000000\n", me)).toBe("");
}, 180_000);

test("installs the global entry once, idempotently, and removes it", () => {
    const config = join(tmp("gitconfig"), ".gitconfig");
    writeFileSync(config, "[user]\n\tname = x\n");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
        expect(applyGitPushGuard(true)).toBe(true);
        expect(applyGitPushGuard(true)).toBe(false);
        const text = readFileSync(config, "utf8");
        expect(text).toContain("enigma __pre-push-guard");
        expect(text).toContain("name = x");
        expect(applyGitPushGuard(false)).toBe(true);
        expect(readFileSync(config, "utf8")).not.toContain("enigma-push-guard");
    } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    }
}, 60_000);
