/**
 * Step-round records: each execution round within a pipeline step, including the
 * findings produced and the user/auto selection that drove the next round.
 * Faithful port of no-mistakes' `internal/db/round.go`.
 */

import { now, newId } from "./id";
import type { Database } from "./index";

export const RoundSelectionSourceUser = "user";
export const RoundSelectionSourceAutoFix = "auto_fix";

/** One execution round within a pipeline step. */
export interface StepRound {
    id: string;
    stepResultId: string;
    round: number;
    /** "initial", "auto_fix"; legacy "user_fix" is treated as "auto_fix". */
    trigger: string;
    /** Nullable - findings produced by this round. */
    findingsJson: string | null;
    /**
     * When non-null, the merged finding list that was dispatched to the fix agent
     * after the user edited per-finding instructions or added their own findings.
     * It includes both the selected agent-produced findings (with any attached
     * user instructions) and the user-authored findings.
     */
    userFindingsJson: string | null;
    /**
     * When non-null, a JSON array of finding IDs that were chosen (by the user or
     * auto-fix filter) to be fixed AFTER this round. Populated on the round whose
     * findings triggered the next round, so later rounds' prompts can tell which
     * findings were deliberately left unselected.
     */
    selectedFindingIds: string | null;
    selectionSource: string | null;
    /**
     * When non-null, the agent's one-line commit summary for the fix attempt
     * performed during this round. Only set when the round itself was a fix round
     * (trigger == "auto_fix").
     */
    fixSummary: string | null;
    durationMs: number;
    createdAt: number;
}

const SELECT_ROUND = "SELECT id, step_result_id, round, trigger_type, findings_json, user_findings_json, selected_finding_ids, selection_source, fix_summary, duration_ms, created_at FROM step_rounds";

function scanRound(row: any[]): StepRound {
    return {
        id: row[0] as string,
        stepResultId: row[1] as string,
        round: row[2] as number,
        trigger: row[3] as string,
        findingsJson: (row[4] ?? null) as string | null,
        userFindingsJson: (row[5] ?? null) as string | null,
        selectedFindingIds: (row[6] ?? null) as string | null,
        selectionSource: (row[7] ?? null) as string | null,
        fixSummary: (row[8] ?? null) as string | null,
        durationMs: row[9] as number,
        createdAt: row[10] as number
    };
}

/**
 * Reports whether this round was a fix attempt. Legacy "user_fix" rounds count:
 * they were fix rounds dispatched by an explicit user selection.
 */
export function isFixRound(r: StepRound): boolean {
    return r.trigger === "auto_fix" || r.trigger === "user_fix";
}

/**
 * Returns one entry per fix round for a step, in round order: the agent's
 * one-line fix summary, or "" when the round recorded none.
 */
export function stepFixSummaries(db: Database, stepResultId: string): string[] {
    const rounds = getRoundsByStep(db, stepResultId);
    const summaries: string[] = [];
    for (const r of rounds) {
        if (!isFixRound(r)) continue;
        summaries.push(r.fixSummary !== null ? r.fixSummary : "");
    }
    return summaries;
}

/**
 * Creates a new round record for a step result. `fixSummary` may be null for
 * non-fix rounds or when the agent produced no summary.
 */
export function insertStepRound(db: Database, stepResultId: string, round: number, trigger: string, findingsJson: string | null, fixSummary: string | null, durationMs: number): StepRound {
    const r: StepRound = {
        id: newId(),
        stepResultId,
        round,
        trigger,
        findingsJson,
        userFindingsJson: null,
        selectedFindingIds: null,
        selectionSource: null,
        fixSummary,
        durationMs,
        createdAt: now()
    };
    db.sql.query(
        "INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json, user_findings_json, selected_finding_ids, selection_source, fix_summary, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(r.id, r.stepResultId, r.round, r.trigger, r.findingsJson, r.userFindingsJson, r.selectedFindingIds, r.selectionSource, r.fixSummary, r.durationMs, r.createdAt);
    return r;
}

/**
 * Records which findings were selected for fix AFTER the given round produced its
 * findings, along with whether that selection came from the user or auto-fix
 * filtering. Passing a null or empty JSON array clears both columns.
 */
export function setStepRoundSelection(db: Database, id: string, selectedFindingIds: string | null, source: string): void {
    let selectionSource: string | null = null;
    if (selectedFindingIds !== null && selectedFindingIds !== "" && source !== "") {
        selectionSource = source;
    }
    db.sql.query(
        "UPDATE step_rounds SET selected_finding_ids = ?, selection_source = ? WHERE id = ?"
    ).run(selectedFindingIds, selectionSource, id);
}

/**
 * Preserves the old API for callers that do not need to distinguish how the
 * selection was made.
 */
export function setStepRoundSelectedFindingIDs(db: Database, id: string, selectedFindingIds: string | null): void {
    setStepRoundSelection(db, id, selectedFindingIds, RoundSelectionSourceUser);
}

/**
 * Records the merged finding list (with user instructions attached and user-added
 * findings appended) that was dispatched to the fix agent for the round. Passing
 * null clears the column.
 */
export function setStepRoundUserFindings(db: Database, id: string, userFindingsJson: string | null): void {
    db.sql.query("UPDATE step_rounds SET user_findings_json = ? WHERE id = ?").run(userFindingsJson, id);
}

/** Returns all rounds for a step result, ordered by round number. */
export function getRoundsByStep(db: Database, stepResultId: string): StepRound[] {
    const rows = db.sql.query(`${SELECT_ROUND} WHERE step_result_id = ? ORDER BY round`).values(stepResultId);
    return rows.map(scanRound);
}
