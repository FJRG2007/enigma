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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-ci-watch-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const PRIOR_CONFIG_HOME = process.env.ENIGMA_CONFIG_HOME;
const PRIOR_WATCH_DIR = process.env.ENIGMA_CI_WATCH_DIR;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CI_WATCH_DIR = join(HOME, "ci-watch");

const { runCiWatchHook, ciWatchStatePath } = await import("@/ci-watch");
const { CONFIG_DEFAULTS } = await import("@/config");
const { ALL_SETTINGS } = await import("@/settings-registry");

const REPO = join(HOME, "repo").split(String.fromCharCode(92)).join("/");
const SHA = "c".repeat(40);

afterAll(() => {
    if (PRIOR_CONFIG_HOME === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = PRIOR_CONFIG_HOME;
    if (PRIOR_WATCH_DIR === undefined) delete process.env.ENIGMA_CI_WATCH_DIR;
    else process.env.ENIGMA_CI_WATCH_DIR = PRIOR_WATCH_DIR;
    rmSync(HOME, { recursive: true, force: true });
});

/** Seeds the state file as the poller would after reaching a verdict. */
function seedFailure(delivered = false): void {
    const path = ciWatchStatePath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
        version: 1,
        repos: {
            [REPO]: {
                repoPath: REPO, sha: SHA, at: Date.now(), delivered,
                failure: { sha: SHA, workflow: "CI", job: "linter", url: "https://example.com/run/1", log: "review.ts:18:1  imports should be sorted" }
            }
        }
    }));
}

/** Runs the hook and returns what it wrote to stdout. */
function hookOutput(cwd: string): string {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown; }).write = (c: string) => { chunks.push(String(c)); return true; };
    try { runCiWatchHook(JSON.stringify({ cwd })); } finally { (process.stdout as unknown as { write: unknown; }).write = write; }
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

test("a failure already delivered stays quiet, and another project's failure is never read here", () => {
    seedFailure(true);
    expect(hookOutput(REPO)).toBe("");
    // The state is keyed per repository, so a session elsewhere sees nothing of this one.
    expect(hookOutput(join(HOME, "somewhere-else"))).toBe("");
});
