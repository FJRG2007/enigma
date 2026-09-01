/**
 * The parts of a context menu that are not rendering: which branch is open, where the
 * highlight is inside it, what a submenu's rows are once they have been fetched, and which
 * of those rows survived the filter.
 *
 * Framework-agnostic like every other core here, and for the same reason: the arithmetic of
 * a menu is not React. What IS specific to this one is that a menu is a TREE and a select is
 * a list, so everything below is keyed by a PATH - the list of item ids from the root down to
 * the open submenu - rather than by an index.
 *
 * The behaviour it copies is the Windows one, deliberately: a right-click opens it at the
 * pointer, a submenu opens after a beat of hovering and closes after a beat of leaving,
 * arrows walk the rows and skip everything that cannot be chosen, Right opens a submenu and
 * Left goes back, and typing jumps to a row.
 */

import { typeaheadStep } from "@/core/keys";
import { createSearch, type FuseConstructor, type SearchOptions, type SearchInstance } from "@/core/search";

/** A row that does something. The default kind, so `type` can be left off. */
export interface ContextMenuAction {
    type?: "item";
    /** Unique among its SIBLINGS. The path down the tree is built from these. */
    id: string;
    label: string;
    /** A second line under the label, for a row whose consequence is not obvious. */
    description?: string;
    /** Anything the renderer can draw - a node, a URL, a name. `unknown` because a core cannot know. */
    icon?: unknown;
    /**
     * Printed on the right, the way every desktop menu prints it: `"Mod+C"`, `"F2"`,
     * `"Delete"`. Written by `shortcutTokens` for the platform it is rendered on, so one
     * spec is `⌘C` on a Mac and `Ctrl+C` elsewhere.
     */
    shortcut?: string;
    /** Listed, announced as unavailable, never highlighted and never invoked. */
    disabled?: boolean;
    /** Deletes something. Rendered in the destructive colour and reported as such. */
    destructive?: boolean;
    /** A checkable row: a tick, or a radio dot when `group` is set. */
    checked?: boolean;
    /** Rows carrying the same group render together under its name, and check as a radio set. */
    group?: string;
    /** Extra words the filter should match. */
    keywords?: string[];
    /** A heading over this row's submenu. See `ContextMenuOptions.title` for what it is for. */
    title?: string;
    /** A submenu, known up front. An empty list is not a submenu: the row keeps no arrow. */
    items?: readonly ContextMenuEntry[];
    /**
     * A submenu fetched on demand, once. What it returns is cached under this row's path for
     * `cacheMs`, so reopening the branch shows the rows immediately instead of spinning
     * again - which is the whole reason a slow submenu is bearable.
     */
    loadItems?: () => Promise<readonly ContextMenuEntry[]>;
    /** Put a filter in this submenu. `"auto"` (the default) adds one from `SEARCHABLE_FROM` rows. */
    searchable?: boolean | "auto";
    /** Anything the caller wants back in `onSelect`. */
    data?: unknown;
}

/** A rule between two blocks of rows. Never highlighted, never counted by the keyboard. */
export interface ContextMenuSeparator {
    type: "separator";
    id?: string;
}

/** A caption over a block of rows. Same rules as a separator: visible, unreachable. */
export interface ContextMenuLabel {
    type: "label";
    id?: string;
    label: string;
}

export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator | ContextMenuLabel;

/** Whether an entry is a row the keyboard and the pointer can land on. */
export function isAction(entry: ContextMenuEntry): entry is ContextMenuAction {
    return (entry.type ?? "item") === "item";
}

/** The fields the filter reads when the caller does not say. */
export const CONTEXT_MENU_SEARCH_KEYS = ["label", "description", "group", "keywords"];

/** Filtering six rows is worth a field; filtering three is a bigger panel for nothing. */
export const SEARCHABLE_FROM = 8;

/** Where a menu was opened. Viewport coordinates, which is what a pointer event reports. */
export interface ContextMenuPoint {
    x: number;
    y: number;
}

