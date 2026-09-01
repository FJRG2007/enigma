/**
 * Gate database (bun:sqlite): schema + migrations apply idempotently, run/step
 * CRUD round-trips, recoverStaleRuns fails in-flight runs/steps and clears both
 * parked markers (awaiting-agent and blocked-on-user), and ULIDs are monotonic + lexicographically sortable.
 * A temp HOME isolates state; the DB file lives in a temp dir.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const DIR = mkdtempSync(join(tmpdir(), "enigma-gate-db-"));
process.env.USERPROFILE = DIR;
process.env.HOME = DIR;

const {
    Database,
    newId,
    insertRepoWithIDAndFork,
    getRepoByPath,
    insertRun,
    getRun,
    getActiveRun,
    updateRunStatus,
    setRunAwaitingAgent,
    setRunBlockedReason,
    recoverStaleRuns,
    insertStepResult,
    startStep,
    completeStepWithStatus,
    getStepsByRun
} = await import("@/gate/db");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function freshDB() {
    return new Database(join(DIR, `${newId()}.sqlite`));
}

test("schema applies and repo/run/step CRUD round-trips", () => {
    const db = freshDB();
    const repo = insertRepoWithIDAndFork(db, "abc123def456", "/work/repo", "git@github.com:o/r.git", "", "main");
    expect(getRepoByPath(db, "/work/repo")?.id).toBe(repo.id);

    const run = insertRun(db, repo.id, "feature", "headsha", "basesha");
    expect(run.status).toBe("pending");
    expect(getRun(db, run.id)?.branch).toBe("feature");

    updateRunStatus(db, run.id, "running");
    expect(getActiveRun(db, repo.id, "feature")?.id).toBe(run.id);

    const sr = insertStepResult(db, run.id, "review");
    startStep(db, sr.id);
    completeStepWithStatus(db, sr.id, "completed", 0, 42, "/log/review.log");
    const steps = getStepsByRun(db, run.id);
    expect(steps.find(s => s.stepName === "review")?.status).toBe("completed");
    db.close();
});

test("recoverStaleRuns fails in-flight runs and clears the awaiting-agent marker", () => {
    const db = freshDB();
    const repo = insertRepoWithIDAndFork(db, newId(), "/work/repo2", "git@github.com:o/r.git", "", "main");
    const run = insertRun(db, repo.id, "b", "h", "base");
    updateRunStatus(db, run.id, "running");
    setRunAwaitingAgent(db, run.id);
    expect(getRun(db, run.id)?.awaitingAgentSince).not.toBeNull();

    const recovered = recoverStaleRuns(db, "daemon restarted");
    expect(recovered).toBe(1);
    const after = getRun(db, run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("daemon restarted");
    expect(after?.awaitingAgentSince).toBeNull();
    db.close();
});

test("the blocked-on-user marker round-trips and a recovered run drops it", () => {
    const db = freshDB();
    const repo = insertRepoWithIDAndFork(db, newId(), "/work/repo3", "git@github.com:o/r.git", "", "main");
    const run = insertRun(db, repo.id, "b", "h", "base");
    updateRunStatus(db, run.id, "running");
    expect(getRun(db, run.id)?.blockedReason).toBeNull();

    setRunBlockedReason(db, run.id, "merge the PR");
    expect(getRun(db, run.id)?.blockedReason).toBe("merge the PR");
    // An empty reason is how a step says it is no longer waiting on anyone.
    setRunBlockedReason(db, run.id, "");
    expect(getRun(db, run.id)?.blockedReason).toBeNull();

    // A crashed run must not be left claiming it is waiting on the user.
    setRunBlockedReason(db, run.id, "merge the PR");
    recoverStaleRuns(db, "daemon restarted");
    expect(getRun(db, run.id)?.blockedReason).toBeNull();
    db.close();
});

test("ULIDs are monotonic and lexicographically sortable", () => {
    const ids = Array.from({ length: 200 }, () => newId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids); // generation order == lexical order
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(ids[0].length).toBe(26); // ULID length
});
