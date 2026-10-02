/**
 * A run parked on "merge the PR" must close as soon as the PR is merged, not on the
 * next full CI poll (up to two minutes later), or the status bar keeps telling the
 * user to merge something they already merged.
 */
import { test, expect } from "bun:test";
import { watchPRSettle } from "@/gate/pipeline/steps/ci";

const pr = { number: "7", url: "https://github.com/o/r/pull/7" };

function harness(states: Array<string | Error>) {
    const waits: number[] = [];
    let reads = 0;
    const host = {
        getPRState: async () => {
            reads++;
            const next = states.shift() ?? "OPEN";
            if (next instanceof Error) throw next;
            return next;
        }
    };
    const wait = async (_signal: AbortSignal, ms: number) => { waits.push(ms); };
    return { host, wait, waits, reads: () => reads };
}

test("returns as soon as the PR is merged", async () => {
    const h = harness(["OPEN", "MERGED"]);
    const state = await watchPRSettle(h.host, pr, 120_000, 5_000, new AbortController().signal, h.wait);
    expect(state).toBe("MERGED");
    expect(h.waits).toEqual([5_000, 5_000]);
});

test("returns a closed PR too", async () => {
    const h = harness(["CLOSED"]);
    expect(await watchPRSettle(h.host, pr, 30_000, 5_000, new AbortController().signal, h.wait)).toBe("CLOSED");
});

test("never waits past the full-poll interval, and returns null when still open", async () => {
    const h = harness([]);
    const state = await watchPRSettle(h.host, pr, 12_000, 5_000, new AbortController().signal, h.wait);
    expect(state).toBeNull();
    expect(h.waits).toEqual([5_000, 5_000, 2_000]);
    expect(h.reads()).toBe(3);
});

test("a failed read keeps watching instead of ending the wait", async () => {
    const h = harness([new Error("network"), "MERGED"]);
    expect(await watchPRSettle(h.host, pr, 60_000, 5_000, new AbortController().signal, h.wait)).toBe("MERGED");
});

test("a cancelled run stops the watch", async () => {
    const ctl = new AbortController();
    const host = { getPRState: async () => { ctl.abort("run cancelled"); throw new Error("aborted"); } };
    await expect(watchPRSettle(host, pr, 60_000, 5_000, ctl.signal, async () => {})).rejects.toThrow("run cancelled");
});

/**
 * Through the real CIStep loop: green checks park the run on "merge the PR", and a
 * merge seen by the fast watch ends the step after one watch interval - not after the
 * full-poll interval the step would otherwise sleep.
 */
test("CIStep closes on a merge seen between full polls", async () => {
    const { mock } = await import("bun:test");
    const real = await import("@/gate/pipeline/steps/host");
    const reads: string[] = [];
    let stateReads = 0;
    const fakeHost = {
        provider: () => "github",
        capabilities: () => ({ mergeableState: false, failedCheckLogs: false, conditionalPRState: true }),
        available: async () => {},
        // Full poll: open. First fast re-read: still open. Second: merged.
        getPRState: async () => {
            stateReads++;
            reads.push("state");
            return stateReads >= 3 ? "MERGED" : "OPEN";
        },
        getChecks: async () => {
            reads.push("checks");
            return [{ name: "build", bucket: "pass", completedAt: new Date() }];
        }
    };
    mock.module("@/gate/pipeline/steps/host", () => ({ ...real, buildHost: () => [fakeHost, ""] }));
    const { CIStep } = await import("@/gate/pipeline/steps/ci");

    const blocked: string[] = [];
    const logs: string[] = [];
    const step = new CIStep();
    step.checksGracePeriod = 1;
    // The steady-state full-poll interval, where a merge used to wait up to two minutes.
    step.pollIntervalOverride = 120_000;
    const waits: number[] = [];
    step.waitForNextPoll = async (_s, ms) => { waits.push(ms); };
    step.baseBranchTip = async () => ["", false];
    const sctx = {
        signal: new AbortController().signal,
        repo: { upstreamUrl: "https://github.com/o/r.git", defaultBranch: "main" },
        run: { id: "r1", prUrl: "https://github.com/o/r/pull/7", baseSha: "", headSha: "" },
        config: { ciTimeout: -1, autoFix: { ci: 0 } },
        fixing: false,
        workDir: ".",
        log: (m: string) => { logs.push(m); },
        setBlocked: (r: string) => { blocked.push(r); }
    };
    const outcome = await step.execute(sctx as never);

    expect(logs).toContain("PR has been merged!");
    expect(blocked).toEqual(["merge the PR"]);
    // Two 5s watch steps instead of one 120s sleep.
    expect(waits).toEqual([5_000, 5_000]);
    expect(reads).toEqual(["state", "checks", "state", "state"]);
    expect(outcome.skipped ?? false).toBe(false);
});
