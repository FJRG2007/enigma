/**
 * The push guard refuses a `git push` that would erase commits someone else pushed. The real
 * case: an agent force-pushed a shared `develop` and a teammate's commit vanished from the
 * remote. Pinned against real repositories, since the verdict comes from what the remote holds.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { foreignLostCommits, parsePush, pushRefusal, runPushGuardHook } from "@/push-guard";

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

test("refuses a force push that would erase a teammate's commit, and the remote keeps it", () => {
    const { me, mate } = scenario();
    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop");
    commit(me, "me@e.test", "docs.txt", "docs: mine");
    git(me, "me@e.test", "fetch", "-q", "origin");
    for (const command of ["git push --force origin develop", "git push -f", "cd . && git push --force-with-lease origin develop", "git push origin +develop", "git push origin --delete develop", "bash -c \"git push -f origin develop\"", "powershell -Command \"git push --force origin develop\""]) {
        expect(pushRefusal(command, me)).toContain("feat: usage alerts");
        expect(runPushGuardHook(payload(command, me))).toBe(2);
    }
}, 120_000);

test("lets through a plain push, a rewrite of the user's own commits, and a rebase onto the teammate", () => {
    const { me, mate } = scenario();
    commit(me, "me@e.test", "docs.txt", "docs: first");
    git(me, "me@e.test", "push", "-q", "origin", "develop");
    git(me, "me@e.test", "commit", "-q", "--amend", "-m", "docs: amended");
    expect(runPushGuardHook(payload("git push --force-with-lease origin develop", me))).toBe(0);
    git(me, "me@e.test", "push", "-q", "--force-with-lease", "origin", "develop");

    commit(mate, "mate@e.test", "alerts.txt", "feat: usage alerts");
    git(mate, "mate@e.test", "pull", "-q", "--rebase", "origin", "develop");
    git(mate, "mate@e.test", "push", "-q", "origin", "develop");
    git(me, "me@e.test", "pull", "-q", "--rebase", "origin", "develop");
    git(me, "me@e.test", "commit", "-q", "--amend", "-m", "docs: amended again");
    expect(runPushGuardHook(payload("git push origin develop", me))).toBe(0);
    expect(pushRefusal("git push --force origin develop", me)).toBe("");
}, 120_000);

test("refuses a force push it cannot verify, and --mirror outright", () => {
    const { me } = scenario();
    expect(pushRefusal("git push --force nowhere develop", me)).toContain("could not verify");
    expect(pushRefusal("git push --mirror origin", me)).toContain("every branch");
    expect(runPushGuardHook("not json")).toBe(0);
}, 120_000);
