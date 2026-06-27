/**
 * Step-result records: the per-step execution state of a run. Faithful port of
 * upstream's `internal/db/step.go`.
 */

import { now, newId } from "./id";
import type { Database } from "./index";
import { stepOrder, type StepName, type StepStatus } from "../types";

/** The result of a pipeline step execution. */
export interface StepResult {
    id: string;
    runId: string;
    stepName: StepName;
    stepOrder: number;
    status: StepStatus;
    exitCode: number | null;
    durationMs: number | null;
    logPath: string | null;
    findingsJson: string | null;
    error: string | null;
    startedAt: number | null;
    completedAt: number | null;
}

const SELECT_STEP = "SELECT id, run_id, step_name, step_order, status, exit_code, duration_ms, log_path, findings_json, error, started_at, completed_at FROM step_results";

function scanStep(row: any[]): StepResult {
    return {
        id: row[0] as string,
        runId: row[1] as string,
        stepName: row[2] as StepName,
        stepOrder: row[3] as number,
        status: row[4] as StepStatus,
        exitCode: (row[5] ?? null) as number | null,
        durationMs: (row[6] ?? null) as number | null,
        logPath: (row[7] ?? null) as string | null,
        findingsJson: (row[8] ?? null) as string | null,
        error: (row[9] ?? null) as string | null,
        startedAt: (row[10] ?? null) as number | null,
        completedAt: (row[11] ?? null) as number | null
    };
}

/** Creates a new step result record. */
export function insertStepResult(db: Database, runId: string, stepName: StepName): StepResult {
    const s: StepResult = {
        id: newId(),
        runId,
        stepName,
        stepOrder: stepOrder(stepName),
        status: "pending",
        exitCode: null,
        durationMs: null,
        logPath: null,
        findingsJson: null,
        error: null,
        startedAt: null,
        completedAt: null
    };
    db.sql.query(
        "INSERT INTO step_results (id, run_id, step_name, step_order, status) VALUES (?, ?, ?, ?, ?)"
    ).run(s.id, s.runId, s.stepName, s.stepOrder, s.status);
    return s;
}

/** Returns a step result by ID, or null when absent. */
export function getStepResult(db: Database, id: string): StepResult | null {
    const rows = db.sql.query(`${SELECT_STEP} WHERE id = ?`).values(id);
    if (rows.length === 0) return null;
    return scanStep(rows[0]);
}

/** Returns all step results for a run, in execution order. */
export function getStepsByRun(db: Database, runId: string): StepResult[] {
    const rows = db.sql.query(`${SELECT_STEP} WHERE run_id = ? ORDER BY step_order`).values(runId);
    return rows.map(scanStep);
}

/** Updates a step's status. */
export function updateStepStatus(db: Database, id: string, status: StepStatus): void {
    db.sql.query("UPDATE step_results SET status = ? WHERE id = ?").run(status, id);
}

/** Updates a step's status and execution duration together. */
export function updateStepStatusWithDuration(db: Database, id: string, status: StepStatus, durationMs: number): void {
    db.sql.query("UPDATE step_results SET status = ?, duration_ms = ? WHERE id = ?").run(status, durationMs, id);
}

/** Marks a step as running with a started_at timestamp. */
export function startStep(db: Database, id: string): void {
    db.sql.query("UPDATE step_results SET status = ?, started_at = ? WHERE id = ?").run("running", now(), id);
}

/** Marks a step as completed with timing and result info. */
export function completeStep(db: Database, id: string, exitCode: number, durationMs: number, logPath: string): void {
    completeStepWithStatus(db, id, "completed", exitCode, durationMs, logPath);
}

/** Marks a step as finished with the given status, timing, and result info. */
export function completeStepWithStatus(db: Database, id: string, status: StepStatus, exitCode: number, durationMs: number, logPath: string): void {
    db.sql.query(
        "UPDATE step_results SET status = ?, exit_code = ?, duration_ms = ?, log_path = ?, completed_at = ? WHERE id = ?"
    ).run(status, exitCode, durationMs, logPath, now(), id);
}

/** Marks a step as failed with an error message and duration. */
export function failStep(db: Database, id: string, errMsg: string, durationMs: number): void {
    db.sql.query(
        "UPDATE step_results SET status = ?, error = ?, duration_ms = ?, completed_at = ? WHERE id = ?"
    ).run("failed", errMsg, durationMs, now(), id);
}

/** Sets the execution-only duration on a step result. */
export function setStepDuration(db: Database, id: string, durationMs: number): void {
    db.sql.query("UPDATE step_results SET duration_ms = ? WHERE id = ?").run(durationMs, id);
}

/** Sets the findings JSON on a step result. */
export function setStepFindings(db: Database, id: string, findingsJson: string): void {
    db.sql.query("UPDATE step_results SET findings_json = ? WHERE id = ?").run(findingsJson, id);
}

/** Removes any stored findings JSON from a step result. */
export function clearStepFindings(db: Database, id: string): void {
    db.sql.query("UPDATE step_results SET findings_json = NULL WHERE id = ?").run(id);
}