/** One open level: the root, then one per submenu below it. */
export interface ContextMenuLevel {
    /** Ids from the root down to the item that opened this level. Empty for the root. */
    path: string[];
    /** A heading over the rows, or null. Also the panel's accessible name. */
    title: string | null;
    /** Every entry at this level, separators and labels included. */
    entries: ContextMenuEntry[];
    /** What the panel shows: the entries, or what survived the filter. */
    visible: ContextMenuEntry[];
    /** Index into `visible`. -1 when nothing is highlighted. */
    active: number;
    query: string;
    /** Whether this level draws a filter field. */
    searchable: boolean;
    /** An awaited submenu that has not answered yet. */
    loading: boolean;
    /** What the load rejected with, so the level can say so instead of staying empty. */
    error: Error | null;
}

export interface ContextMenuState {
    open: boolean;
    /** Where it was opened, in viewport coordinates. Null while closed. */
    point: ContextMenuPoint | null;
    /** The root level first, then one per open submenu. */
    levels: ContextMenuLevel[];
}

export interface ContextMenuOptions {
    items?: readonly ContextMenuEntry[];
    /**
     * A heading over the rows, naming what the menu is acting ON - the file that was
     * right-clicked, or "12 items selected". A menu opened at the pointer is the one surface
     * with no context around it, so without this the rows are the only clue about what they
     * will happen to.
     */
    title?: string;
    /** Fuse.js's constructor, for fuzzy filtering. Omit it for the built-in matcher. */
    fuse?: FuseConstructor;
    fuseOptions?: Record<string, unknown>;
    matcher?: SearchOptions<ContextMenuEntry>["matcher"];
    searchKeys?: string[];
    /** How long a fetched submenu stays cached. 0 refetches every time. Default 5 minutes. */
    cacheMs?: number;
    /** Every state change. */
    onChange?: (state: ContextMenuState) => void;
    /** A row was invoked. The menu has already closed unless the row keeps it open. */
    onSelect?: (item: ContextMenuAction, path: string[]) => void;
    onOpenChange?: (open: boolean) => void;
}

export interface ContextMenuInstance {
    readonly state: ContextMenuState;
    /**
     * Open at a point, or reopen somewhere else - a second right-click MOVES the menu.
     *
     * Returns whether it opened. A menu with no rows to show does NOT open: an empty box at
     * the pointer says nothing, and refusing here is what lets the trigger leave the press
     * alone so the browser's own menu appears instead of nothing at all.
     */
    open(point: ContextMenuPoint): boolean;
    close(): void;
    /** Move the highlight inside the deepest open level, skipping what cannot be chosen. */
    move(key: ContextMenuMoveKey): void;
    setActive(level: number, index: number): void;
    setQuery(level: number, query: string): void;
    /**
     * Open the submenu of the row at `index` in `level`, closing any deeper branch.
     *
     * `focus` highlights its first row, which is what the KEYBOARD needs and what a pointer
     * must not do: a row that looks hovered before the pointer arrives reads as the menu
     * having chosen for you. Default false, so hovering is the plain case.
     */
    openSubmenu(level: number, index: number, focus?: boolean): void;
    /** Close every level below `level`. */
    closeBelow(level: number): void;
    /** Invoke a row: reports it, and closes unless it is disabled or opens a submenu. */
    select(level: number, index: number): void;
    /** Invoke whatever is highlighted in the deepest open level. */
    selectActive(): void;
    /** Right on a row with a submenu opens it; on any other row it does nothing. */
    enterSubmenu(): void;
    /** Left closes the deepest submenu and puts the highlight back on the row that opened it. */
    leaveSubmenu(): void;
    /** Jump to the row starting with what was typed, the way a desktop menu does. */
    typeahead(character: string): void;
    /** Drop what a fetched submenu returned, so the next open asks again. */
    invalidate(path?: string[]): void;
    update(options: Partial<ContextMenuOptions>): void;
    subscribe(listener: (state: ContextMenuState) => void): () => void;
    destroy(): void;
}

export type ContextMenuMoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";

const PAGE = 5;
const DEFAULT_CACHE_MS = 5 * 60 * 1000;

