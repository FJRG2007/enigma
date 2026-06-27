/**
 * Intent-cache records: cached session summarizations keyed by a content hash.
 * Faithful port of upstream's `internal/db/intent_cache.go`.
 */

import { now } from "./id";
import type { Database } from "./index";

/** A cached summarization for a known agent session. */
export interface IntentCacheEntry {
    cacheKey: string;
    summary: string;
    agentName: string;
    sessionId: string;
    createdAt: number;
}

/** Returns the cached summary for a key, or null if absent. */
export function getIntentCache(db: Database, key: string): IntentCacheEntry | null {
    const rows = db.sql.query(
        "SELECT cache_key, summary, agent_name, session_id, created_at FROM intent_cache WHERE cache_key = ?"
    ).values(key);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
        cacheKey: row[0] as string,
        summary: row[1] as string,
        agentName: row[2] as string,
        sessionId: row[3] as string,
        createdAt: row[4] as number
    };
}

/** Inserts or replaces an intent cache entry. */
export function putIntentCache(db: Database, e: IntentCacheEntry): void {
    const createdAt = e.createdAt === 0 ? now() : e.createdAt;
    db.sql.query(
        "INSERT OR REPLACE INTO intent_cache (cache_key, summary, agent_name, session_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(e.cacheKey, e.summary, e.agentName, e.sessionId, createdAt);
}

/**
 * Deletes entries older than `maxAgeMs` (milliseconds, matching the Go
 * `time.Duration` argument). Returns the number of rows deleted.
 */
export function cleanupOldIntentCache(db: Database, maxAgeMs: number): number {
    const cutoff = Math.floor((Date.now() - maxAgeMs) / 1000);
    const result = db.sql.query("DELETE FROM intent_cache WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
}
