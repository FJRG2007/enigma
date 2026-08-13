/**
 * Search-as-you-type: debouncing, ordering, cancellation and the field wiring, with the
 * matching left pluggable.
 *
 * Fuse.js is NOT a dependency of this package. Hand it the constructor and you get fuzzy
 * matching configured exactly as if you had called it yourself - `fuseOptions` is passed
 * through untouched. Hand it nothing and a built-in accent-insensitive substring matcher
 * runs instead, so the primitive works with zero dependencies. Hand it a `matcher` and
 * every part of this is replaced by your own.
 */

export interface SearchMatch<T> {
    item: T;
    /** Lower is better, matching Fuse's convention. 0 is an exact hit. */
    score: number;
    /** Which key matched, when the matcher reports it. */
    key?: string;
}

/** The shape of Fuse's constructor, declared here so the package need not depend on it. */
export interface FuseLike<T> {
    search(query: string): { item: T; score?: number; matches?: { key?: string; }[]; }[];
}
export type FuseConstructor = new <T>(items: readonly T[], options?: Record<string, unknown>) => FuseLike<T>;

export interface SearchOptions<T> {
    items?: readonly T[];
    /** Fields to search. Dotted paths work with the built-in matcher and with Fuse. */
    keys?: string[];
    /**
     * Pass Fuse.js's constructor to get fuzzy matching. Omit it for the built-in
     * substring matcher. Ignored when `matcher` is set.
     */
    fuse?: FuseConstructor;
    /** Handed to Fuse verbatim, so any Fuse option behaves exactly as documented there. */
    fuseOptions?: Record<string, unknown>;
    /** Replaces the engine entirely. Return the results in the order you want them. */
    matcher?: (query: string, items: readonly T[]) => SearchMatch<T>[];
    /** ms to wait after the last keystroke. 0 searches on every one. */
    debounce?: number;
    /** Queries shorter than this return nothing rather than everything. */
    minLength?: number;
    /** Cap the result list. */
    limit?: number;
    /** What an empty query returns. "none" (default) or "all". */
    empty?: "none" | "all";
    onResults?: (results: SearchMatch<T>[], query: string) => void;
}

export interface SearchInstance<T> {
    readonly query: string;
    readonly results: SearchMatch<T>[];
    /** Debounced. */
    search(query: string): void;
    /** Skips the debounce, e.g. on Enter. */
    searchNow(query: string): SearchMatch<T>[];
    setItems(items: readonly T[]): void;
    update(options: Partial<SearchOptions<T>>): void;
    /** Bind to a field: input events search, Escape clears. Returns an unbind. */
    attach(input: HTMLInputElement): () => void;
    subscribe(listener: (results: SearchMatch<T>[], query: string) => void): () => void;
    destroy(): void;
}

const DEFAULT_DEBOUNCE = 120;