/** "Añadir" must be reachable by typing "anadir" - here as in the search core. */
function fold(value: string): string {
    return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** One fetched submenu, and when it was fetched. */
interface CacheEntry {
    at: number;
    entries?: readonly ContextMenuEntry[];
    /** The request itself while it is in flight, so two opens never fetch twice. */
    pending?: Promise<readonly ContextMenuEntry[]>;
}

export function createContextMenu(options: ContextMenuOptions = {}): ContextMenuInstance {
    let opts: ContextMenuOptions = { ...options };
    let root: readonly ContextMenuEntry[] = opts.items ?? [];
    let open = false;
    let point: ContextMenuPoint | null = null;
    let levels: ContextMenuLevel[] = [];
    let typed = "";
    let typedAt = 0;
    let destroyed = false;
    const listeners = new Set<(state: ContextMenuState) => void>();
    /** Fetched submenus, keyed by their path. Survives a close: that is what makes it a cache. */
    const cache = new Map<string, CacheEntry>();
    /** Paths whose submenu was opened by the KEYBOARD, and so arrives with a row highlighted. */
    const wantsFocus = new Set<string>();
    /**
     * One filter engine per level, kept while its rows are the same ones.
     *
     * The engine indexes on construction, so building it inside the filter would re-index the
     * whole level on every letter - which is exactly the case a filter exists for, a submenu
     * with hundreds of rows in it.
     */
    const engines = new Map<string, { items: readonly ContextMenuEntry[]; engine: SearchInstance<ContextMenuEntry>; }>();

    function cacheMs(): number {
        return opts.cacheMs ?? DEFAULT_CACHE_MS;
    }

    function keyOf(path: string[]): string {
        return path.join("\u0000");
    }

    function searchableFor(item: ContextMenuAction | null, entries: readonly ContextMenuEntry[]): boolean {
        const asked = item?.searchable ?? "auto";
        if (asked !== "auto") return asked;
        return entries.filter(isAction).length >= SEARCHABLE_FROM;
    }

    /**
     * The rows a level shows.
     *
     * Filtering a menu is not filtering a list: a separator between two rows that both
     * disappeared is a rule with nothing on either side of it, and a caption over an empty
     * block is a caption for nothing. So the filter runs over the ACTIONS and the trim below
     * puts back only the furniture that still has rows around it.
     */
    function filtered(level: ContextMenuLevel): ContextMenuEntry[] {
        if (!level.searchable || !level.query.trim()) return [...level.entries];

        const actions = level.entries.filter(isAction);
        const matched = new Set(engineFor(level, actions).searchNow(level.query).map((match) => match.item));
        return trimFurniture(level.entries.filter((entry) => !isAction(entry) || matched.has(entry)));
    }

    function engineFor(level: ContextMenuLevel, actions: ContextMenuEntry[]): SearchInstance<ContextMenuEntry> {
        const id = keyOf(level.path);
        const held = engines.get(id);
        // By identity of the rows: a level whose entries were replaced needs a new index, and
        // a level being typed into hands over the same array every keystroke.
        if (held && held.items.length === actions.length && held.items.every((item, index) => item === actions[index])) return held.engine;
        held?.engine.destroy();
        const engine = createSearch<ContextMenuEntry>({
            items: actions,
            keys: opts.searchKeys ?? CONTEXT_MENU_SEARCH_KEYS,
            fuse: opts.fuse,
            fuseOptions: opts.fuseOptions,
            matcher: opts.matcher,
            // A menu filters as you type: the rows are in memory, and a delay is felt as the
            // panel lagging behind the field.
            debounce: 0,
            empty: "all"
        });
        engines.set(id, { items: actions, engine });
        return engine;
    }

    /**
     * Furniture only survives if it still divides something.
     *
     * A filter that leaves a separator between two rows that both disappeared draws a rule
     * with nothing on either side of it, and a caption over an emptied block introduces
     * nothing. So furniture is held back until a row arrives to justify it: at most one
     * separator and one caption per gap, the caption being the last one written, and a
     * separator only where there is something above it to separate from.
     */
    function trimFurniture(entries: ContextMenuEntry[]): ContextMenuEntry[] {
        const result: ContextMenuEntry[] = [];
        let separator: ContextMenuEntry | null = null;
        let caption: ContextMenuEntry | null = null;

        for (const entry of entries) {
            if (!isAction(entry)) {
                if (entry.type === "separator") separator = entry;
                else caption = entry;
                continue;
            }
            if (separator && result.length > 0) result.push(separator);
            if (caption) result.push(caption);
            separator = null;
            caption = null;
            result.push(entry);
        }
        // Whatever is still pending had no row after it, so it introduced nothing.
        return result;
    }

    /** Positive modulo: the walk goes backwards as often as forwards. */
    function wrap(index: number, length: number): number {
        return ((index % length) + length) % length;
    }

    /** The next row that can be highlighted, walking at most once around the level. */
    function enabledIndex(level: ContextMenuLevel, from: number, step: number): number {
        const length = level.visible.length;
        if (length === 0) return -1;
        for (let attempt = 0; attempt < length; attempt++) {
            const index = wrap(from + step * attempt, length);
            const entry = level.visible[index];
            if (entry && isAction(entry) && !entry.disabled) return index;
        }
        return -1;
    }

    function makeLevel(path: string[], item: ContextMenuAction | null, entries: readonly ContextMenuEntry[], loading = false, error: Error | null = null): ContextMenuLevel {
        const level: ContextMenuLevel = {
            path,
            title: (item ? item.title : opts.title) ?? null,
            entries: [...entries],
            visible: [],
            active: -1,
            query: "",
            searchable: searchableFor(item, entries),
            loading,
            error
        };
        level.visible = filtered(level);
        return level;
    }

    function snapshot(): ContextMenuState {
        return {
            open,
            point,
            // Copied one level deep: a subscriber that keeps a snapshot must not see the next
            // state mutate the one it is holding.
            levels: levels.map((level) => ({ ...level, path: [...level.path], entries: [...level.entries], visible: [...level.visible] }))
        };
    }

    function emit(): void {
        const state = snapshot();
        opts.onChange?.(state);
        for (const listener of listeners) listener(state);
    }

    function deepest(): ContextMenuLevel | undefined {
        return levels[levels.length - 1];
    }

    /** The action at a position, or null when it is furniture or out of range. */
    function actionAt(level: ContextMenuLevel | undefined, index: number): ContextMenuAction | null {
        const entry = level?.visible[index];
        return entry && isAction(entry) ? entry : null;
    }

    /** An `items: []` is not a submenu: the row keeps no arrow and opens no empty panel. */
    function hasSubmenu(item: ContextMenuAction): boolean {
        return Boolean(item.loadItems || (item.items && item.items.some(isAction)));
    }

    /** Whether a list holds anything the pointer or the keyboard could land on. */
    function hasActions(entries: readonly ContextMenuEntry[]): boolean {
        return entries.some(isAction);
    }

    /**
     * Open a submenu, from the cache when it has one.
     *
     * A fetched branch renders in three states and each is a real one: cached rows appear
     * immediately, a cold fetch shows the level as loading rather than as empty, and a
     * rejection says so rather than leaving a panel with nothing in it and no reason.
     */
    function pushSubmenu(parent: number, index: number, focus: boolean): void {
        const level = levels[parent];
        const item = actionAt(level, index);
        if (!item || item.disabled || !hasSubmenu(item)) return;

        const path = [...level.path, item.id];
        levels = levels.slice(0, parent + 1);
        level.active = index;
        // Remembered per path, because a fetched branch is highlighted when it ARRIVES rather
        // than when it was asked for, and by then nobody knows which opened it.
        if (focus) wantsFocus.add(keyOf(path));
        else wantsFocus.delete(keyOf(path));

        if (item.items) {
            levels.push(makeLevel(path, item, item.items));
            if (focus) focusFirst(levels.length - 1);
            emit();
            return;
        }

        const id = keyOf(path);
        const entry = cache.get(id);
        const fresh = entry?.entries && (cacheMs() <= 0 ? false : Date.now() - entry.at < cacheMs());
        if (fresh && entry?.entries) {
            levels.push(makeLevel(path, item, entry.entries));
            if (focus) focusFirst(levels.length - 1);
            emit();
            return;
        }

        levels.push(makeLevel(path, item, [], true));
        emit();

        // One request per path, shared: hovering in and out of a slow branch twice must not
        // ask twice, and the second open has to resolve from the same promise.
        const request = entry?.pending ?? Promise.resolve().then(() => item.loadItems!());
        cache.set(id, { at: entry?.at ?? Date.now(), entries: entry?.entries, pending: request });

        request.then(
            (entries) => {
                cache.set(id, { at: Date.now(), entries });
                settle(id, path, item, entries, null);
            },
            (reason: unknown) => {
                // Not cached: a failure that stuck would leave the branch broken until the
                // page reloads, and the retry is the next hover.
                cache.delete(id);
                settle(id, path, item, [], reason instanceof Error ? reason : new Error(String(reason)));
            }
        );
    }

    /** Put a resolved submenu on screen, but only if that branch is still the open one. */
    function settle(id: string, path: string[], item: ContextMenuAction, entries: readonly ContextMenuEntry[], error: Error | null): void {
        if (destroyed) return;
        const index = levels.findIndex((level) => keyOf(level.path) === id);
        // The pointer has moved on and this branch is closed. The cache above still holds the
        // rows, so the next open is instant - that is the point of answering late at all.
        if (index === -1) return;
        levels = levels.slice(0, index);
        levels.push(makeLevel(path, item, entries, false, error));
        // Only if the keyboard is what opened it. A branch the POINTER opened must arrive with
        // nothing highlighted, whenever it arrives.
        if (wantsFocus.has(id)) focusFirst(index);
        emit();
    }

    /**
     * Highlight the first row a submenu can land on.
     *
     * Only where the KEYBOARD opened it. Hovering a row that has a submenu highlights nothing
     * inside it, the way every desktop menu behaves: a row that looks hovered before the
     * pointer has reached it reads as the menu having chosen something on your behalf.
     */
    function focusFirst(index: number): void {
        const level = levels[index];
        if (!level) return;
        level.active = enabledIndex(level, 0, 1);
    }

    function refilter(level: ContextMenuLevel): void {
        const current = level.active >= 0 ? level.visible[level.active] : undefined;
        level.visible = filtered(level);
        const kept = current ? level.visible.indexOf(current) : -1;
        const entry = kept >= 0 ? level.visible[kept] : undefined;
        level.active = entry && isAction(entry) && !entry.disabled ? kept : enabledIndex(level, 0, 1);
    }

    return {
        get state() { return snapshot(); },

        open(next: ContextMenuPoint) {
            if (destroyed) return false;
            // Nothing to show, so nothing opens. Checked before anything else changes, so a
            // menu already on screen is not closed by a press that could not open one.
            if (!hasActions(root)) return false;
            const wasOpen = open;
            open = true;
            point = { x: next.x, y: next.y };
            // A fresh tree every open: a menu that comes back with a submenu still expanded
            // and a filter still typed is one you have to reset before using.
            levels = [makeLevel([], null, root)];
            typed = "";
            wantsFocus.clear();
            if (!wasOpen) opts.onOpenChange?.(true);
            emit();
            return true;
        },

        close() {
            if (destroyed || !open) return;
            open = false;
            point = null;
            levels = [];
            typed = "";
            wantsFocus.clear();
            opts.onOpenChange?.(false);
            emit();
        },

        move(key: ContextMenuMoveKey) {
            if (destroyed) return;
            const level = deepest();
            if (!level || level.visible.length === 0) return;
            const from = level.active < 0 ? -1 : level.active;
            switch (key) {
                // Wrapping, because a menu is a short list and the row after the last one is
                // the first: clamping leaves the arrow key doing nothing, which reads as a
                // frozen panel.
                case "ArrowDown": level.active = enabledIndex(level, from + 1, 1); break;
                // From the LAST row when nothing is highlighted, which is how a menu opened at
                // the pointer starts: `from - 1` there is the row before the last one.
                case "ArrowUp": level.active = enabledIndex(level, from < 0 ? level.visible.length - 1 : from - 1 + level.visible.length, -1); break;
                case "Home": level.active = enabledIndex(level, 0, 1); break;
                case "End": level.active = enabledIndex(level, level.visible.length - 1, -1); break;
                case "PageDown": level.active = enabledIndex(level, Math.min(level.visible.length - 1, from + PAGE), 1); break;
                case "PageUp": level.active = enabledIndex(level, Math.max(0, from - PAGE), -1); break;
            }
            emit();
        },

        setActive(levelIndex: number, index: number) {
            const level = levels[levelIndex];
            // The row already highlighted is not a change: this arrives from `pointermove`,
            // which fires on every pixel, and emitting there redraws the panel sixty times a
            // second.
            if (destroyed || !level || level.active === index) return;
            if (index < 0 || index >= level.visible.length) return;
            const item = actionAt(level, index);
            if (!item || item.disabled) return;
            level.active = index;
            // The deeper levels are left alone on purpose. Pointing at another row does
            // eventually close them, but only after the beat every desktop menu waits: the
            // way OUT of a submenu passes over its siblings, so closing on the first crossing
            // is what makes a nested menu impossible to reach diagonally. The renderer owns
            // that timing and calls closeBelow when it elapses.
            emit();
        },

        setQuery(levelIndex: number, query: string) {
            const level = levels[levelIndex];
            if (destroyed || !level) return;
            level.query = query;
            // Filtering a level invalidates everything under it: those rows came from a row
            // that may not be on screen any more.
            levels = levels.slice(0, levelIndex + 1);
            refilter(level);
            emit();
        },

        openSubmenu(levelIndex: number, index: number, focus = false) {
            if (destroyed) return;
            pushSubmenu(levelIndex, index, focus);
        },

        closeBelow(levelIndex: number) {
            if (destroyed || levels.length <= levelIndex + 1) return;
            levels = levels.slice(0, levelIndex + 1);
            emit();
        },

        select(levelIndex: number, index: number) {
            if (destroyed) return;
            const level = levels[levelIndex];
            const item = actionAt(level, index);
            // A disabled row is listed and announced, never invoked - including by a click
            // that got through, which is the one path a renderer tends to forget.
            if (!item || item.disabled) return;
            // Choosing a row that HAS a submenu opens it, and that press came from a pointer
            // or from Enter - either way the reader is now looking at it, so it gets a row.
            if (hasSubmenu(item)) { pushSubmenu(levelIndex, index, true); return; }

            const path = [...(level?.path ?? []), item.id];
            // Closed BEFORE the handler runs: the handler usually opens a dialog or moves
            // focus, and a menu still on screen underneath it steals the next Escape.
            open = false;
            point = null;
            levels = [];
            typed = "";
            wantsFocus.clear();
            opts.onOpenChange?.(false);
            emit();
            opts.onSelect?.(item, path);
        },

        selectActive() {
            const index = levels.length - 1;
            const level = levels[index];
            if (level && level.active >= 0) this.select(index, level.active);
        },

        enterSubmenu() {
            const index = levels.length - 1;
            const level = levels[index];
            if (!level || level.active < 0) return;
            const item = actionAt(level, level.active);
            if (item && hasSubmenu(item)) pushSubmenu(index, level.active, true);
        },

        leaveSubmenu() {
            if (destroyed || levels.length <= 1) return;
            levels = levels.slice(0, levels.length - 1);
            emit();
        },

        typeahead(character: string) {
            if (destroyed || character.length !== 1) return;
            const level = deepest();
            if (!level || level.visible.length === 0) return;

            const step = typeaheadStep({ typed, at: typedAt }, character);
            typed = step.typed;
            typedAt = step.at;

            const needle = fold(step.needle);
            // A cycling press searches from the row AFTER this one, so pressing the letter
            // again walks through everything starting with it; a word searches from the
            // current row, so refining it does not jump off what it already found. With
            // nothing highlighted yet - which is how a menu opens at the pointer - the walk
            // starts AT the first row instead, or the first letter would skip it.
            const from = step.cycle && level.active >= 0 ? 1 : 0;
            for (let step = from; step < level.visible.length + from; step++) {
                const index = wrap(Math.max(level.active, 0) + step, level.visible.length);
                const entry = level.visible[index];
                if (!entry || !isAction(entry) || entry.disabled) continue;
                if (fold(entry.label).startsWith(needle)) {
                    level.active = index;
                    emit();
                    return;
                }
            }
        },

        invalidate(path?: string[]) {
            if (!path) { cache.clear(); return; }
            cache.delete(keyOf(path));
        },

        update(next: Partial<ContextMenuOptions>) {
            if (destroyed) return;
            const hadItems = next.items !== undefined;
            opts = { ...opts, ...next };
            if (hadItems) {
                root = next.items ?? [];
                // Only the root is rebuilt: a submenu's rows came from an item in the tree,
                // and rebuilding the open branch under the pointer would move it.
                const level = levels[0];
                if (level) {
                    level.entries = [...root];
                    level.title = opts.title ?? null;
                    level.searchable = searchableFor(null, root);
                    refilter(level);
                    emit();
                }
            }
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },

        destroy() {
            destroyed = true;
            listeners.clear();
            cache.clear();
            wantsFocus.clear();
            for (const held of engines.values()) held.engine.destroy();
            engines.clear();
        }
    };
}
