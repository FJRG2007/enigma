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
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Schema version; a reader ignores anything it does not recognize. */
const LEDGER_VERSION = 1;

/** How many repositories to keep. Oldest entries drop, so the file stays small. */
const MAX_REPOS = 100;

/** One repository's most recent run. */
export interface GateRunRecord {
    /** Repository working root, as the gate recorded it. */
    repoPath: string;
    branch: string;
    headSha: string;
    status: string;
    /** Unix seconds at which the run last changed state. */
    at: number;
}

/** The serialized file. */
interface Ledger {
    version: number;
    /** Keyed by repository path exactly as recorded, so a rename becomes a new entry. */
    repos: Record<string, GateRunRecord>;
}

/** Gate home, resolved the same way `Paths` and `bin/statusline.mjs` resolve it. */
function gateHome(): string {
    return process.env.ENIGMA_GATE_HOME || join(homedir(), ".enigma", "gate");
}

/** The ledger file, under `root` when the caller already resolved gate home. */
export function gateLedgerPath(root?: string): string {
    return join(root || gateHome(), "last-runs.json");
}

/** Reads the ledger, or an empty one when it is missing, unreadable or unknown. */
function readLedger(path: string): Ledger {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Ledger;
        if (!parsed || parsed.version !== LEDGER_VERSION || typeof parsed.repos !== "object" || parsed.repos === null) return { version: LEDGER_VERSION, repos: {} };
        return parsed;
    } catch { return { version: LEDGER_VERSION, repos: {} }; }
}

/**
 * Records a run against its repository, replacing that repository's previous entry.
 *
 * Written atomically (temp file plus rename) because the reader is a turn-end hook that
 * must never parse half a file, and failures are swallowed: bookkeeping must never be
 * able to disturb a run. `root` is the gate home the caller is already using, so a test
 * or an isolated daemon writes where it reads.
 */
export function recordGateRun(record: GateRunRecord, root?: string): void {
    const path = gateLedgerPath(root);
    try {
        const ledger = readLedger(path);
        ledger.repos[record.repoPath] = record;
        const entries = Object.entries(ledger.repos);
        if (entries.length > MAX_REPOS) {
            entries.sort((a, b) => b[1].at - a[1].at);
            ledger.repos = Object.fromEntries(entries.slice(0, MAX_REPOS));
        }
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(ledger)}\n`);
        renameSync(tmp, path);
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
export function lastGateRun(cwd: string, root?: string): GateRunRecord | null {
    const ledger = readLedger(gateLedgerPath(root));
    let best: GateRunRecord | null = null;
    for (const record of Object.values(ledger.repos)) {
        if (!record || typeof record.repoPath !== "string" || typeof record.at !== "number") continue;
        if (!isInside(cwd, record.repoPath)) continue;
        if (best === null || record.repoPath.length > best.repoPath.length) best = record;
    }
    return best;
}
