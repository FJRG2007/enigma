/**
 * The parts of a select that are not rendering: what is chosen, what is visible after the
 * filter, and where the highlight goes when a key is pressed.
 *
 * Framework-agnostic on purpose - the React layer over this file is thin, and a renderer
 * that is not React only has to draw. The two hard parts of a select live here: a selection
 * that behaves the same whether one value or many are allowed, and a highlight that never
 * lands on a disabled row.
 *
 * Filtering reuses the search core, so a select filters exactly like the search field does:
 * accent-insensitive substring by default, Fuse.js when you hand over its constructor, or
 * your own matcher. Fuse is never imported here - it is a peer the caller passes or not.
 */

import { createSearch, type FuseConstructor, type SearchOptions, type SearchInstance } from "@/core/search";

export interface SelectOption {
    /** What ends up in `value`. Unique within the list. */
    value: string;
    /** What is read and what the filter searches. */
    label: string;
    /** A second line under the label. Searched as well. */
    description?: string;
    /**
     * Anything the renderer can draw beside the label - a ReactNode, an URL, a name. Typed
     * as `unknown` because a core shared by every adapter cannot know what a node is.
     */
    icon?: unknown;
    /** Visible, listed, announced as unavailable, and never selectable or highlightable. */
    disabled?: boolean;
    /** Rows carrying the same group render together under its name. */
    group?: string;
    /** Extra words the filter should match - synonyms, an old name, a code. */
    keywords?: string[];
}

/** The fields the filter reads when the caller does not say. */
export const SELECT_SEARCH_KEYS = ["label", "description", "group", "keywords"];

export interface SelectOptions {
    options?: readonly SelectOption[];
    /** A string, a list when `multiple`, or null for nothing chosen. */
    value?: string | readonly string[] | null;
    multiple?: boolean;
    /** Filter the list from a field inside the panel. */
    searchable?: boolean;
    /** Fuse.js's constructor, for fuzzy filtering. Omit it for the built-in matcher. */
    fuse?: FuseConstructor;
    fuseOptions?: Record<string, unknown>;
    matcher?: SearchOptions<SelectOption>["matcher"];
    searchKeys?: string[];
    /** Close after a choice. Default: true when one value is allowed, false when many are. */
    closeOnSelect?: boolean;
    /** Every state change. */
    onChange?: (state: SelectState) => void;
    /**
     * Only the value, in the shape the caller asked for: a string, or a list when
     * `multiple`. The React layer narrows this per mode, so a call site never has to
     * widen it back by hand.
     */
    onValueChange?: (value: string | string[], options: SelectOption[]) => void;
}

export interface SelectState {
    open: boolean;
    query: string;
    /** Index into `visible`. -1 when there is nothing to highlight. */
    active: number;
    /** What the panel shows: every option, or what survived the filter. */
    visible: SelectOption[];
    /** The chosen options, in the order they were chosen. */
    selected: SelectOption[];
    /** The chosen values, always as a list - `multiple` decides what is reported outwards. */
    value: string[];
    multiple: boolean;
    /** True when a filter is running and matched nothing. */
    empty: boolean;
}

export interface SelectInstance {
    readonly state: SelectState;
    setOpen(open: boolean): void;
    toggleOpen(): void;
    setQuery(query: string): void;
    /** Move the highlight, skipping disabled rows. */
    move(key: SelectMoveKey): void;
    setActive(index: number): void;
    /** Choose a row: replaces the value, or toggles it when many are allowed. */
    select(value: string): void;
    /** Choose whatever is highlighted. */
    selectActive(): void;
    /** Drop one value. The × on a tag. */
    remove(value: string): void;
    clear(): void;
    /** Jump to the row starting with what was typed, the way a native select does. */
    typeahead(character: string): void;
    update(options: Partial<SelectOptions>): void;
    subscribe(listener: (state: SelectState) => void): () => void;
    destroy(): void;
}

export type SelectMoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";

/** How long a typeahead buffer survives. Long enough to type a word, short enough to reset. */
const TYPEAHEAD_MS = 600;
const PAGE = 5;

