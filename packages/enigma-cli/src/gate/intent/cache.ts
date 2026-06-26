/**
 * Faithful port of no-mistakes' `internal/intent/cache.go`: the summarization
 * Cache interface, its db-backed and in-memory implementations, and the
 * deterministic cache-key derivation.
 */

import type { Database } from "../db";
import type { Session } from "./reader";
import { createHash } from "node:crypto";
import { getIntentCache, putIntentCache } from "../db";

/**
 * Cache abstracts the summarization cache behind a small interface so the
 * extractor can be exercised without a real DB in tests. `get` returns a
 * `[summary, found]` tuple mirroring Go's `(string, bool)`.
 */
export interface Cache {
    get(key: string): [string, boolean];
    put(key: string, summary: string, agentName: string, sessionId: string): void;
}

/** Production cache backed by the intent_cache db helpers. */
class DbCache implements Cache {
    constructor(private readonly db: Database) {}

    get(key: string): [string, boolean] {
        const entry = getIntentCache(this.db, key);
        if (entry === null) {
            return ["", false];
        }
        return [entry.summary, true];
    }

    put(key: string, summary: string, agentName: string, sessionId: string): void {
        try {
            putIntentCache(this.db, { cacheKey: key, summary, agentName, sessionId, createdAt: 0 });
        } catch {
            // Best-effort, like the Go `_ =` discard of the put error.
        }
    }
}

/** In-memory cache used when the DB is unavailable and in tests. */
class MemCache implements Cache {
    private readonly store = new Map<string, string>();

    get(key: string): [string, boolean] {
        const v = this.store.get(key);
        if (v === undefined) {
            return ["", false];
        }
        return [v, true];
    }

    put(key: string, summary: string): void {
        this.store.set(key, summary);
    }
}

/** Wraps a Database as a Cache; falls back to an in-memory cache when null. */
export function newDBCache(database: Database | null): Cache {
    if (database === null) {
        return new MemCache();
    }
    return new DbCache(database);
}

/** Returns an in-memory Cache. Mainly for tests. */
export function newMemCache(): Cache {
    return new MemCache();
}

/**
 * cacheKeyFor derives a deterministic cache key. We include the agent name,
 * session id, last-message key, and message count - the latter two are
 * independent stale-detection signals so a buggy reader that fails to update
 * LastMsgKey on append still gets cache misses on growth.
 */
export function cacheKeyFor(s: Session): string {
    const input = `${s.agentName}|${s.sessionId}|${s.lastMsgKey}|${s.messages.length}`;
    return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}
