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

import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** Marker appended to lossy output; HASH retrieves the original via `enigma_retrieve`. */
const MARKER_RE = /<<enigma:ccr:([0-9a-f]{6,}) (\d+)_rows_offloaded>>/;

// enigma: simple newest-N retention cap (no LRU index/TTL); upgrade to SQLite +
// access-time eviction only if the cache ever needs to scale past a dev machine.
const MAX_ENTRIES = 500;

/** Cumulative token counts for one origin (an MCP client or the CLI). */
export interface SourceStats {
    calls: number;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
}

export interface CcrStats extends SourceStats {
    /**
     * Per-origin breakdown keyed by source (e.g. "claude-code", "opencode", "codex",
     * "cli"). Absent on stats files written before attribution existed.
     */
    bySource?: Record<string, SourceStats>;
    /** Per-content-type breakdown (json/log/text/code/diff/markdown). */
    byType?: Record<string, SourceStats>;
    /** Most tokens saved in a single compression. */
    best?: number;
}

/** The source label used when a caller records without naming its origin. */
const UNKNOWN_SOURCE = "unknown";

/** One compress call's savings stamped in time, for the dashboard's over-time graph. */
export interface HistoryPoint {
    /** epoch ms */
    t: number;
    /** tokens before */
    b: number;
    /** tokens after */
    a: number;
    /** source (MCP client / "cli"); absent on points written before attribution. */
    s?: string;
    /** content type (json/log/text/...); absent on points written before this existed. */
    c?: string;
}

const EMPTY_STATS: CcrStats = { calls: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 };

// enigma: append-only JSONL with a byte-size trim (no rollup/DB). The dashboard
// buckets these points by day client-side; upgrade to hourly/daily rollups only
// if the file ever needs to outlive a dev machine's compress volume.
const HISTORY_MAX_BYTES = 512 * 1024;
const HISTORY_KEEP_LINES = 4000;

function ccrDir(): string {
    return join(homedir(), ".enigma", "ccr");
}

function historyPath(): string {
    return join(ccrDir(), "history.jsonl");
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

/** Add one call's counts to a running per-source tally. */
function foldSource(prev: SourceStats | undefined, tokensBefore: number, tokensAfter: number): SourceStats {
    const base = prev ?? { calls: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 };
    return {
        calls: base.calls + 1,
        tokensBefore: base.tokensBefore + tokensBefore,
        tokensAfter: base.tokensAfter + tokensAfter,
        tokensSaved: base.tokensSaved + Math.max(0, tokensBefore - tokensAfter),
    };
}

/**
 * Fold one compress call's token counts into the cumulative stats file, attributing
 * it to `source` (the MCP client name, e.g. "claude-code"/"opencode"/"codex"/"kimi-code", or "cli"
 * for the direct CLI). The grand totals and the per-source breakdown advance together.
 */
export function recordStats(tokensBefore: number, tokensAfter: number, source: string = UNKNOWN_SOURCE, type: string = UNKNOWN_SOURCE): void {
    const cur = readStats();
    const sKey = source || UNKNOWN_SOURCE;
    const tKey = type || UNKNOWN_SOURCE;
    const bySource = { ...(cur.bySource ?? {}) };
    bySource[sKey] = foldSource(bySource[sKey], tokensBefore, tokensAfter);
    const byType = { ...(cur.byType ?? {}) };
    byType[tKey] = foldSource(byType[tKey], tokensBefore, tokensAfter);
    const next: CcrStats = {
        ...foldSource(cur, tokensBefore, tokensAfter),
        bySource,
        byType,
        best: Math.max(cur.best ?? 0, Math.max(0, tokensBefore - tokensAfter)),
    };
    const dir = ccrDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try { writeFileSync(statsPath(), JSON.stringify(next, null, 2) + "\n"); } catch { /* stats are best-effort */ }
    recordHistory(tokensBefore, tokensAfter, sKey, tKey);
}

/** Append one timestamped savings point, trimming the log when it grows too large. */
export function recordHistory(tokensBefore: number, tokensAfter: number, source?: string, type?: string): void {
    const dir = ccrDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = historyPath();
    const point: HistoryPoint = { t: Date.now(), b: tokensBefore, a: tokensAfter };
    if (source) point.s = source;
    if (type) point.c = type;
    try {
        appendFileSync(path, JSON.stringify(point) + "\n");
        if (statSync(path).size > HISTORY_MAX_BYTES) trimHistory(path);
    } catch { /* history is best-effort */ }
}

/** Keep only the newest HISTORY_KEEP_LINES lines so the log stays bounded. */
function trimHistory(path: string): void {
    try {
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        if (lines.length <= HISTORY_KEEP_LINES) return;
        writeFileSync(path, lines.slice(lines.length - HISTORY_KEEP_LINES).join("\n") + "\n");
    } catch { /* trim is best-effort */ }
}

/** Reversible-cache stats: how many originals are cached, their disk size, and the cap. */
export function ccrCacheStats(): { count: number; bytes: number; cap: number; } {
    const dir = ccrDir();
    let count = 0, bytes = 0;
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".txt")) continue;
            try { bytes += statSync(join(dir, f)).size; count++; } catch { /* skip a busy file */ }
        }
    } catch { /* no cache dir yet */ }
    return { count, bytes, cap: MAX_ENTRIES };
}

/**
 * Delete all recorded CCR data - cumulative stats, the over-time history, and every
 * cached original - to reset the dashboard and reclaim disk. Returns what was freed.
 */
export function clearCcr(): { files: number; bytes: number; } {
    const dir = ccrDir();
    let files = 0, bytes = 0;
    let names: string[];
    try { names = readdirSync(dir); } catch { return { files, bytes }; }
    for (const name of names) {
        const p = join(dir, name);
        try { bytes += statSync(p).size; unlinkSync(p); files++; } catch { /* skip a busy/locked file */ }
    }
    return { files, bytes };
}

/** Read all retained savings points (newest last), skipping any corrupt line. */
export function readHistory(): HistoryPoint[] {
    let raw: string;
    try { raw = readFileSync(historyPath(), "utf8"); } catch { return []; }
    const out: HistoryPoint[] = [];
    for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
            const p = JSON.parse(line) as HistoryPoint;
            if (typeof p.t === "number" && typeof p.b === "number" && typeof p.a === "number") {
                const pt: HistoryPoint = { t: p.t, b: p.b, a: p.a };
                if (typeof p.s === "string") pt.s = p.s;
                if (typeof p.c === "string") pt.c = p.c;
                out.push(pt);
            }
        } catch { /* skip a corrupt line */ }
    }
    return out;
}
