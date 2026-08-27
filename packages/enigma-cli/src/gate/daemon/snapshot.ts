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
 * run silently blanked the gate line of the first.
 */

import { log } from "../log";
import { join } from "node:path";
import type { Paths } from "../paths";
import type { Database } from "../db";
import { getRun, getRepo, getStepsByRun } from "../db";
import { renameSync, writeFileSync, readFileSync } from "node:fs";

/**
 * Schema version; `bin/statusline.mjs` ignores anything it does not recognize.
 * 2 introduced the per-repository map. The reader still accepts a version-1 file so
 * that the upgrade window - a new renderer beside a daemon that is still the old
 * long-running process - shows a bar instead of nothing.
 */
const SNAPSHOT_VERSION = 2;

/** Cap on remembered repositories, mirroring the run ledger's. */
const MAX_REPOS = 100;

/** Run statuses the status bar reports on; anything else is settled and is dropped. */
const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);

/** One pipeline step as the status bar needs it. */
interface SnapshotStep {
    name: string;
    status: string;
    startedAt?: number;
}

/** The serialized file: one snapshot per repository, keyed by its working path. */
interface SnapshotFile {
    version: number;
    repos: Record<string, Snapshot>;
}

/** One repository's active run, as the status bar needs it. */
interface Snapshot {
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

/** Reads the snapshot file, or an empty one when it is missing, corrupt or a version we do not write. */
function readSnapshotFile(path: string): SnapshotFile {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
        if (!parsed || parsed.version !== SNAPSHOT_VERSION || typeof parsed.repos !== "object" || parsed.repos === null) {
            return { version: SNAPSHOT_VERSION, repos: {} };
        }
        return parsed;
    } catch { return { version: SNAPSHOT_VERSION, repos: {} }; }
}

/**
 * Records the run under its repository, replacing that repository's previous entry and
 * leaving every other repository's alone - which is the whole point: two runs in flight
 * must not blank each other's status bar.
 *
 * A run that has SETTLED is removed rather than stored. The reader ignores a settled run
 * anyway, so keeping it would only grow the file and leave a finished run looking like the
 * repository's current state to anything less strict.
 *
 * The write is atomic (temp file plus rename) because the status bar polls on a timer and
 * must never read a half-written file. Failures are logged at debug and swallowed: a
 * cosmetic status bar must never be able to disturb a run.
 */
export function writeSnapshot(db: Database, paths: Paths, runId: string): void {
    try {
        const snapshot = buildSnapshot(db, runId);
        if (snapshot === null) return;
        const target = paths.statuslineFile();
        const file = readSnapshotFile(target);
        if (ACTIVE_RUN_STATUSES.has(snapshot.status)) file.repos[snapshot.repoPath] = snapshot;
        else delete file.repos[snapshot.repoPath];
        const entries = Object.entries(file.repos);
        if (entries.length > MAX_REPOS) {
            entries.sort((a, b) => b[1].startedAt - a[1].startedAt);
            file.repos = Object.fromEntries(entries.slice(0, MAX_REPOS));
        }
        const tmp = join(paths.root(), `statusline.${process.pid}.tmp`);
        writeFileSync(tmp, `${JSON.stringify(file)}
`);
        renameSync(tmp, target);
    } catch (err) {
        log.debug("statusline snapshot write failed", "run_id", runId, "error", String(err));
    }
}
