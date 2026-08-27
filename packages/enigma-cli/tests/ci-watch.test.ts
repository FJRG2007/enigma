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
import { spawnSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

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

const { runCiWatchHook, ciWatchStatePath } = await import("@/ci-watch");
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
