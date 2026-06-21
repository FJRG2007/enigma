/**
 * CCR - Compress-Cache-Retrieve. Compression here is reversible: whenever rows or
 * spans are dropped, the full original is cached under a content hash and the
 * compressed output carries a marker referencing it, so the model (or the user)
 * can retrieve the original on demand instead of losing data.
 *
 * Storage is a dependency-free file-per-hash cache under ~/.enigma/ccr (no SQLite,
 * matching enigma's zero-runtime-deps posture). Paths resolve lazily per call so a
 * test can point HOME/USERPROFILE elsewhere.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** Marker appended to lossy output; HASH retrieves the original via `enigma_retrieve`. */
const MARKER_RE = /<<enigma:ccr:([0-9a-f]{6,}) (\d+)_rows_offloaded>>/;

// enigma: simple newest-N retention cap (no LRU index/TTL); upgrade to SQLite +
// access-time eviction only if the cache ever needs to scale past a dev machine.
const MAX_ENTRIES = 500;

export interface CcrStats {
    calls: number;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
}

const EMPTY_STATS: CcrStats = { calls: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 };

function ccrDir(): string {
    return join(homedir(), ".enigma", "ccr");
}

function entryPath(hash: string): string {
    return join(ccrDir(), `${hash}.txt`);
}

function statsPath(): string {
    return join(ccrDir(), "stats.json");
}

/** 12-hex-char content hash, the retrieval key for an original. */
export function ccrHash(original: string): string {
    return createHash("sha256").update(original).digest("hex").slice(0, 12);
}

/** Build the marker string for `hash` covering `rows` offloaded rows/spans. */
export function ccrMarker(hash: string, rows: number): string {
    return `<<enigma:ccr:${hash} ${rows}_rows_offloaded>>`;
}

/** Extract the CCR hash from compressed content, or null if it carries no marker. */
export function markerHash(content: string): string | null {
    return content.match(MARKER_RE)?.[1] ?? null;
}

/** Cache `original` and return its retrieval hash, pruning the cache to MAX_ENTRIES. */
export function store(original: string): string {
    const hash = ccrHash(original);
    const dir = ccrDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = entryPath(hash);
    if (!existsSync(path)) writeFileSync(path, original);
    prune(dir);
    return hash;
}

/** Return the original cached under `hash`, or null if it is unknown/evicted. */
export function retrieve(hash: string): string | null {
    try { return readFileSync(entryPath(hash), "utf8"); } catch { return null; }
}

/** Drop oldest entries (by mtime) so at most MAX_ENTRIES originals are kept. */
function prune(dir: string): void {
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".txt")); } catch { return; }
    if (files.length <= MAX_ENTRIES) return;
    const byAge = files
        .map((f) => { const p = join(dir, f); return { p, m: statSync(p).mtimeMs }; })
        .sort((a, b) => a.m - b.m);
    for (const { p } of byAge.slice(0, files.length - MAX_ENTRIES)) {
        try { unlinkSync(p); } catch { /* already gone */ }
    }
}

/** Cumulative savings recorded so far across all compress calls. */
export function readStats(): CcrStats {
    const path = statsPath();
    try { return { ...EMPTY_STATS, ...JSON.parse(readFileSync(path, "utf8")) }; } catch { return { ...EMPTY_STATS }; }
}

/** Fold one compress call's token counts into the cumulative stats file. */
export function recordStats(tokensBefore: number, tokensAfter: number): void {
    const cur = readStats();
    const next: CcrStats = {
        calls: cur.calls + 1,
        tokensBefore: cur.tokensBefore + tokensBefore,
        tokensAfter: cur.tokensAfter + tokensAfter,
        tokensSaved: cur.tokensSaved + Math.max(0, tokensBefore - tokensAfter),
    };
    const dir = ccrDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try { writeFileSync(statsPath(), JSON.stringify(next, null, 2) + "\n"); } catch { /* stats are best-effort */ }
}
