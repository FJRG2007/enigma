/**
 * Records each run into the JSON ledger the Node side reads (`src/gate-ledger.ts`).
 *
 * The completion gate asks that file whether the pipeline ever saw the commits a turn
 * is calling done, so what matters here is that an entry exists at all and carries the
 * time - not the status. Every state change is recorded, a run still in flight
 * included: a turn that ends while the pipeline is parked awaiting the driving agent
 * did not skip the gate, and blocking it would be a false block.
 */

import { log } from "../log";
import type { Paths } from "../paths";
import type { Database } from "../db";
import { getRun, getRepo } from "../db";
import { recordGateRun } from "@/gate-ledger";

/** Writes the ledger entry for `runId`; a missing run or repo records nothing. */
export function recordRun(db: Database, paths: Paths, runId: string): void {
    try {
        const run = getRun(db, runId);
        if (run === null) return;
        const repo = getRepo(db, run.repoId);
        if (repo === null) return;
        recordGateRun({ repoPath: repo.workingPath, branch: run.branch, headSha: run.headSha, status: run.status, at: run.updatedAt }, paths.runLedgerFile());
    } catch (err) {
        log.debug("gate run ledger write failed", "run_id", runId, "error", String(err));
    }
}
