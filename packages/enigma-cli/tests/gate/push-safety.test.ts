/**
 * The push step must never overwrite work that reached the remote while a run was in flight.
 *
 * The real case: a bot pushed a commit to main during a gate run, and the run's push replaced
 * it, because its --force-with-lease took the lease from whatever the remote held at push time -
 * which protects nothing. On the default branch the step now replays the run onto the remote tip
 * and pushes as a fast-forward; a conflict stops the step instead.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-push-safety-"));
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
// The push step hands a default-branch push to the CI notifier; a test must not spawn it.
writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ ciWatch: false }));

const { newPushStep } = await import("../../src/gate/pipeline/steps/push");
const { loadGlobal, loadRepoFromBytes, merge } = await import("../../src/gate/config");

const dirs: string[] = [HOME];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.test", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tmp(label: string): string {
    const d = mkdtempSync(join(tmpdir(), `enigma-push-${label}-`));
    dirs.push(d);
    return d;
}

/** A bare remote on main, a run worktree with one new commit, and a second clone (the bot). */
function scenario(): { remote: string; work: string; bot: string; } {
    const remote = tmp("remote");
    git(remote, "init", "-q", "--bare", "-b", "main", ".");
    const seed = tmp("seed");
    git(seed, "init", "-q", "-b", "main", ".");
    writeFileSync(join(seed, "base.txt"), "base\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "base");
    git(seed, "push", "-q", remote, "main");
    const work = tmp("work");
    git(work, "clone", "-q", remote, ".");
    // The replay commits in the worktree; a real gate worktree has the user's identity.
    git(work, "config", "user.name", "t");
    git(work, "config", "user.email", "t@e.test");
    writeFileSync(join(work, "run.txt"), "run\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "run change");
    const bot = tmp("bot");
    git(bot, "clone", "-q", remote, ".");
    return { remote, work, bot };
}

function context(work: string, remote: string) {
    const config = merge(loadGlobal(join(HOME, "no-config.yaml")), loadRepoFromBytes(""));
    const logs: string[] = [];
    const sctx = {
        signal: new AbortController().signal,
        config,
        log: (m: string) => { logs.push(m); },
        workDir: work,
        repo: { workingPath: work, defaultBranch: "main", forkUrl: "", upstreamUrl: remote },
        run: { id: "r1", branch: "main", headSha: git(work, "rev-parse", "HEAD") },
        db: { sql: { query: () => ({ run: () => undefined }) } },
    };
    return { sctx: sctx as never, logs };
}

test("a commit that landed on main during the run is kept, and the run lands on top of it", async () => {
    const { remote, work, bot } = scenario();
    writeFileSync(join(bot, "preview.txt"), "bot\n");
    git(bot, "add", "-A");
    git(bot, "commit", "-q", "-m", "bot: refresh preview");
    git(bot, "push", "-q", "origin", "main");
    const botSha = git(bot, "rev-parse", "HEAD");

    const { sctx, logs } = context(work, remote);
    await newPushStep().execute(sctx);

    const history = git(remote, "log", "--format=%s", "main");
    expect(history.split("\n")).toEqual(["run change", "bot: refresh preview", "base"]);
    expect(git(remote, "merge-base", "--is-ancestor", botSha, "main") === "").toBe(true);
    expect(logs.join("\n")).toContain("moved on the remote during the run");
}, 60_000);

test("a conflicting commit on main stops the step instead of choosing a side", async () => {
    const { remote, work, bot } = scenario();
    writeFileSync(join(bot, "run.txt"), "someone else\n");
    git(bot, "add", "-A");
    git(bot, "commit", "-q", "-m", "conflicting change");
    git(bot, "push", "-q", "origin", "main");
    const before = git(remote, "rev-parse", "main");

    const { sctx } = context(work, remote);
    await expect(newPushStep().execute(sctx)).rejects.toThrow("do not replay onto it cleanly");
    expect(git(remote, "rev-parse", "main")).toBe(before);
}, 60_000);

test("with nothing new on the remote the push is a plain fast-forward", async () => {
    const { remote, work } = scenario();
    const { sctx } = context(work, remote);
    await newPushStep().execute(sctx);
    expect(git(remote, "log", "-1", "--format=%s", "main")).toBe("run change");
}, 60_000);
