/**
 * Pipeline executor: the approval/fix coordination ported from Go's channel +
 * mutex to promises + AbortSignal. Drives mock steps + a mock agent against a
 * real bun:sqlite DB and asserts the run/step lifecycle for the pass, approve,
 * user-fix, auto-fix, skip-remaining, and abort paths.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const DIR = mkdtempSync(join(tmpdir(), "enigma-gate-exec-"));
process.env.USERPROFILE = DIR;
process.env.HOME = DIR;

const { Database, newId, insertRepoWithIDAndFork, insertRun, getRun, getStepsByRun } = await import("@/gate/db");
const { Executor } = await import("@/gate/pipeline/executor");
const { newStepOutcome } = await import("@/gate/pipeline/types");
const { merge, loadGlobal, loadRepoFromBytes } = await import("@/gate/config");
import type { StepName } from "@/gate/types";
import type { Step, StepContext, StepOutcome } from "@/gate/pipeline/types";

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const mockAgent = {
    name: () => "mock",
    run: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
    close: async () => {}
};

const paths = { runLogDir: (runId: string) => join(DIR, "logs", runId) };

/** A scripted step: each call returns the next outcome from `outcomes`. */
class MockStep implements Step {
    calls = 0;
    constructor(private readonly stepName: StepName, private readonly outcomes: Partial<StepOutcome>[]) {}
    name(): StepName {
        return this.stepName;
    }
    async execute(_sctx: StepContext): Promise<StepOutcome> {
        const idx = Math.min(this.calls, this.outcomes.length - 1);
        this.calls++;
        return newStepOutcome(this.outcomes[idx]);
    }
}

function setup() {
    const db = new Database(join(DIR, `${newId()}.sqlite`));
    const repo = insertRepoWithIDAndFork(db, newId(), join(DIR, "work", newId()), "git@github.com:o/r.git", "", "main");
    const run = insertRun(db, repo.id, "feature", "head", "base");
    return { db, repo, run };
}

async function waitUntil(pred: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > ms) throw new Error("waitUntil timed out");
        await new Promise(r => setTimeout(r, 5));
    }
}

test("a passing step completes the run", async () => {
    const { db, repo, run } = setup();
    const step = new MockStep("review", [{}]);
    const ex = new Executor(db, paths, null, mockAgent, [step]);
    await ex.execute(new AbortController().signal, run, repo, repo.workingPath);
    expect(getRun(db, run.id)?.status).toBe("completed");
    expect(getStepsByRun(db, run.id).find(s => s.stepName === "review")?.status).toBe("completed");
    db.close();
});

test("a needs-approval step parks, then approve completes it", async () => {
    const { db, repo, run } = setup();
    const findings = "{\"findings\":[{\"id\":\"r1\",\"severity\":\"warning\",\"description\":\"x\",\"action\":\"ask-user\"}]}";
    const step = new MockStep("review", [{ needsApproval: true, findings }]);
    const ex = new Executor(db, paths, null, mockAgent, [step]);
    const done = ex.execute(new AbortController().signal, run, repo, repo.workingPath);

    await waitUntil(() => getRun(db, run.id)?.awaitingAgentSince != null);
    ex.respond("review", "approve", []);
    await done;

    expect(getRun(db, run.id)?.status).toBe("completed");
    expect(getRun(db, run.id)?.awaitingAgentSince).toBeNull(); // marker cleared
    expect(step.calls).toBe(1);
    db.close();
});

test("a step that parks on the user records the reason, and the executor clears it", async () => {
    // What this pins: the ci step stays `running` while it waits for a human to
    // merge, so the only thing that can tell the user the pipeline is on them is
    // this marker. It has to survive while the step waits and be gone once it
    // returns, or the bar keeps saying "needs you" at a finished run.
    const { db, repo, run } = setup();
    const seen: (string | null)[] = [];
    const step: Step = {
        name: () => "ci" as StepName,
        execute: async (sctx: StepContext): Promise<StepOutcome> => {
            sctx.setBlocked("merge the PR");
            seen.push(getRun(db, run.id)?.blockedReason ?? null);
            return newStepOutcome({});
        }
    };
    const ex = new Executor(db, paths, null, mockAgent, [step]);
    await ex.execute(new AbortController().signal, run, repo, repo.workingPath);

    expect(seen).toEqual(["merge the PR"]);
    expect(getRun(db, run.id)?.blockedReason).toBeNull();
    db.close();
});

test("user fix re-executes the step then completes", async () => {
    const { db, repo, run } = setup();
    const findings = "{\"findings\":[{\"id\":\"r1\",\"severity\":\"error\",\"description\":\"bug\",\"action\":\"auto-fix\"}]}";
    // Round 1 needs approval; round 2 (after fix) is clean.
    const step = new MockStep("review", [{ needsApproval: true, findings }, {}]);
    const ex = new Executor(db, paths, null, mockAgent, [step]);
    const done = ex.execute(new AbortController().signal, run, repo, repo.workingPath);

    await waitUntil(() => getRun(db, run.id)?.awaitingAgentSince != null);
    ex.respond("review", "fix", ["r1"]);
    await done;

    expect(step.calls).toBe(2); // re-executed in fixing mode
    expect(getRun(db, run.id)?.status).toBe("completed");
    db.close();
});

test("auto-fix loops up to the configured limit without user input", async () => {
    const { db, repo, run } = setup();
    const cfg = merge(loadGlobal("/none"), loadRepoFromBytes("auto_fix:\n  review: 1\n"));
    const findings = "{\"findings\":[{\"id\":\"r1\",\"severity\":\"error\",\"description\":\"bug\",\"action\":\"auto-fix\"}]}";
    // Round 1 auto-fixable; round 2 clean (so it does not need approval after the fix).
    const step = new MockStep("review", [{ autoFixable: true, findings }, {}]);
    const ex = new Executor(db, paths, cfg, mockAgent, [step]);
    await ex.execute(new AbortController().signal, run, repo, repo.workingPath);
    expect(step.calls).toBe(2); // initial + one auto-fix round
    expect(getRun(db, run.id)?.status).toBe("completed");
    db.close();
});

test("skipRemaining marks subsequent steps skipped", async () => {
    const { db, repo, run } = setup();
    const rebase = new MockStep("rebase", [{ skipRemaining: true }]);
    const review = new MockStep("review", [{}]);
    const ex = new Executor(db, paths, null, mockAgent, [rebase, review]);
    await ex.execute(new AbortController().signal, run, repo, repo.workingPath);
    const steps = getStepsByRun(db, run.id);
    expect(steps.find(s => s.stepName === "review")?.status).toBe("skipped");
    expect(review.calls).toBe(0); // never ran
    db.close();
});

test("abort during approval cancels the run with the abort cause", async () => {
    const { db, repo, run } = setup();
    const ac = new AbortController();
    const findings = "{\"findings\":[{\"id\":\"r1\",\"severity\":\"warning\",\"description\":\"x\",\"action\":\"ask-user\"}]}";
    const step = new MockStep("review", [{ needsApproval: true, findings }]);
    const ex = new Executor(db, paths, null, mockAgent, [step]);
    const done = ex.execute(ac.signal, run, repo, repo.workingPath).catch(e => e);

    await waitUntil(() => getRun(db, run.id)?.awaitingAgentSince != null);
    ac.abort(new Error("cancelled: aborted by user"));
    await done;

    expect(getRun(db, run.id)?.status).toBe("cancelled");
    db.close();
});
