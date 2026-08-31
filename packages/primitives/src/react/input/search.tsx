"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createSearch, type SearchInstance, type SearchMatch, type SearchOptions } from "@/core/search";

/**
 * The search wiring for `<Input type="search">`: debouncing, ranking, cancellation, and the
 * results the field reports.
 *
 * Its own chunk, imported the moment a search field is given something to search - so a
 * password form never downloads a matcher, and a project that passes Fuse's constructor
 * only pays for it on the page that has the field.
 *
 * The engine is attached to the field the base component rendered rather than rendering one
 * of its own: two owners of one input is the thing that makes a wrapper feel wrong, and the
 * field has to stay a plain `<input>` the consumer can pass any native prop to.
 */

export interface SearchExtrasProps<Item = unknown> {
    /** The field itself. Null until it mounts, which is one render. */
    input: HTMLInputElement | null;
    items?: Item[];
    keys?: SearchOptions<Item>["keys"];
    delay?: number;
    limit?: number;
    fuse?: SearchOptions<Item>["fuse"];
    fuseOptions?: SearchOptions<Item>["fuseOptions"];
    matcher?: SearchOptions<Item>["matcher"];
    onResults?: (matches: SearchMatch<Item>[], query: string) => void;
    renderResults?: (matches: SearchMatch<Item>[], query: string) => ReactNode;
}

export function SearchExtras<Item>({
    input,
    items,
    keys,
    delay = 150,
    limit,
    fuse,
    fuseOptions,
    matcher,
    onResults,
    renderResults
}: SearchExtrasProps<Item>): ReactNode {
    const [results, setResults] = useState<SearchMatch<Item>[]>([]);
    const [query, setQuery] = useState("");

    const listener = useRef(onResults);
    listener.current = onResults;

    // Built once. The engine indexes on construction, so rebuilding it per render would
    // re-index the whole list on every keystroke - the defect this exists to avoid.
    const instance = useMemo<SearchInstance<Item>>(() => createSearch<Item>({
        items,
        keys,
        fuse,
        fuseOptions,
        matcher,
        debounce: delay,
        limit,
        onResults: (next, nextQuery) => {
            setResults(next);
            setQuery(nextQuery);
            listener.current?.(next, nextQuery);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    useEffect(() => () => instance.destroy(), [instance]);

    // New data must re-index and re-run the visible query, or the list keeps showing
    // matches against items that are gone.
    useEffect(() => { instance.setItems(items ?? []); }, [instance, items]);
    useEffect(() => { instance.update({ keys, fuse, fuseOptions, matcher, debounce: delay, limit }); }, [instance, keys, fuse, fuseOptions, matcher, delay, limit]);

    useEffect(() => {
        if (!input) return;
        return instance.attach(input);
    }, [instance, input]);

    return renderResults ? <>{renderResults(results, query)}</> : null;
}
