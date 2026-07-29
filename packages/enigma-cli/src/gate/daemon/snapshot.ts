/**
 * Status-bar snapshot: a small JSON mirror of the active run, refreshed whenever
 * the daemon broadcasts a run event.
 *
 * An agent status line (Claude Code's `statusLine`) re-runs on every refresh, so
 * enigma serves it from the Node launcher without ever spawning the Bun binary.
 * That fast path cannot open the gate database, since `bun:sqlite` needs the Bun
 * runtime - hence this file, which is the bridge. It is a derived cache: losing
 * or deleting it costs nothing, and the next event rewrites it.
 *
 * The reader lives in `bin/statusline.mjs` and treats a snapshot as stale unless
 * the recorded daemon PID is still alive, so a crash cannot leave a phantom run
 * on screen.
 */

import { log } from "../log";
import { join } from "node:path";
import type { Paths } from "../paths";
import type { Database } from "../db";
import { renameSync, writeFileSync } from "node:fs";
import { getRun, getRepo, getStepsByRun } from "../db";

/** Schema version; `bin/statusline.mjs` ignores anything it does not recognize. */
const SNAPSHOT_VERSION = 1;

/** One pipeline step as the status bar needs it. */
interface SnapshotStep {
    name: string;
    status: string;
    startedAt?: number;
}

/** The serialized shape written to `paths.statuslineFile()`. */
interface Snapshot {
    version: number;
    pid: number;
    repoPath: string;
    branch: string;
    status: string;
    startedAt: number;
    awaiting: boolean;
    steps: SnapshotStep[];
    prUrl?: string;
}

/** Builds the snapshot for a run, or null when the run or its repo is gone. */
export function buildSnapshot(db: Database, runId: string): Snapshot | null {
    const run = getRun(db, runId);
    if (run === null) return null;
    const repo = getRepo(db, run.repoId);
    if (repo === null) return null;
    const snapshot: Snapshot = {
        version: SNAPSHOT_VERSION,
        pid: process.pid,
        repoPath: repo.workingPath,
        branch: run.branch,
        status: run.status,
        startedAt: run.createdAt,
        awaiting: run.awaitingAgentSince !== null,
        steps: getStepsByRun(db, runId).map(s => ({
            name: s.stepName,
            status: s.status,
            ...(s.startedAt === null ? {} : { startedAt: s.startedAt })
        }))
    };
    if (run.prUrl) snapshot.prUrl = run.prUrl;
    return snapshot;
}

/**
 * Writes the snapshot for `runId`. The write is atomic (temp file plus rename)
 * because the status bar polls once a second and must never read a half-written
 * file. Failures are logged at debug and swallowed: a cosmetic status bar must
 * never be able to disturb a run.
 */
export function writeSnapshot(db: Database, paths: Paths, runId: string): void {
    try {
        const snapshot = buildSnapshot(db, runId);
        if (snapshot === null) return;
        const target = paths.statuslineFile();
        const tmp = join(paths.root(), `statusline.${process.pid}.tmp`);
        writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
        renameSync(tmp, target);
    } catch (err) {
        log.debug("statusline snapshot write failed", "run_id", runId, "error", String(err));
    }
}
