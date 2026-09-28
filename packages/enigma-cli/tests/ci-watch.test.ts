/**
 * The CI failure notifier: a detached poller records what a push's workflow did, and the hook
 * hands a failure to the agent exactly once. The contract worth pinning is the cost model -
 * silence on green, silence on a failure already delivered - because a notifier that spoke on
 * every tool call would burn more context than the problem it solves.
 *
 * Temp HOME (set BEFORE the import) isolates the state file.
 * Must run under Bun: bun test tests/ci-watch.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// Every prior value is captured BEFORE anything is overwritten: reading HOME back after the
// assignment would capture the temp path and make the restore below point at the directory
// afterAll then deletes.
const PRIOR_HOME = process.env.HOME;
const PRIOR_USERPROFILE = process.env.USERPROFILE;
const PRIOR_CONFIG_HOME = process.env.ENIGMA_CONFIG_HOME;
const PRIOR_WATCH_DIR = process.env.ENIGMA_CI_WATCH_DIR;
const HOME = mkdtempSync(join(tmpdir(), "enigma-ci-watch-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CI_WATCH_DIR = join(HOME, "ci-watch");

const { runCiWatchHook, runCiWatchPoll, ciWatchStatePath, armGatePushWatch, waitForVerdict } = await import("@/ci-watch");
const { applyClaudeCiWatchHooks } = await import("@/ci-watch-deploy");
const { CONFIG_DEFAULTS } = await import("@/config");
const { ALL_SETTINGS } = await import("@/settings-registry");

const REPO = join(HOME, "repo").split(String.fromCharCode(92)).join("/");
const SHA = "c".repeat(40);

afterAll(() => {
    // `bun test` shares one process across files, and this one points HOME at a temp dir it
    // then deletes. Leaving it pointed there sends every file loaded afterwards at a home
    // that no longer exists. CI runs each file in its own step so it would not notice, which
    // is exactly why the restore has to be deliberate.
    if (PRIOR_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = PRIOR_HOME;
    if (PRIOR_USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = PRIOR_USERPROFILE;
    if (PRIOR_CONFIG_HOME === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = PRIOR_CONFIG_HOME;
    if (PRIOR_WATCH_DIR === undefined) delete process.env.ENIGMA_CI_WATCH_DIR;
    else process.env.ENIGMA_CI_WATCH_DIR = PRIOR_WATCH_DIR;
    rmSync(HOME, { recursive: true, force: true });
});

/** Seeds the state file as the poller would after reaching a verdict. */
function seedFailure(delivered = false, log = "review.ts:18:1  imports should be sorted"): void {
    const path = ciWatchStatePath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
        version: 1,
        repos: {
            [REPO]: {
                repoPath: REPO, sha: SHA, at: Date.now(), delivered,
                failure: { sha: SHA, workflow: "CI", job: "linter", url: "https://example.com/run/1", log }
            }
        }
    }));
}

/** Runs git in `cwd`, with an identity so committing works on a bare CI runner. */
function git(cwd: string, ...args: string[]): void {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

/** Runs the hook and returns what it wrote to stdout. */
function hookOutput(cwd: string, event = "PostToolUse"): string {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown; }).write = (c: string) => { chunks.push(String(c)); return true; };
    try { runCiWatchHook(JSON.stringify({ cwd }), event); } finally { (process.stdout as unknown as { write: unknown; }).write = write; }
    return chunks.join("");
}

test("the notifier is on by default and reaches all three surfaces through one registry entry", () => {
    expect(CONFIG_DEFAULTS.ciWatch).toBe(true);
    const setting = ALL_SETTINGS.find(s => s.key === "ci-watch");
    expect(setting).toBeDefined();
    expect(setting!.read("global")).toBe(true);
});

