/**
 * Pipeline run records: lifecycle, intent, awaiting-agent marker, and stale-run
 * recovery. Faithful port of upstream's `internal/db/run.go`.
 */

import { now, newId } from "./id";
import type { Database } from "./index";
import type { RunStatus } from "../types";

/** A pipeline run. */
export interface Run {
    id: string;
    repoId: string;
    branch: string;
    headSha: string;
    baseSha: string;
    status: RunStatus;
    prUrl: string | null;
    error: string | null;
    /**
     * Unix-seconds timestamp at which the run parked at a gate awaiting the
     * driving agent's response (an awaiting_approval or fix_review step). Null
     * whenever the run is not parked: the executor sets it on gate entry and
     * clears it the moment the agent responds (or the wait is cancelled). It is
     * observability only and does not affect gate resolution.
     */
    awaitingAgentSince: number | null;
    intent: string | null;
    intentSource: string | null;
    intentSessionId: string | null;
    intentScore: number | null;
    createdAt: number;
    updatedAt: number;
}

/** The four intent-related columns persisted on a run. */
export interface RunIntent {
    summary: string;
    source: string;
    sessionId: string;
    score: number;
}

const RUN_COLUMNS = "id, repo_id, branch, head_sha, base_sha, status, pr_url, error, awaiting_agent_since, intent, intent_source, intent_session_id, intent_score, created_at, updated_at";

function scanRun(row: any[]): Run {
    return {
        id: row[0] as string,
        repoId: row[1] as string,
        branch: row[2] as string,
        headSha: row[3] as string,
        baseSha: row[4] as string,
        status: row[5] as RunStatus,
        prUrl: (row[6] ?? null) as string | null,
        error: (row[7] ?? null) as string | null,
        awaitingAgentSince: (row[8] ?? null) as number | null,
        intent: (row[9] ?? null) as string | null,
        intentSource: (row[10] ?? null) as string | null,
        intentSessionId: (row[11] ?? null) as string | null,
        intentScore: (row[12] ?? null) as number | null,
        createdAt: row[13] as number,
        updatedAt: row[14] as number
    };
}

/** Creates a new run record. */
export function insertRun(db: Database, repoId: string, branch: string, headSha: string, baseSha: string): Run {
    const ts = now();
    const r: Run = {
        id: newId(),
        repoId,
        branch,
        headSha,
        baseSha,
        status: "pending",
        prUrl: null,
        error: null,
        awaitingAgentSince: null,
        intent: null,
        intentSource: null,
        intentSessionId: null,
        intentScore: null,
        createdAt: ts,
        updatedAt: ts
    };
    db.sql.query(
        "INSERT INTO runs (id, repo_id, branch, head_sha, base_sha, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(r.id, r.repoId, r.branch, r.headSha, r.baseSha, r.status, r.createdAt, r.updatedAt);
    return r;
}

/** Returns a run by ID, or null when absent. */
export function getRun(db: Database, id: string): Run | null {
    const rows = db.sql.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).values(id);
    if (rows.length === 0) return null;
    return scanRun(rows[0]);
}

/** Returns all runs for a repo, newest first. */
export function getRunsByRepo(db: Database, repoId: string): Run[] {
    const rows = db.sql.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE repo_id = ? ORDER BY created_at DESC, id DESC`).values(repoId);
    return rows.map(scanRun);
}

/**
 * Returns the currently active run (pending or running) for a repo, if any. When
 * `branch` is non-empty, only a run on that exact branch is returned; when empty,
 * returns the most recently created active run across any branch.
 */
export function getActiveRun(db: Database, repoId: string, branch: string): Run | null {
    let rows: any[][];
    if (branch === "") {
        rows = db.sql.query(
            `SELECT ${RUN_COLUMNS} FROM runs WHERE repo_id = ? AND status IN ('pending', 'running') ORDER BY created_at DESC, id DESC LIMIT 1`
        ).values(repoId);
    } else {
        rows = db.sql.query(
            `SELECT ${RUN_COLUMNS} FROM runs WHERE repo_id = ? AND branch = ? AND status IN ('pending', 'running') ORDER BY created_at DESC, id DESC LIMIT 1`
        ).values(repoId, branch);
    }
    if (rows.length === 0) return null;
    return scanRun(rows[0]);
}

/** Returns all pending or running runs across all repos, newest first. */
export function getActiveRuns(db: Database): Run[] {
    const rows = db.sql.query(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE status IN (?, ?) ORDER BY created_at DESC, id DESC`
    ).values("pending", "running");
    return rows.map(scanRun);
}

