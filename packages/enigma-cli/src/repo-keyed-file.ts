/**
 * The read/cap/atomic-write shared by the three per-repository JSON files enigma keeps: the
 * gate run ledger (`gate-ledger.ts`), the gate status-bar snapshot (`gate/daemon/snapshot.ts`)
 * and the code graph's counters (`codegraph-hook.ts`).
 *
 * They exist for the same reason - a Node-side reader that cannot open what the Bun side owns -
 * and they were written three times, which is how one of them ended up capping by insertion
 * order while the other two capped by recency. One implementation, one eviction rule.
 *
 * The write is atomic (temp file plus rename) because every reader is on a timer or a hook and
 * must never parse half a file. That closes torn reads, NOT lost updates: two processes that
 * read the same file and both write back still drop one another's entry, and each of these
 * files is a derived cache that self-heals on the next write rather than a store of record.
 *
 * Errors propagate; every caller already wraps its own write in the failure handling it wants.
 */

import { dirname } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** How many repositories any of these files remembers, oldest evicted first. */
export const MAX_REPOS = 100;

/** The serialized shape: a schema version and one entry per repository, keyed by its path. */
interface RepoKeyedFile<T> {
    version: number;
    repos: Record<string, T>;
}

/**
 * The entries of a per-repository file, or none when it is missing, corrupt, or a version this
 * build does not write. An unknown version is dropped rather than guessed at: the keys may mean
 * something else, and rewriting the file from scratch costs one event's worth of staleness.
 */
export function readRepoKeyedFile<T>(path: string, version: number): Record<string, T> {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as RepoKeyedFile<T>;
        if (!parsed || parsed.version !== version || typeof parsed.repos !== "object" || parsed.repos === null) return {};
        return parsed.repos;
    } catch { return {}; }
}

/**
 * Writes the entries back, keeping the `MAX_REPOS` most recent by `recencyOf`.
 *
 * The temp file carries this process's pid, so concurrent writers never share one, and it is
 * removed when the rename fails - Windows returns EPERM while a reader holds the destination
 * open, and a hook that runs as a fresh process every time would otherwise leave one behind
 * on every failure.
 */
export function writeRepoKeyedFile<T>(path: string, version: number, repos: Record<string, T>, recencyOf: (entry: T) => number): void {
    let kept = repos;
    const entries = Object.entries(repos);
    if (entries.length > MAX_REPOS) {
        entries.sort((a, b) => recencyOf(b[1]) - recencyOf(a[1]));
        kept = Object.fromEntries(entries.slice(0, MAX_REPOS));
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, `${JSON.stringify({ version, repos: kept } satisfies RepoKeyedFile<T>)}\n`);
        renameSync(tmp, path);
    } catch (err) {
        try { rmSync(tmp, { force: true }); } catch { /* the rename is what mattered; a stray temp file is not worth a second failure */ }
        throw err;
    }
}