test("a recorded failure is handed over once, with the reason attached", () => {
    seedFailure();
    const first = hookOutput(REPO);
    // The whole point of the feature: the agent gets the failing log, not just "CI is red".
    expect(first).toContain("FAILED");
    expect(first).toContain("CI / linter");
    expect(first).toContain("imports should be sorted");
    expect(first).toContain("additionalContext");

    // Delivered once. A broken build re-announcing itself at every tool boundary would cost
    // more context than the failure it reports.
    expect(hookOutput(REPO)).toBe("");
    const state = JSON.parse(readFileSync(ciWatchStatePath(), "utf8")) as { repos: Record<string, { delivered?: boolean; }>; };
    expect(state.repos[REPO]!.delivered).toBe(true);
});

test("UserPromptSubmit delivers but never arms", () => {
    // That hook chain runs before the turn starts and several tools share its budget - it was
    // already timing out on a loaded box before this feature was added to it. Arming costs
    // four git subprocesses, so it belongs on PostToolUse, where a push comes from anyway.
    seedFailure();
    expect(hookOutput(REPO, "UserPromptSubmit")).toContain("FAILED");

    // With nothing to deliver the event must be a pure state read: no repo is resolved, so a
    // path that is not a work tree at all still costs nothing and says nothing.
    expect(hookOutput(join(HOME, "not-a-repo"), "UserPromptSubmit")).toBe("");
});

test("a failure already delivered stays quiet, and another project's failure is never read here", () => {
    seedFailure(true);
    expect(hookOutput(REPO)).toBe("");
    // The state is keyed per repository, so a session elsewhere sees nothing of this one.
    expect(hookOutput(join(HOME, "somewhere-else"))).toBe("");
});

test("a failure with no readable log reports the run instead of an empty heading", () => {
    // `gh` cannot read the logs of an expired run. The heading with nothing under it read as
    // "fix this, reason withheld", which is worse than pointing at the run and saying no more.
    seedFailure(false, "");
    const out = hookOutput(REPO);
    expect(out).toContain("FAILED");
    expect(out).toContain("https://example.com/run/1");
    expect(out).not.toContain("The tail of the failing step's log");
});

test("pulling someone else's commit does not arm a watch", () => {
    // A pull leaves the upstream an ancestor of HEAD exactly like a push does, so the ancestor
    // test alone cannot tell them apart - and reporting a teammate's build would send the agent
    // after a break it did not cause. What separates them is why the tracking ref moved: git
    // writes "update by push" for a push and "<command>: fast-forward" for a pull.
    const remote = join(HOME, "remote.git");
    const clone = join(HOME, "clone");
    const other = join(HOME, "other");
    mkdirSync(remote, { recursive: true });
    git(HOME, "init", "-q", "--bare", "-b", "main", remote);
    git(HOME, "clone", "-q", remote, other);
    writeFileSync(join(other, "a.txt"), "a\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "a");
    git(other, "push", "-q", "origin", "main");
    git(HOME, "clone", "-q", remote, clone);

    writeFileSync(join(other, "b.txt"), "b\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "b");
    git(other, "push", "-q", "origin", "main");
    git(clone, "pull", "-q", "--no-rebase", "origin", "main");

    const before = readFileSync(ciWatchStatePath(), "utf8");
    expect(hookOutput(clone)).toBe("");
    // Nothing claimed: no entry for this repository, so no poller was spawned for it either.
    expect(readFileSync(ciWatchStatePath(), "utf8")).toBe(before);
    // Generous: this is the one test that builds real repositories, and cloning three times
    // on a cold Windows runner outruns the 5s default.
}, 60_000);

/** Reads the state file back. */
function readWatch(): { repos: Record<string, { sha: string; done?: boolean; delivered?: boolean; waiter?: { pid: number; }; failure?: unknown; }>; } {
    return JSON.parse(readFileSync(ciWatchStatePath(), "utf8"));
}

/** Seeds a commit the poller is still watching. */
function seedPending(extra: Record<string, unknown> = {}): void {
    const path = ciWatchStatePath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, repos: { [REPO]: { repoPath: REPO, sha: SHA, at: Date.now(), ...extra } } }));
}