/** "Café" must match "cafe" - a search that fails on an accent reads as broken. */
function fold(value: string): string {
    return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function readPath(item: unknown, path: string): string {
    let cursor: unknown = item;
    for (const step of path.split(".")) {
        if (cursor == null || typeof cursor !== "object") return "";
        cursor = (cursor as Record<string, unknown>)[step];
    }
    return cursor == null ? "" : String(cursor);
}

/**
 * The zero-dependency fallback: accent-insensitive substring, ranked by where the match
 * lands and which key it landed in, so a title hit outranks a body hit.
 */
function substringMatcher<T>(query: string, items: readonly T[], keys: string[]): SearchMatch<T>[] {
    const needle = fold(query);
    const results: SearchMatch<T>[] = [];

    for (const item of items) {
        const fields = keys.length ? keys : [""];
        let best: SearchMatch<T> | null = null;

        for (let index = 0; index < fields.length; index++) {
            const key = fields[index];
            const haystack = fold(key ? readPath(item, key) : String(item));
            const at = haystack.indexOf(needle);
            if (at < 0) continue;
            // Earlier in the string and earlier in the key list is a better hit; a whole
            // field that IS the query scores 0.
            const score = haystack === needle ? 0 : (at + 1) / (haystack.length + 1) + index * 0.01;
            if (!best || score < best.score) best = { item, score, key: key || undefined };
        }
        if (best) results.push(best);
    }

    return results.sort((left, right) => left.score - right.score);
}

export function createSearch<T>(options: SearchOptions<T> = {}): SearchInstance<T> {
    let opts: SearchOptions<T> = { ...options };
    let items: readonly T[] = opts.items ?? [];
    let query = "";
    let results: SearchMatch<T>[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let engine: FuseLike<T> | null = null;
    let destroyed = false;
    const listeners = new Set<(results: SearchMatch<T>[], query: string) => void>();

    function buildEngine(): void {
        engine = null;
        if (opts.matcher || !opts.fuse) return;
        // Fuse indexes on construction, so it is rebuilt when the items or keys change
        // and never per keystroke.
        engine = new opts.fuse(items, { keys: opts.keys ?? [], includeScore: true, includeMatches: true, threshold: 0.4, ...opts.fuseOptions });
    }

    function run(next: string): SearchMatch<T>[] {
        const trimmed = next.trim();
        const minLength = opts.minLength ?? 1;

        let found: SearchMatch<T>[];
        // The limit applies to this branch too: a caller asking for 10 rows means 10 rows,
        // including the "show everything" state, which is the longest list of them all.
        if (trimmed.length < minLength) {
            found = (opts.empty ?? "none") === "all" ? items.map((item) => ({ item, score: 0 })) : [];
        } else if (opts.matcher) {
            found = opts.matcher(trimmed, items);
        } else if (engine) {
            found = engine.search(trimmed).map((hit) => ({
                item: hit.item,
                score: hit.score ?? 0,
                key: hit.matches?.[0]?.key
            }));
        } else {
            found = substringMatcher(trimmed, items, opts.keys ?? []);
        }

        return opts.limit != null ? found.slice(0, opts.limit) : found;
    }

    function publish(next: string): SearchMatch<T>[] {
        query = next;
        results = run(next);
        opts.onResults?.(results, query);
        for (const listener of listeners) listener(results, query);
        return results;
    }

    function clearTimer(): void {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    }

    buildEngine();

    return {
        get query() { return query; },
        get results() { return results; },
        search(next: string) {
            if (destroyed) return;
            clearTimer();
            const wait = opts.debounce ?? DEFAULT_DEBOUNCE;
            // A pending search is dropped rather than queued, so a fast typist gets one
            // pass over the data instead of one per keystroke.
            if (wait <= 0) { publish(next); return; }
            timer = setTimeout(() => { timer = null; publish(next); }, wait);
        },
        searchNow(next: string) {
            clearTimer();
            return publish(next);
        },
        setItems(next: readonly T[]) {
            items = next;
            buildEngine();
            // The visible results are stale the moment the data changes under them.
            if (query) publish(query);
        },
        update(next: Partial<SearchOptions<T>>) {
            opts = { ...opts, ...next };
            if (next.items) items = next.items;
            buildEngine();
            if (query) publish(query);
        },
        attach(input: HTMLInputElement) {
            const onInput = () => this.search(input.value);
            const onKeyDown = (event: KeyboardEvent) => {
                if (event.key !== "Escape" || !input.value) return;
                // Escape clears the field first and only then reaches the dialog around
                // it, which is what a visitor expects from a search box.
                event.stopPropagation();
                input.value = "";
                this.searchNow("");
            };
            input.addEventListener("input", onInput);
            input.addEventListener("keydown", onKeyDown);
            input.dataset.enigmaSearch = "";
            return () => {
                input.removeEventListener("input", onInput);
                input.removeEventListener("keydown", onKeyDown);
                delete input.dataset.enigmaSearch;
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        destroy() {
            destroyed = true;
            clearTimer();
            listeners.clear();
            engine = null;
        }
    };
}
