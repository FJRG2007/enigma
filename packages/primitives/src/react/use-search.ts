import { useRef, useState, useEffect, useMemo, type RefObject } from "react";
import { createSearch, type SearchOptions, type SearchMatch, type SearchInstance } from "@/core/search";

export interface UseSearchResult<T> {
    /** Attach to the search field, or drive it yourself with `search`. */
    inputRef: RefObject<HTMLInputElement | null>;
    query: string;
    results: SearchMatch<T>[];
    /** Debounced. */
    search: (query: string) => void;
    /** Skips the debounce. */
    searchNow: (query: string) => void;
    clear: () => void;
}

/**
 * Search-as-you-type over a list.
 *
 * Pass `fuse` (Fuse.js's constructor) for fuzzy matching, `matcher` to replace the
 * engine, or neither for the built-in accent-insensitive substring search.
 *
 * ```tsx
 * import Fuse from "fuse.js";
 *
 * const { inputRef, results } = useSearch({ items: docs, keys: ["title", "body"], fuse: Fuse });
 * return <input ref={inputRef} type="search" placeholder="Search" />;
 * ```
 */
export function useSearch<T>(options: SearchOptions<T> = {}): UseSearchResult<T> {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const instanceRef = useRef<SearchInstance<T> | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchMatch<T>[]>([]);

    // Built once. The engine indexes its items on construction, so rebuilding it per
    // render would re-index the whole list on every keystroke.
    const instance = useMemo(() => {
        const created = createSearch<T>({
            ...optionsRef.current,
            onResults: (next, nextQuery) => {
                setResults(next);
                setQuery(nextQuery);
                optionsRef.current.onResults?.(next, nextQuery);
            }
        });
        instanceRef.current = created;
        return created;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => instance.destroy(), [instance]);

    // New data must re-index and re-run the visible query, or the list shows matches
    // against items that are gone.
    useEffect(() => { instance.setItems(options.items ?? []); }, [instance, options.items]);

    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        return instance.attach(input);
    }, [instance]);

    return {
        inputRef,
        query,
        results,
        search: (next: string) => instance.search(next),
        searchNow: (next: string) => { instance.searchNow(next); },
        clear: () => {
            if (inputRef.current) inputRef.current.value = "";
            instance.searchNow("");
        }
    };
}
