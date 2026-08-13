/**
 * Short-TTL read cache with in-flight deduplication.
 *
 * The dedupe is the half that actually matters: two components mounting in the
 * same tick ask for the same key once, so a rate limit sees one request instead
 * of five. The TTL then keeps the answer around long enough for a remount.
 */

export type CacheStorageKind = "memory" | "local" | "session";

export interface CacheOptions {
    /** Prefix for persisted keys, so two caches never collide in one origin. */
    namespace?: string;
    /** How long an entry stays fresh, in ms. */
    ttl?: number;
    /** Where entries survive. "memory" does not outlive the page. */
    storage?: CacheStorageKind;
    /** Entries kept in memory before the oldest is evicted. */
    maxEntries?: number;
}

export interface CacheEntry<T> {
    value: T;
    /** epoch ms at which the entry stops being fresh. */
    expires: number;
}

export interface Cache {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttl?: number): void;
    has(key: string): boolean;
    /** Drop one key, or every key under a prefix when it ends in "*". */
    invalidate(pattern: string): void;
    clear(): void;
    /**
     * Read through the cache. Concurrent calls for one key share a single
     * loader call; a rejection is never cached.
     */
    read<T>(key: string, loader: () => Promise<T>, ttl?: number): Promise<T>;
    /** Called whenever a key's value changes. Returns an unsubscribe. */
    subscribe(listener: (key: string) => void): () => void;
}

const DEFAULT_TTL = 30_000;
const DEFAULT_MAX_ENTRIES = 200;

function backing(kind: CacheStorageKind): Storage | null {
    if (kind === "memory" || typeof window === "undefined") return null;
    try {
        const store = kind === "local" ? window.localStorage : window.sessionStorage;
        // Private-mode Safari exposes the object and throws on write.
        const probe = "__enigma_probe__";
        store.setItem(probe, "1");
        store.removeItem(probe);
        return store;
    } catch {
        return null;
    }
}

export function createCache(options: CacheOptions = {}): Cache {
    const namespace = options.namespace ?? "enigma";
    const defaultTtl = options.ttl ?? DEFAULT_TTL;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const store = backing(options.storage ?? "memory");

    const memory = new Map<string, CacheEntry<unknown>>();
    const inFlight = new Map<string, Promise<unknown>>();
    const listeners = new Set<(key: string) => void>();

    const persistedKey = (key: string) => `${namespace}:${key}`;

    function readEntry(key: string): CacheEntry<unknown> | undefined {
        const local = memory.get(key);
        if (local) return local;
        if (!store) return undefined;
        const raw = store.getItem(persistedKey(key));
        if (!raw) return undefined;
        try {
            const parsed = JSON.parse(raw) as CacheEntry<unknown>;
            memory.set(key, parsed);
            return parsed;
        } catch {
            store.removeItem(persistedKey(key));
            return undefined;
        }
    }

    function writeEntry(key: string, entry: CacheEntry<unknown>): void {
        memory.set(key, entry);
        if (memory.size > maxEntries) {
            const oldest = memory.keys().next().value;
            if (oldest !== undefined) memory.delete(oldest);
        }
        if (store) {
            // A full quota must not take the read path down with it.
            try { store.setItem(persistedKey(key), JSON.stringify(entry)); } catch { /* quota */ }
        }
        for (const listener of listeners) listener(key);
    }

    function drop(key: string): void {
        memory.delete(key);
        store?.removeItem(persistedKey(key));
        for (const listener of listeners) listener(key);
    }

    return {
        get<T>(key: string): T | undefined {
            const entry = readEntry(key);
            if (!entry) return undefined;
            if (entry.expires <= Date.now()) {
                drop(key);
                return undefined;
            }
            return entry.value as T;
        },
        set<T>(key: string, value: T, ttl?: number): void {
            writeEntry(key, { value, expires: Date.now() + (ttl ?? defaultTtl) });
        },
        has(key: string): boolean {
            const entry = readEntry(key);
            return Boolean(entry && entry.expires > Date.now());
        },
        invalidate(pattern: string): void {
            if (!pattern.endsWith("*")) {
                drop(pattern);
                return;
            }
            const prefix = pattern.slice(0, -1);
            for (const key of [...memory.keys()]) if (key.startsWith(prefix)) drop(key);
            if (!store) return;
            const scoped = persistedKey(prefix);
            for (let index = store.length - 1; index >= 0; index--) {
                const key = store.key(index);
                if (key?.startsWith(scoped)) store.removeItem(key);
            }
        },
        clear(): void {
            for (const key of [...memory.keys()]) drop(key);
        },
        async read<T>(key: string, loader: () => Promise<T>, ttl?: number): Promise<T> {
            const entry = readEntry(key);
            if (entry && entry.expires > Date.now()) return entry.value as T;

            const pending = inFlight.get(key);
            if (pending) return pending as Promise<T>;

            const request = loader()
                .then(value => {
                    writeEntry(key, { value, expires: Date.now() + (ttl ?? defaultTtl) });
                    return value;
                })
                .finally(() => { inFlight.delete(key); });

            inFlight.set(key, request);
            return request;
        },
        subscribe(listener: (key: string) => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }
    };
}
