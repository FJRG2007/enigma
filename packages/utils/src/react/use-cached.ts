import { createCache, type Cache } from "@/core/cache";
import { useRef, useState, useEffect, useCallback } from "react";

/** Shared by default, so two components asking for one key make one request. */
const defaultCache = createCache({ namespace: "enigma", storage: "session" });

export interface UseCachedOptions<T> {
    /** Override the shared cache, e.g. to use a different TTL or storage. */
    cache?: Cache;
    ttl?: number;
    /** Skip the request without unmounting, e.g. while an id is still unknown. */
    enabled?: boolean;
    /** Rendered before the first response so the shell never waits on data. */
    placeholder?: T;
}

export interface UseCachedResult<T> {
    data: T | undefined;
    error: Error | null;
    /** True only while a request is in flight AND nothing cached is on screen. */
    loading: boolean;
    /** True while revalidating behind a value that is already rendered. */
    validating: boolean;
    refresh: () => Promise<void>;
    invalidate: () => void;
}

/**
 * Read a value through a short-TTL cache.
 *
 * A cached value is returned on the first render, so a remount paints instantly
 * instead of flashing a skeleton over data the app already has.
 */
export function useCached<T>(key: string, loader: () => Promise<T>, options: UseCachedOptions<T> = {}): UseCachedResult<T> {
    const cache = options.cache ?? defaultCache;
    const enabled = options.enabled ?? true;
    const loaderRef = useRef(loader);
    loaderRef.current = loader;

    const [data, setData] = useState<T | undefined>(() => cache.get<T>(key) ?? options.placeholder);
    const [error, setError] = useState<Error | null>(null);
    const [validating, setValidating] = useState(false);

    const load = useCallback(async (force: boolean) => {
        if (!enabled) return;
        if (force) cache.invalidate(key);
        setValidating(true);
        try {
            const value = await cache.read(key, () => loaderRef.current(), options.ttl);
            setData(value);
            setError(null);
        } catch (cause) {
            setError(cause instanceof Error ? cause : new Error(String(cause)));
        } finally {
            setValidating(false);
        }
    }, [cache, key, enabled, options.ttl]);

    useEffect(() => {
        const cached = cache.get<T>(key);
        if (cached !== undefined) setData(cached);
        void load(false);
    }, [cache, key, load]);

    // Another component invalidating this key must update this one too.
    useEffect(() => cache.subscribe(changed => {
        if (changed !== key) return;
        setData(cache.get<T>(key));
    }), [cache, key]);

    return {
        data,
        error,
        loading: data === undefined && validating,
        validating,
        refresh: () => load(true),
        invalidate: () => cache.invalidate(key)
    };
}

export { defaultCache };