/** Runs the hook for `event` and returns its exit code with what it wrote to each stream. */
function hookRun(cwd: string, event: string, options = {}): { code: number; out: string; err: string; } {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: unknown; }).write = (c: string) => { out.push(String(c)); return true; };
    (process.stderr as unknown as { write: unknown; }).write = (c: string) => { err.push(String(c)); return true; };
    let code = 0;
    try { code = runCiWatchHook(JSON.stringify({ cwd }), event, options); } finally {
        (process.stdout as unknown as { write: unknown; }).write = stdout;
        (process.stderr as unknown as { write: unknown; }).write = stderr;
    }
    return { code, out: out.join(""), err: err.join("") };
}

test("the background hook hands a failure over through exit 2, the code that wakes the model", () => {
    // `asyncRewake` feeds a hook's output to the model only on exit 2 - also after the turn has
    // ended, which is the case that used to need a person to relay the red build.
    seedFailure();
    const first = hookRun(REPO, "rewake");
    expect(first.code).toBe(2);
    expect(first.err).toContain("FAILED");
    expect(first.err).toContain("imports should be sorted");
    expect(first.out).toBe("");
    expect(readWatch().repos[REPO]!.delivered).toBe(true);
});

test("the background hook waits for a pending verdict and delivers the failure when it lands", async () => {
    seedPending();
    // The poller's write, from another process a moment later, exactly as it happens for real.
    const failure = { sha: SHA, workflow: "CI", job: "test", url: "https://example.com/run/2", log: "expected 1, got 2" };
    const verdict = JSON.stringify({ version: 1, repos: { [REPO]: { repoPath: REPO, sha: SHA, at: Date.now(), done: true, failure, waiter: { pid: process.pid, at: Date.now() } } } });
    const script = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(ciWatchStatePath())}, ${JSON.stringify(verdict)}), 300)`;
    const writer = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true });
    const exited = new Promise(resolve => writer.on("exit", resolve));
    const run = hookRun(join(REPO, "src"), "rewake", { intervalMs: 50, budgetMs: 20_000 });
    await exited;
    expect(run.code).toBe(2);
    expect(run.err).toContain("CI / test");
    expect(run.err).toContain("expected 1, got 2");
    const entry = readWatch().repos[REPO]!;
    expect(entry.delivered).toBe(true);
    expect(entry.waiter).toBeUndefined();
}, 30_000);

test("a green verdict ends the wait in silence, and a stopped poller never holds it", () => {
    // Green is the common case: zero bytes out, exit 0, so it costs no tokens at all.
    seedPending({ done: true });
    expect(hookRun(REPO, "rewake", { intervalMs: 10, budgetMs: 1000 })).toEqual({ code: 0, out: "", err: "" });
    // Budget spent with no verdict: give up quietly and release the claim for the next waiter.
    seedPending();
    expect(waitForVerdict(REPO, { intervalMs: 10, budgetMs: 50 })).toBeNull();
    expect(readWatch().repos[REPO]!.waiter).toBeUndefined();
});

test("a poller that stands down marks the commit done, so no hook waits out its budget", async () => {
    // gh unusable is the silent stand-down; before `done` existed it left the entry looking
    // pending forever and a waiting hook would sit on it for the whole half hour.
    seedPending();
    const prior = process.env.ENIGMA_GH_BIN;
    process.env.ENIGMA_GH_BIN = join(HOME, "no-such-gh");
    try { expect(await runCiWatchPoll(REPO, SHA)).toBe(0); } finally {
        if (prior === undefined) delete process.env.ENIGMA_GH_BIN;
        else process.env.ENIGMA_GH_BIN = prior;
    }
    const entry = readWatch().repos[REPO]!;
    expect(entry.done).toBe(true);
    expect(entry.failure).toBeUndefined();
});

test("one waiter per push: a live claim is honored, a dead one is taken over", () => {
    // The parent process is alive for as long as this test runs.
    seedPending({ waiter: { pid: process.ppid, at: Date.now() } });
    expect(waitForVerdict(REPO, { intervalMs: 10, budgetMs: 50 })).toBeNull();
    expect(readWatch().repos[REPO]!.waiter!.pid).toBe(process.ppid);
    // A session that closed left its claim behind; the next waiter must not honor it forever.
    seedPending({ waiter: { pid: 2 ** 22 + 7, at: Date.now() } });
    expect(waitForVerdict(REPO, { intervalMs: 10, budgetMs: 50 })).toBeNull();
    expect(readWatch().repos[REPO]!.waiter).toBeUndefined();
});

test("the legacy synchronous events never wait", () => {
    // A synchronous hook that waited would hold the agent's tool call until its timeout.
    seedPending();
    const started = Date.now();
    expect(hookRun(join(HOME, "not-a-repo-either"), "PostToolUse").code).toBe(0);
    expect(hookRun(REPO, "UserPromptSubmit")).toEqual({ code: 0, out: "", err: "" });
    expect(Date.now() - started).toBeLessThan(5_000);
});

test("a gate push to the default branch arms a watch; a PR branch or a fork does not", () => {
    // The gate pushes from its own worktree, so the checkout never records "update by push".
    // A PR branch has the gate's CI step behind it; only the default branch has nothing.
    seedPending({ sha: "0".repeat(40), done: true });
    const spawned: string[] = [];
    const stub = (root: string, sha: string): void => { spawned.push(`${root}@${sha}`); };
    const push = { repoPath: REPO.split("/").join(String.fromCharCode(92)), ref: "refs/heads/main", defaultBranch: "main", forkUrl: "", sha: SHA };
    expect(armGatePushWatch({ ...push, ref: "refs/heads/feature" }, stub)).toBe(false);
    expect(armGatePushWatch({ ...push, forkUrl: "https://example.com/fork.git" }, stub)).toBe(false);
    expect(armGatePushWatch(push, stub)).toBe(true);
    // Same commit again (a retried step): already claimed, no second poller.
    expect(armGatePushWatch(push, stub)).toBe(false);
    // Keyed under the same spelling the hook uses, whatever separators the gate stored.
    expect(spawned).toEqual([`${REPO}@${SHA}`]);
    const entry = readWatch().repos[REPO]!;
    expect(entry.sha).toBe(SHA);
    expect(entry.done).toBeUndefined();
});

test("the wiring is one background Bash hook, and the old per-prompt entry is removed", () => {
    const settings = join(HOME, "claude-settings.json");
    const theirs = { hooks: [{ type: "command", command: "their-own-prompt-hook" }] };
    const legacy = { hooks: [{ type: "command", command: "enigma __ci-hook UserPromptSubmit", timeout: 20 }] };
    writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [theirs, legacy] } }));
    applyClaudeCiWatchHooks(settings, true);
    const on = JSON.parse(readFileSync(settings, "utf8")) as { hooks: Record<string, unknown[]>; };
    expect(on.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "enigma __ci-hook rewake", timeout: 2400, asyncRewake: true }] }]);
    // It spawned the binary before every prompt and timed out doing it; the user's own stays.
    expect(on.hooks.UserPromptSubmit).toEqual([theirs]);
    applyClaudeCiWatchHooks(settings, false);
    expect(readFileSync(settings, "utf8")).not.toContain("__ci-hook");
});

test("the launcher answers the hook from the Node bundle, without starting the binary", () => {
    const root = join(import.meta.dir, "..");
    const bundle = join(root, "dist", "ci-watch.js");
    if (!existsSync(bundle)) {
        const built = spawnSync("npx", ["tsup"], { cwd: root, encoding: "utf8", shell: true, windowsHide: true, timeout: 120_000 });
        expect(built.status, built.stderr || "").toBe(0);
    }
    seedFailure();
    // ENIGMA_BIN_PATH points at a runtime that cannot run `__ci-hook`: a fall-through would not
    // exit 2 with the report.
    const run = spawnSync(process.execPath, [join(root, "bin", "enigma.mjs"), "__ci-hook", "rewake"], {
        encoding: "utf8",
        input: JSON.stringify({ cwd: REPO }),
        windowsHide: true,
        env: { ...process.env, HOME, USERPROFILE: HOME, ENIGMA_CONFIG_HOME: HOME, ENIGMA_CI_WATCH_DIR: join(HOME, "ci-watch"), ENIGMA_BIN_PATH: process.execPath }
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("FAILED");
}, 180_000);
