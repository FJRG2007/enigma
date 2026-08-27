/**
 * Gate run ledger: the last pipeline run per repository, in plain JSON.
 *
 * The completion gate (`verify.ts`) has to answer one question at turn end - did the
 * quality gate ever look at the commits this turn is about to call done? The answer
 * lives in the gate database, which only the Bun runtime can open (`bun:sqlite`),
 * while the turn-end hook runs on the Node launcher. Same split that forced the
 * status-line snapshot, so the same shape of bridge: the daemon records here, Node
 * reads here.
 *
 * Unlike the snapshot this is NOT a view of the active run - it must outlive the run,
 * because a gate that finished an hour ago is exactly what makes the next claim
 * legitimate. It is still a derived cache: deleting it costs a run's worth of memory,
 * not correctness, and the next event rewrites it.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRepoKeyedFile, writeRepoKeyedFile } from "./repo-keyed-file";

/** Schema version; a reader ignores anything it does not recognize. */
const LEDGER_VERSION = 1;

/** Statuses that mean the run stopped without clearing anything (`gate/types.ts`). */
const ABANDONED = new Set(["failed", "cancelled"]);

/** One repository's most recent run. */
export interface GateRunRecord {
    /** Repository working root, as the gate recorded it. */
    repoPath: string;
    /**
     * The run this record is about, so a later state of the SAME run replaces it instead of
     * displacing the run before it. Absent in records written before this field existed, which
     * only costs the carry below one generation.
     */
    runId?: string;
    branch: string;
    headSha: string;
    status: string;
    /** Unix seconds at which the run last changed state. */
    at: number;
    /**
     * The run that vouched for this repository before this one, kept so a run that ends failed
     * or cancelled does not erase the run that really did validate the work.
     */
    prior?: GateRunRecord;
}

/**
 * The run that vouches for a repository's work, or null when none does.
 *
 * A run that ended `failed` or `cancelled` looked at the commits and did NOT clear them, so it
 * cannot stand the completion gate down - otherwise starting a run and aborting it would clear
 * the very check the gate exists for. Every other status still counts, in-flight ones included:
 * a turn that ends while the pipeline is parked awaiting the driving agent did not skip it.
 */
export function validatingRun(record: GateRunRecord | null | undefined): GateRunRecord | null {
    if (!record || typeof record.at !== "number") return null;
    if (!ABANDONED.has(String(record.status).toLowerCase())) return record;
    return validatingRun(record.prior);
}

/** Gate home, resolved the same way `Paths` and `bin/statusline.mjs` resolve it. */
function gateHome(): string {
    return process.env.ENIGMA_GATE_HOME || join(homedir(), ".enigma", "gate");
}

/**
 * The ledger file, under `root` when the caller already resolved gate home.
 *
 * The gate side never calls this directly - it goes through `Paths.runLedgerFile()`, which
 * names the file once for everything that writes under a resolved gate home. Hence the
 * `path` argument the functions below take: a caller that already has the file passes it,
 * and only the readers that have nothing but an environment fall back to here.
 */
export function gateLedgerPath(root?: string): string {
    return join(root || gateHome(), "last-runs.json");
}

/**
 * Whether anything is recording runs yet.
 *
 * "No entry for this repository" and "nothing writes this file" read identically from a
 * missing file, and they mean opposite things: the first is work the gate never validated,
 * the second is a gate whose daemon predates this ledger (the upgrade window, where the
 * turn-end hook is already new and the running daemon is not). Treating the second as
 * unvalidated work would block every turn right after a successful run, so the check that
 * denies a stop asks this first and stands down until the first run is recorded.
 */
export function gateLedgerReady(path = gateLedgerPath()): boolean {
    return existsSync(path);
}

/**
 * Reads the ledger's entries, or none when it is missing, unreadable or unknown. Keyed by
 * repository path exactly as recorded, so a rename becomes a new entry.
 */
function readLedger(path: string): Record<string, GateRunRecord> {
    return readRepoKeyedFile<GateRunRecord>(path, LEDGER_VERSION);
}

/**
 * Records a run against its repository, replacing that repository's previous entry.
 *
 * The entry it replaces is not simply lost: a NEW run carries the run that last vouched for
 * this repository forward as `prior`, so when this one ends failed or cancelled the earlier
 * one still answers for the commits it validated. A later state of the same run inherits that
 * carry unchanged, which is what stops a run's own `pending`/`running` stamps from vouching
 * for it after it is aborted.
 *
 * Written atomically and capped by `repo-keyed-file.ts` because the reader is a turn-end
 * hook that must never parse half a file, and failures are swallowed: bookkeeping must never
 * be able to disturb a run. `path` is the ledger the caller is already using, so a test or an
 * isolated daemon writes where it reads.
 */
export function recordGateRun(record: GateRunRecord, path = gateLedgerPath()): void {
    try {
        const repos = readLedger(path);
        const previous = repos[record.repoPath];
        const prior = previous && previous.runId === record.runId ? previous.prior : validatingRun(previous);
        // Flattened to one generation: `prior` is already a validating run, so its own carry
        // answers for nothing this reader would ever reach.
        repos[record.repoPath] = { ...record, prior: prior ? { ...prior, prior: undefined } : undefined };
        writeRepoKeyedFile(path, LEDGER_VERSION, repos, r => r.at);
    } catch { /* a cosmetic-cost cache; losing a write only costs one extra gate run */ }
}

/** Whether `dir` is `root` itself or a directory beneath it (case-insensitive, as Windows is). */
function isInside(dir: string, root: string): boolean {
    const a = resolve(dir).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const b = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return a === b || a.startsWith(`${b}/`);
}

/**
 * The most recent run recorded for the repository containing `cwd`, or null when the
 * gate has never run there on this machine.
 *
 * Matches the deepest recorded root that contains `cwd`, so a repository checked out
 * inside another one (a worktree, a vendored clone) reads its own entry rather than
 * its parent's.
 */
export function lastGateRun(cwd: string, path = gateLedgerPath()): GateRunRecord | null {
    let best: GateRunRecord | null = null;
    for (const record of Object.values(readLedger(path))) {
        if (!record || typeof record.repoPath !== "string" || typeof record.at !== "number") continue;
        if (!isInside(cwd, record.repoPath)) continue;
        if (best === null || record.repoPath.length > best.repoPath.length) best = record;
    }
    return best;
}