/** Updates a run's status and updated_at timestamp. */
export function updateRunStatus(db: Database, id: string, status: RunStatus): void {
    db.sql.query("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
}

/** Sets the PR URL on a run. */
export function updateRunPRURL(db: Database, id: string, prUrl: string): void {
    db.sql.query("UPDATE runs SET pr_url = ?, updated_at = ? WHERE id = ?").run(prUrl, now(), id);
}

/** Updates the run head SHA and timestamp. */
export function updateRunHeadSHA(db: Database, id: string, headSha: string): void {
    db.sql.query("UPDATE runs SET head_sha = ?, updated_at = ? WHERE id = ?").run(headSha, now(), id);
}

/** Sets the error message on a run and marks it failed. */
export function updateRunError(db: Database, id: string, errMsg: string): void {
    updateRunErrorStatus(db, id, errMsg, "failed");
}

/** Sets the error message and terminal status on a run. */
export function updateRunErrorStatus(db: Database, id: string, errMsg: string, status: RunStatus): void {
    db.sql.query("UPDATE runs SET error = ?, status = ?, updated_at = ? WHERE id = ?").run(errMsg, status, now(), id);
}

/** Persists the inferred user intent for a run. */
export function updateRunIntent(db: Database, id: string, intent: RunIntent): void {
    db.sql.query(
        "UPDATE runs SET intent = ?, intent_source = ?, intent_session_id = ?, intent_score = ?, updated_at = ? WHERE id = ?"
    ).run(intent.summary, intent.source, intent.sessionId, intent.score, now(), id);
}

/**
 * Marks a run as parked awaiting the driving agent, stamping awaiting_agent_since
 * with the current time. This is a pollable observability signal only; it does
 * not change gate resolution.
 */
export function setRunAwaitingAgent(db: Database, id: string): void {
    const ts = now();
    db.sql.query("UPDATE runs SET awaiting_agent_since = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
}

/**
 * Clears the awaiting-agent marker on a run, so awaiting_agent_since is non-null
 * exactly while a gate is actually parked.
 */
export function clearRunAwaitingAgent(db: Database, id: string): void {
    db.sql.query("UPDATE runs SET awaiting_agent_since = NULL, updated_at = ? WHERE id = ?").run(now(), id);
}

/**
 * Marks any runs stuck in pending/running status as failed and fails any
 * in-progress steps. Called at daemon startup to clean up after a previous crash.
 * Returns the number of recovered runs.
 */
export function recoverStaleRuns(db: Database, errMsg: string): number {
    const ts = now();
    const txn = db.sql.transaction(() => {
        // Fail stale steps first (running, awaiting_approval, fixing, fix_review).
        db.sql.query(
            "UPDATE step_results SET status = ?, error = ?, completed_at = ? WHERE status IN (?, ?, ?, ?)"
        ).run("failed", errMsg, ts, "running", "awaiting_approval", "fixing", "fix_review");
        // Fail stale runs. Clear any awaiting-agent marker so a recovered (now
        // failed) run is never reported as still parked awaiting the agent.
        const result = db.sql.query(
            "UPDATE runs SET status = ?, error = ?, awaiting_agent_since = NULL, updated_at = ? WHERE status IN (?, ?)"
        ).run("failed", errMsg, ts, "pending", "running");
        return result.changes;
    });
    return Number(txn());
}