/** "Perú" must be reachable by typing "peru" - here as in the search core. */
function fold(value: string): string {
    return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function toList(value: SelectOptions["value"]): string[] {
    if (value == null) return [];
    return Array.isArray(value) ? [...value] : [value as string];
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** By identity: the option objects are the caller's, and a rebuilt list holds the same ones. */
function sameRows(left: readonly SelectOption[], right: readonly SelectOption[]): boolean {
    return left.length === right.length && left.every((option, index) => option === right[index]);
}

function sameState(left: SelectState, right: SelectState): boolean {
    return left.open === right.open
        && left.query === right.query
        && left.active === right.active
        && left.multiple === right.multiple
        && left.empty === right.empty
        && sameValues(left.value, right.value)
        && sameRows(left.visible, right.visible)
        && sameRows(left.selected, right.selected);
}

export function createSelect(options: SelectOptions = {}): SelectInstance {
    let opts: SelectOptions = { ...options };
    let all: readonly SelectOption[] = opts.options ?? [];
    let value = toList(opts.value);
    let open = false;
    let query = "";
    let active = -1;
    let visible: SelectOption[] = [...all];
    let typed = "";
    let typedAt = 0;
    let destroyed = false;
    const listeners = new Set<(state: SelectState) => void>();

    // One engine, built once and updated: it indexes on construction, so rebuilding it per
    // keystroke would re-index the whole list on every letter.
    const engine: SearchInstance<SelectOption> = createSearch<SelectOption>({
        items: all,
        keys: opts.searchKeys ?? SELECT_SEARCH_KEYS,
        fuse: opts.fuse,
        fuseOptions: opts.fuseOptions,
        matcher: opts.matcher,
        // A select filters as you type. There is nothing to debounce: the data is already
        // in memory, and a delay here is felt as the list lagging behind the field.
        debounce: 0,
        // An empty query in a select means "everything", not "nothing" - the opposite of a
        // search field, where an empty query has nothing to show.
        empty: "all"
    });

    function optionOf(candidate: string): SelectOption | undefined {
        return all.find((option) => option.value === candidate);
    }

    function selectedOptions(): SelectOption[] {
        // Mapped through the option list so a value with no option left (data reloaded,
        // an id that no longer exists) simply disappears instead of rendering a blank tag.
        return value.map(optionOf).filter((option): option is SelectOption => Boolean(option));
    }

    function snapshot(): SelectState {
        return {
            open,
            query,
            active,
            visible,
            selected: selectedOptions(),
            value: [...value],
            multiple: Boolean(opts.multiple),
            empty: visible.length === 0
        };
    }

    function emit(): void {
        const state = snapshot();
        opts.onChange?.(state);
        for (const listener of listeners) listener(state);
    }

    /** Positive modulo: the walk goes backwards as often as forwards. */
    function wrap(index: number): number {
        const length = visible.length;
        return ((index % length) + length) % length;
    }

    function enabledIndex(from: number, step: number): number {
        if (visible.length === 0) return -1;
        // Walks at most once around the list: a list whose rows are all disabled is a real
        // list, and it has to leave the highlight nowhere rather than spin looking for one.
        for (let attempt = 0; attempt < visible.length; attempt++) {
            const index = wrap(from + step * attempt);
            if (!visible[index]?.disabled) return index;
        }
        return -1;
    }

    /** The option the highlight is on, so a filter can put it back where it was. */
    let lastActive: SelectOption | undefined;

    function refilter(): void {
        visible = opts.searchable && query.trim()
            ? engine.searchNow(query).map((match) => match.item)
            : [...all];

        // The highlight follows the row it was on when that row survived the filter, so
        // deleting a letter does not throw the selection back to the top of the list.
        const current = active >= 0 ? visible.findIndex((option) => option === lastActive) : -1;
        active = current >= 0 && !visible[current]?.disabled ? current : enabledIndex(0, 1);
        lastActive = visible[active];
    }

    function reportValue(): void {
        const chosen = selectedOptions();
        opts.onValueChange?.((opts.multiple ? [...value] : value[0] ?? "") as never, chosen);
    }

    function closesOnSelect(): boolean {
        return opts.closeOnSelect ?? !opts.multiple;
    }

    refilter();

    return {
        get state() { return snapshot(); },

        setOpen(next: boolean) {
            if (destroyed || open === next) return;
            open = next;
            if (open) {
                // Opening starts clean and lands on what is already chosen: a select that
                // reopens on the first row makes you find your own value again.
                query = "";
                refilter();
                const chosen = value[0] ? visible.findIndex((option) => option.value === value[0]) : -1;
                active = chosen >= 0 && !visible[chosen]?.disabled ? chosen : enabledIndex(0, 1);
                lastActive = visible[active];
            } else {
                query = "";
                typed = "";
                refilter();
            }
            emit();
        },

        toggleOpen() { this.setOpen(!open); },

        setQuery(next: string) {
            if (destroyed) return;
            query = next;
            refilter();
            emit();
        },

        move(key: SelectMoveKey) {
            if (destroyed || visible.length === 0) return;
            const from = active < 0 ? -1 : active;
            switch (key) {
                // Wrapping, because a select is a short list and the row after the last one
                // is the first: clamping leaves the arrow key doing nothing, which reads as
                // the panel having frozen.
                case "ArrowDown": active = enabledIndex(from + 1, 1); break;
                case "ArrowUp": active = enabledIndex(from - 1 + visible.length, -1); break;
                case "Home": active = enabledIndex(0, 1); break;
                case "End": active = enabledIndex(visible.length - 1, -1); break;
                case "PageDown": active = enabledIndex(Math.min(visible.length - 1, from + PAGE), 1); break;
                case "PageUp": active = enabledIndex(Math.max(0, from - PAGE), -1); break;
            }
            lastActive = visible[active];
            emit();
        },

        setActive(index: number) {
            // The row already highlighted is not a change: this arrives from `pointermove`,
            // which fires on every pixel, and emitting there re-renders the whole panel
            // sixty times a second - and the scroll it triggers moves the row under a
            // stationary cursor, which fires it again.
            if (destroyed || index === active || index < 0 || index >= visible.length || visible[index]?.disabled) return;
            active = index;
            lastActive = visible[active];
            emit();
        },

        select(next: string) {
            if (destroyed) return;
            const option = optionOf(next);
            // A disabled row is listed and announced, never chosen - including by a click
            // that got through, which is the one path a renderer tends to forget.
            if (!option || option.disabled) return;

            if (opts.multiple) {
                value = value.includes(next) ? value.filter((entry) => entry !== next) : [...value, next];
            } else {
                value = [next];
            }

            reportValue();
            if (closesOnSelect()) {
                open = false;
                query = "";
                refilter();
            }
            emit();
        },

        selectActive() {
            const option = visible[active];
            if (option) this.select(option.value);
        },

        remove(next: string) {
            if (destroyed || !value.includes(next)) return;
            value = value.filter((entry) => entry !== next);
            reportValue();
            emit();
        },

        clear() {
            if (destroyed || value.length === 0) return;
            value = [];
            reportValue();
            emit();
        },

        typeahead(character: string) {
            if (destroyed || character.length !== 1) return;
            const now = Date.now();
            typed = now - typedAt > TYPEAHEAD_MS ? character : typed + character;
            typedAt = now;

            const needle = fold(typed);
            // A single letter searches from the row AFTER this one, so pressing it again
            // walks through everything starting with it instead of sticking on the first
            // match; a longer buffer searches from the current row, so refining a word
            // does not jump off the option it already found.
            const from = typed.length === 1 ? 1 : 0;
            for (let step = from; step < visible.length + from; step++) {
                const index = wrap(Math.max(active, 0) + step);
                const option = visible[index];
                if (!option || option.disabled) continue;
                if (fold(option.label).startsWith(needle)) {
                    active = index;
                    lastActive = option;
                    emit();
                    return;
                }
            }
        },

        update(next: Partial<SelectOptions>) {
            if (destroyed) return;
            const before = snapshot();
            const hadOptions = next.options !== undefined;
            opts = { ...opts, ...next };
            if (hadOptions) all = next.options ?? [];
            if (next.value !== undefined) value = toList(next.value);
            if (hadOptions || next.searchKeys || next.fuse || next.fuseOptions || next.matcher) {
                engine.update({
                    items: all,
                    keys: opts.searchKeys ?? SELECT_SEARCH_KEYS,
                    fuse: opts.fuse,
                    fuseOptions: opts.fuseOptions,
                    matcher: opts.matcher
                });
            }
            refilter();
            // An update that changed nothing must not emit. A renderer subscribes to this
            // and pushes its props back in whenever it renders, so emitting regardless
            // redraws the whole panel for a list, a filter and a value that are the ones it
            // already had - and hands any renderer that rebuilds those props a render loop.
            if (!sameState(before, snapshot())) emit();
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },

        destroy() {
            destroyed = true;
            listeners.clear();
            engine.destroy();
        }
    };
}
