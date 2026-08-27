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
 *
 * The file holds one entry PER REPOSITORY, keyed by its working path, for the same
 * reason `gate-ledger.ts` does: runs in different repositories overlap, and a single
 * slot made them fight over it. The loser was not a wrong bar but a MISSING one - the
 * reader drops a snapshot whose repo does not contain its cwd - so a second project's
 * run silently blanked the gate line of the first. The read/cap/write itself lives in
 * `repo-keyed-file.ts`, shared with the run ledger and the code-graph counters.
 */

import { log } from "../log";
import type { Paths } from "../paths";
import type { Database } from "../db";
import { getRun, getRepo, getStepsByRun } from "../db";
import { readRepoKeyedFile, writeRepoKeyedFile } from "@/repo-keyed-file";

/**
 * Schema version; `bin/statusline.mjs` ignores anything it does not recognize.
 * 2 introduced the per-repository map. The reader still accepts a version-1 file so
 * that the upgrade window - a new renderer beside a daemon that is still the old
 * long-running process - shows a bar instead of nothing.
 */
const SNAPSHOT_VERSION = 2;

/** Run statuses the status bar reports on; anything else is settled and is dropped. */
const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);

/** One pipeline step as the status bar needs it. */
interface SnapshotStep {
    name: string;
    status: string;
    startedAt?: number;
}

/** One repository's active run, as the status bar needs it. */
interface Snapshot {
    pid: number;
    /**
     * The run this entry is about. Runs are only serialized per repo+branch, so a second branch
     * of the same repository can be in flight at the same time and takes this key from the first;
     * without the id, the first one to settle would then delete the OTHER run's entry and blank a
     * bar that should still be lit. Absent in entries written before this field existed.
     */
    runId?: string;
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
        pid: process.pid,
        runId: run.id,
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
 * Records the run under its repository, replacing that repository's previous entry and
 * leaving every other repository's alone - which is the whole point: two runs in flight
 * must not blank each other's status bar.
 *
 * A run that has SETTLED is removed rather than stored, but only when the stored entry is
 * still its own: a concurrent run on another branch of the same repository may have taken
 * the key since, and deleting that would reintroduce the very blank bar this file exists to
 * prevent. An entry with no recorded run id predates the field and is cleared as before,
 * since leaving it would strand a finished run on screen for the daemon's lifetime.
 *
 * The write is atomic and capped by `repo-keyed-file.ts`. Failures are logged at debug and
 * swallowed: a cosmetic status bar must never be able to disturb a run.
 */
export function writeSnapshot(db: Database, paths: Paths, runId: string): void {
    try {
        const snapshot = buildSnapshot(db, runId);
        if (snapshot === null) return;
        const target = paths.statuslineFile();
        const repos = readRepoKeyedFile<Snapshot>(target, SNAPSHOT_VERSION);
        const stored = repos[snapshot.repoPath];
        if (ACTIVE_RUN_STATUSES.has(snapshot.status)) repos[snapshot.repoPath] = snapshot;
        else if (stored === undefined || stored.runId === undefined || stored.runId === snapshot.runId) delete repos[snapshot.repoPath];
        writeRepoKeyedFile(target, SNAPSHOT_VERSION, repos, s => s.startedAt);
    } catch (err) {
        log.debug("statusline snapshot write failed", "run_id", runId, "error", String(err));
    }
}
