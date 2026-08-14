import Fuse from "fuse.js";
import type { ReactNode } from "react";
import { useSearch } from "@enigmax/primitives/react";

/**
 * A styled search field with its result list, yours to edit.
 *
 * Debouncing, ranking, cancellation and the Escape-to-clear all come from the primitive.
 * Drop the Fuse import and the `fuse` prop to fall back to the built-in
 * accent-insensitive substring matcher and no dependency at all.
 */
export interface SearchProps<T> {
    items: T[];
    /** Fields to search. Dotted paths work: "author.name". */
    keys: string[];
    placeholder?: string;
    /** Fuzzy matching. Omit for the zero-dependency substring matcher. */
    fuzzy?: boolean;
    emptyMessage?: string;
    children: (item: T, score: number) => ReactNode;
}

export function Search<T>({
    items,
    keys,
    placeholder = "Search",
    fuzzy = true,
    emptyMessage = "No matches",
    children
}: SearchProps<T>) {
    const { inputRef, results, query } = useSearch<T>({
        items,
        keys,
        fuse: fuzzy ? (Fuse as never) : undefined,
        debounce: 120
    });

    return (
        <div className="grid gap-2.5">
            <input
                ref={inputRef}
                type="search"
                aria-label={placeholder}
                placeholder={placeholder}
                className="
                    rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5
                    text-sm text-neutral-100 outline-none
                    placeholder:text-neutral-500 focus:border-neutral-400
                "
            />

            {query && (
                <p className="font-mono text-[11px] text-neutral-500">
                    {results.length} result{results.length === 1 ? "" : "s"} for &quot;{query}&quot;
                </p>
            )}

            <ul className="grid list-none gap-1.5 p-0">
                {results.map((result, index) => (
                    <li
                        key={index}
                        className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
                    >
                        {children(result.item, result.score)}
                    </li>
                ))}
                {query && results.length === 0 && (
                    <li className="text-sm text-neutral-500">{emptyMessage}</li>
                )}
            </ul>
        </div>
    );
}
