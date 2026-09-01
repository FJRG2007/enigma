/**
 * The parts of a selectable list that are not rendering: what is selected, where the cursor
 * is, which row the next Shift+click measures from, and which command a key press stands for.
 *
 * This is the file-manager selection model, on purpose and in full: a plain click replaces
 * the selection, Ctrl toggles one row without losing the rest, Shift takes everything between
 * the anchor and here, Ctrl+Shift adds that range to what was already there, Ctrl+A takes the
 * lot and Escape drops it. Every one of those is a rule people already know from Explorer,
 * Finder and every list built on them, and every one of them is a bug when a list re-invents
 * it - a Shift+click that measures from the last CLICK instead of the anchor, a Ctrl+click
 * that clears the selection, an Escape that does nothing.
 *
 * The commands are DATA. Each one has a default binding, any of them can be rebound, removed
 * one at a time or turned off altogether, and a binding that is not a built-in command is
 * still matched and reported - so a list can add "star" on Mod+D without this file knowing
 * what starring is.
 */

import { matchesShortcut, shortcutList, type ShortcutEvent, type ShortcutSpec } from "@/core/keys";

/**
 * What a key press means.
 *
 * The first group the list PERFORMS - it owns the selection, so it moves it. The second it
 * only REPORTS, because deleting, renaming and opening are the caller's. Both are reported,
 * and both can be stopped by the handler, so a list that wants to confirm a delete or animate
 * its own select-all can.
 */
export type SelectionCommand =
    | "selectAll"
    | "clear"
    | "invert"
    | "moveUp" | "moveDown" | "moveLeft" | "moveRight"
    | "moveHome" | "moveEnd" | "movePageUp" | "movePageDown"
    | "extendUp" | "extendDown" | "extendLeft" | "extendRight"
    | "extendHome" | "extendEnd" | "extendPageUp" | "extendPageDown"
    | "cursorUp" | "cursorDown"
    | "toggleCursor"
    | "open"
    | "rename"
    | "delete"
    | "deletePermanent"
    | "copy"
    | "cut"
    | "paste";

/** A command name: one of the built-ins, or anything else the caller binds. */
export type SelectionCommandName = SelectionCommand | (string & {});

/**
 * What each command is bound to out of the box.
 *
 * `Mod` is Command on an Apple keyboard and Control everywhere else, which is what these
 * shortcuts mean on both. `invert` ships unbound deliberately: Explorer has the action and no
 * key for it, and inventing one would take a combination the page may already use.
 */
export const DEFAULT_SELECTION_SHORTCUTS: Readonly<Record<SelectionCommand, ShortcutSpec>> = {
    selectAll: "Mod+A",
    clear: "Escape",
    invert: false,

    moveUp: "ArrowUp",
    moveDown: "ArrowDown",
    moveLeft: "ArrowLeft",
    moveRight: "ArrowRight",
    moveHome: "Home",
    moveEnd: "End",
    movePageUp: "PageUp",
    movePageDown: "PageDown",

    extendUp: "Shift+ArrowUp",
    extendDown: "Shift+ArrowDown",
    extendLeft: "Shift+ArrowLeft",
    extendRight: "Shift+ArrowRight",
    extendHome: "Shift+Home",
    extendEnd: "Shift+End",
    extendPageUp: "Shift+PageUp",
    extendPageDown: "Shift+PageDown",

    // The cursor moving WITHOUT the selection following, which is how a file manager lets you
    // reach a distant row and add it with Ctrl+Space rather than starting again.
    cursorUp: "Mod+ArrowUp",
    cursorDown: "Mod+ArrowDown",
    toggleCursor: "Mod+Space",

    open: "Enter",
    rename: "F2",
    delete: "Delete",
    deletePermanent: "Shift+Delete",
    copy: "Mod+C",
    cut: "Mod+X",
    paste: "Mod+V"
};

/**
 * The bindings, as the caller writes them.
 *
 * A missing entry keeps the default, `false` removes that one command, and a string or a list
 * replaces it. `shortcuts: false` on the options removes every one of them at once - for a
 * list inside an editor, or one whose keyboard belongs to something else.
 */
export type SelectionShortcuts = Partial<Record<SelectionCommandName, ShortcutSpec>>;

/** The modifiers a click carried. A real MouseEvent or PointerEvent satisfies it. */
export interface SelectionClickModifiers {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
}

export interface SelectionCommandEvent<Item> {
    command: SelectionCommandName;
    /**
     * What the command applies to: everything selected, or the row under the cursor when
     * nothing is. That fallback is the file-manager rule - pressing Delete with one row
     * focused and none selected deletes that row.
     */
    items: Item[];
    ids: string[];
    /** The row the cursor is on, selected or not. */
    cursor: Item | null;
    cursorIndex: number;
    /** The press that matched, for a handler that needs the modifiers back. */
    event: ShortcutEvent;
    /** Stop what the list would have done - the moves, select-all, clear, invert. */
    preventDefault(): void;
    defaultPrevented: boolean;
}

export interface SelectionOptions<Item> {
    items?: readonly Item[];
    /** How a row is identified across reorders and reloads. Default: its index, as a string. */
    getId?: (item: Item, index: number) => string;
    /** A row that cannot be selected or landed on. Still rendered, still counted. */
    disabled?: (item: Item, index: number) => boolean;
    /** One row at a time: Ctrl and Shift stop meaning anything. Default: many. */
    multiple?: boolean;
    /** Columns in a grid, so Left and Right move by one and Up and Down by a row. Default 1. */
    columns?: number;
    /** How far PageUp and PageDown jump. Default 10. */
    page?: number;
    /** Rebind, remove or extend the commands. `false` removes every binding. */
    shortcuts?: SelectionShortcuts | false;
    /** A command matched a press. Fired for built-ins too, before the list acts on them. */
    onCommand?: (event: SelectionCommandEvent<Item>) => void;
    /** Every state change. */
    onChange?: (state: SelectionState<Item>) => void;
    /** Only the selection, when it actually changed. */
    onSelectionChange?: (ids: string[], items: Item[]) => void;
}

export interface SelectionState<Item> {
    /** Selected ids, in the order the rows appear - not the order they were clicked. */
    selected: string[];
    /** The same ids, for a renderer that asks per row. */
    selectedSet: ReadonlySet<string>;
    /** The selected rows themselves. */
    items: Item[];
    /** Where the keyboard is. -1 when the list has not been touched. */
    cursor: number;
    /** Where the next Shift+click or Shift+arrow measures from. */
    anchor: number;
    count: number;
    /** Every selectable row is selected. What a header checkbox reads. */
    allSelected: boolean;
    /** Some but not all - the third state of that same checkbox. */
    partiallySelected: boolean;
    /** A rubber band is being dragged. */
    marquee: boolean;
}

export interface SelectionInstance<Item> {
    readonly state: SelectionState<Item>;
    /** A click on a row, with its modifiers. The whole Explorer rule, in one call. */
    click(index: number, modifiers?: SelectionClickModifiers): void;
    /** A key press. Returns whether a command matched, so the caller knows to prevent it. */
    keyDown(event: ShortcutEvent): boolean;
    select(ids: readonly string[]): void;
    selectIndex(index: number, additive?: boolean): void;
    toggle(index: number): void;
    /** Everything from the anchor to here. `additive` keeps what was already selected. */
    selectRange(index: number, additive?: boolean): void;
    selectAll(): void;
    clear(): void;
    invert(): void;
    /** Move the cursor. `extend` takes everything from the anchor, `carry` leaves the selection alone. */
    moveCursor(delta: number, extend?: boolean, carry?: boolean): void;
    setCursor(index: number): void;
    /**
     * What an action on this row applies to: the selection when the row is part of it, and the
     * row alone when it is not. The rule every file manager's context menu follows - and the
     * one that makes right-clicking outside a selection act on what was clicked.
     */
    targets(index: number): Item[];
    /** Start a rubber band. `additive` keeps the current selection as its base. */
    beginMarquee(additive?: boolean): void;
    /** The rows the band currently covers. */
    marqueeTo(indices: readonly number[]): void;
    endMarquee(): void;
    /** The resolved bindings, so a menu can print the same shortcut the list listens for. */
    bindings(): Record<string, ShortcutSpec>;
    /** What one command is bound to, or false when it has no binding. */
    binding(command: SelectionCommandName): ShortcutSpec;
    update(options: Partial<SelectionOptions<Item>>): void;
    subscribe(listener: (state: SelectionState<Item>) => void): () => void;
    destroy(): void;
}

/** Which commands the list performs itself. Everything else is only reported. */
const OWNED = new Set<string>([
    "selectAll", "clear", "invert",
    "moveUp", "moveDown", "moveLeft", "moveRight", "moveHome", "moveEnd", "movePageUp", "movePageDown",
    "extendUp", "extendDown", "extendLeft", "extendRight", "extendHome", "extendEnd", "extendPageUp", "extendPageDown",
    "cursorUp", "cursorDown", "toggleCursor"
]);

export function createSelection<Item>(options: SelectionOptions<Item> = {}): SelectionInstance<Item> {
    let opts: SelectionOptions<Item> = { ...options };
    let items: readonly Item[] = opts.items ?? [];
    let selected = new Set<string>();
    let cursor = -1;
    let anchor = -1;
    /** What a Shift+Ctrl range is added to, captured when that run starts. */
    let rangeBase: Set<string> | null = null;
    /** What a rubber band is added to, captured when the drag starts. */
    let marqueeBase: Set<string> | null = null;
    let destroyed = false;
    const listeners = new Set<(state: SelectionState<Item>) => void>();

    function idOf(index: number): string | null {
        const item = items[index];
        if (item === undefined) return null;
        return opts.getId ? opts.getId(item, index) : String(index);
    }

    function selectable(index: number): boolean {
        const item = items[index];
        if (item === undefined) return false;
        return !opts.disabled?.(item, index);
    }

    function multiple(): boolean {
        return opts.multiple ?? true;
    }

    function columns(): number {
        return Math.max(1, opts.columns ?? 1);
    }

    /** Ids in LIST order, so the selection reads the way the rows do rather than in click order. */
    function orderedIds(): string[] {
        const ids: string[] = [];
        for (let index = 0; index < items.length; index++) {
            const id = idOf(index);
            if (id !== null && selected.has(id)) ids.push(id);
        }
        return ids;
    }

    function selectedItems(): Item[] {
        const chosen: Item[] = [];
        for (let index = 0; index < items.length; index++) {
            const id = idOf(index);
            if (id !== null && selected.has(id)) chosen.push(items[index] as Item);
        }
        return chosen;
    }

    function snapshot(): SelectionState<Item> {
        const ids = orderedIds();
        let count = 0;
        for (let index = 0; index < items.length; index++) if (selectable(index)) count++;
        return {
            selected: ids,
            selectedSet: new Set(ids),
            items: selectedItems(),
            cursor,
            anchor,
            count: ids.length,
            allSelected: count > 0 && ids.length === count,
            partiallySelected: ids.length > 0 && ids.length < count,
            marquee: marqueeBase !== null
        };
    }

    /**
     * Everything a subscriber can observe that does NOT depend on the identity of the rows.
     *
     * `update` emits on a change to this rather than on every call: the items come from a
     * render, so `items={rows.map(...)}` hands over a new array of new objects each time and
     * emitting on that alone would render, rebuild the array and emit again.
     */
    function summary(): string {
        let count = 0;
        for (let index = 0; index < items.length; index++) if (selectable(index)) count++;
        return `${cursor}:${anchor}:${count}:${orderedIds().join("\u0000")}`;
    }

    /** The last reported selection, so a change that changed nothing reports nothing. */
    let reported: string[] = [];

    function emit(): void {
        const state = snapshot();
        opts.onChange?.(state);
        for (const listener of listeners) listener(state);
        const ids = state.selected;
        if (ids.length !== reported.length || ids.some((id, index) => id !== reported[index])) {
            reported = ids;
            opts.onSelectionChange?.(ids, state.items);
        }
    }

    function replace(ids: Iterable<string>): void {
        selected = new Set(ids);
    }

    /** The next selectable row from `from`, walking `step` at a time. Clamped, never wrapped. */
    function nextEnabled(from: number, step: number): number {
        // Clamped and not wrapped, unlike a menu: a list is long, and an arrow key that jumps
        // from the last row to the first loses the reader's place entirely.
        for (let index = from; index >= 0 && index < items.length; index += step) {
            if (selectable(index)) return index;
        }
        return -1;
    }

    function rangeIds(from: number, to: number): string[] {
        const [low, high] = from < to ? [from, to] : [to, from];
        const ids: string[] = [];
        for (let index = low; index <= high; index++) {
            if (!selectable(index)) continue;
            const id = idOf(index);
            if (id !== null) ids.push(id);
        }
        return ids;
    }

    function applyRange(index: number, additive: boolean): void {
        const from = anchor >= 0 ? anchor : index;
        const ids = rangeIds(from, index);
        if (additive) {
            // The base is captured once per Shift+Ctrl RUN, so dragging the shift-click
            // around grows and shrinks one range instead of leaving a trail of them.
            rangeBase = rangeBase ?? new Set(selected);
            replace([...rangeBase, ...ids]);
        } else {
            rangeBase = null;
            replace(ids);
        }
        cursor = index;
    }

    /** The bindings in force: the defaults, with the caller's entries applied over them. */
    function table(): Record<string, ShortcutSpec> {
        if (opts.shortcuts === false) return {};
        return { ...DEFAULT_SELECTION_SHORTCUTS, ...(opts.shortcuts ?? {}) };
    }

    function commandFor(event: ShortcutEvent): SelectionCommandName | null {
        const bindings = table();
        let match: { command: string; length: number; } | null = null;
        for (const [command, spec] of Object.entries(bindings)) {
            if (spec === false || spec == null) continue;
            // The most SPECIFIC binding wins, counting the modifiers of the alternative that
            // actually matched - `delete: ["Delete", "Mod+Backspace"]` is a plain Delete when
            // that is the one the press hit, whatever the other alternative asks for.
            const hit = shortcutList(spec).find((shortcut) => matchesShortcut(event, shortcut));
            if (!hit) continue;
            const length = specificity(hit);
            if (!match || length > match.length) match = { command, length };
        }
        return match?.command ?? null;
    }

    function specificity(shortcut: { mod?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; }): number {
        return Number(Boolean(shortcut.mod)) + Number(Boolean(shortcut.ctrl)) + Number(Boolean(shortcut.meta))
            + Number(Boolean(shortcut.shift)) + Number(Boolean(shortcut.alt));
    }

    function perform(command: SelectionCommandName): boolean {
        const step = columns();
        const page = Math.max(1, opts.page ?? 10);
        switch (command) {
            case "selectAll": instance.selectAll(); return true;
            case "clear": instance.clear(); return true;
            case "invert": instance.invert(); return true;
            case "moveUp": instance.moveCursor(-step); return true;
            case "moveDown": instance.moveCursor(step); return true;
            case "moveLeft": instance.moveCursor(-1); return true;
            case "moveRight": instance.moveCursor(1); return true;
            case "moveHome": instance.moveCursor(-items.length); return true;
            case "moveEnd": instance.moveCursor(items.length); return true;
            case "movePageUp": instance.moveCursor(-page * step); return true;
            case "movePageDown": instance.moveCursor(page * step); return true;
            case "extendUp": instance.moveCursor(-step, true); return true;
            case "extendDown": instance.moveCursor(step, true); return true;
            case "extendLeft": instance.moveCursor(-1, true); return true;
            case "extendRight": instance.moveCursor(1, true); return true;
            case "extendHome": instance.moveCursor(-items.length, true); return true;
            case "extendEnd": instance.moveCursor(items.length, true); return true;
            case "extendPageUp": instance.moveCursor(-page * step, true); return true;
            case "extendPageDown": instance.moveCursor(page * step, true); return true;
            case "cursorUp": instance.moveCursor(-step, false, true); return true;
            case "cursorDown": instance.moveCursor(step, false, true); return true;
            case "toggleCursor": if (cursor >= 0) instance.toggle(cursor); return true;
            default: return false;
        }
    }

    const instance: SelectionInstance<Item> = {
        get state() { return snapshot(); },

        click(index, modifiers = {}) {
            if (destroyed || !selectable(index)) return;
            const mod = Boolean(modifiers.ctrlKey || modifiers.metaKey);
            const shift = Boolean(modifiers.shiftKey) && multiple();

            if (shift) {
                applyRange(index, mod && multiple());
                emit();
                return;
            }
            rangeBase = null;
            if (mod && multiple()) {
                // Ctrl re-anchors: the next Shift+click measures from the row you just added,
                // which is what makes "one here, then a run from there" work.
                this.toggle(index);
                return;
            }
            const id = idOf(index);
            if (id === null) return;
            replace([id]);
            cursor = index;
            anchor = index;
            emit();
        },

        keyDown(event) {
            if (destroyed) return false;
            const command = commandFor(event);
            if (!command) return false;

            const targets = selected.size > 0 ? selectedItems() : (cursor >= 0 && items[cursor] !== undefined ? [items[cursor] as Item] : []);
            const ids = selected.size > 0 ? orderedIds() : (cursor >= 0 ? [idOf(cursor)].filter((id): id is string => id !== null) : []);
            let prevented = false;
            const report: SelectionCommandEvent<Item> = {
                command,
                items: targets,
                ids,
                cursor: cursor >= 0 ? (items[cursor] ?? null) : null,
                cursorIndex: cursor,
                event,
                preventDefault() { prevented = true; report.defaultPrevented = true; },
                defaultPrevented: false
            };
            opts.onCommand?.(report);

            if (!prevented) perform(command);
            // Handled when the list acted on it, or when there was a handler listening for it:
            // the browser's own meaning has to go (Ctrl+A selects the page, F2 does nothing,
            // Backspace navigates back) exactly where something took the press instead. A list
            // with no `onCommand` reports `copy` and does nothing with it, and swallowing
            // Ctrl+C there would leave the text inside its rows uncopyable.
            return OWNED.has(command) || opts.onCommand !== undefined;
        },

        select(ids) {
            if (destroyed) return;
            replace(ids);
            emit();
        },

        selectIndex(index, additive = false) {
            if (destroyed || !selectable(index)) return;
            const id = idOf(index);
            if (id === null) return;
            if (additive && multiple()) selected.add(id);
            else replace([id]);
            cursor = index;
            anchor = index;
            emit();
        },

        toggle(index) {
            if (destroyed || !selectable(index)) return;
            const id = idOf(index);
            if (id === null) return;
            if (!multiple()) { replace([id]); }
            else if (selected.has(id)) selected.delete(id);
            else selected.add(id);
            cursor = index;
            anchor = index;
            emit();
        },

        selectRange(index, additive = false) {
            if (destroyed || !selectable(index) || !multiple()) return;
            applyRange(index, additive);
            emit();
        },

        selectAll() {
            if (destroyed || !multiple()) return;
            const ids: string[] = [];
            for (let index = 0; index < items.length; index++) {
                if (!selectable(index)) continue;
                const id = idOf(index);
                if (id !== null) ids.push(id);
            }
            replace(ids);
            emit();
        },

        clear() {
            if (destroyed || selected.size === 0) return;
            selected = new Set();
            rangeBase = null;
            emit();
        },

        invert() {
            if (destroyed || !multiple()) return;
            const next = new Set<string>();
            for (let index = 0; index < items.length; index++) {
                if (!selectable(index)) continue;
                const id = idOf(index);
                if (id !== null && !selected.has(id)) next.add(id);
            }
            selected = next;
            emit();
        },

        moveCursor(delta, extend = false, carry = false) {
            if (destroyed || items.length === 0) return;
            const from = cursor >= 0 ? cursor : anchor >= 0 ? anchor : delta > 0 ? -1 : items.length;
            const wanted = Math.max(0, Math.min(items.length - 1, from + delta));
            // Past a disabled row rather than onto it, then back the other way when the end of
            // the list is disabled - otherwise the cursor sticks one row short of the bottom.
            const forward = delta >= 0 ? 1 : -1;
            const ahead = nextEnabled(wanted, forward);
            const next = ahead >= 0 ? ahead : nextEnabled(wanted, -forward);
            if (next < 0) return;

            if (extend && multiple()) {
                applyRange(next, false);
                emit();
                return;
            }
            cursor = next;
            if (carry) {
                // The cursor alone: the selection stays where it was, which is what Ctrl+arrow
                // is for - reaching a distant row to add it without starting again.
                emit();
                return;
            }
            const id = idOf(next);
            if (id === null) return;
            replace([id]);
            anchor = next;
            rangeBase = null;
            emit();
        },

        setCursor(index) {
            if (destroyed || index === cursor) return;
            if (index < -1 || index >= items.length) return;
            cursor = index;
            emit();
        },

        targets(index) {
            const id = idOf(index);
            const item = items[index];
            if (item === undefined) return selectedItems();
            return id !== null && selected.has(id) ? selectedItems() : [item];
        },

        beginMarquee(additive = false) {
            if (destroyed || !multiple()) return;
            marqueeBase = additive ? new Set(selected) : new Set();
            if (!additive && selected.size > 0) selected = new Set();
            emit();
        },

        marqueeTo(indices) {
            if (destroyed || marqueeBase === null) return;
            const next = new Set(marqueeBase);
            for (const index of indices) {
                if (!selectable(index)) continue;
                const id = idOf(index);
                if (id !== null) next.add(id);
            }
            // Compared before it is applied: a drag fires on every pixel, and emitting a set
            // equal to the one on screen re-renders every row of the list sixty times a second.
            if (next.size === selected.size && [...next].every((id) => selected.has(id))) return;
            selected = next;
            emit();
        },

        endMarquee() {
            if (destroyed || marqueeBase === null) return;
            marqueeBase = null;
            emit();
        },

        bindings() { return table(); },

        binding(command) { return table()[command] ?? false; },

        update(next) {
            if (destroyed) return;
            const before = summary();
            const hadItems = next.items !== undefined;
            opts = { ...opts, ...next };
            if (hadItems) {
                items = next.items ?? [];
                // Ids that are no longer in the list are dropped rather than kept: a selection
                // holding rows that were deleted or filtered away reports a count nobody can
                // see, and hands a delete the ids of things that are already gone.
                const live = new Set<string>();
                for (let index = 0; index < items.length; index++) {
                    const id = idOf(index);
                    if (id !== null) live.add(id);
                }
                for (const id of selected) if (!live.has(id)) selected.delete(id);
                if (cursor >= items.length) cursor = items.length - 1;
                if (anchor >= items.length) anchor = items.length - 1;
            }
            // Rows arriving or leaving is a state change even when the selection is untouched:
            // `count`, `allSelected` and `partiallySelected` are all measured against the list,
            // so a header checkbox left on the old snapshot keeps reading "all" over a list
            // that just grew.
            if (summary() !== before) emit();
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },

        destroy() {
            destroyed = true;
            listeners.clear();
        }
    };

    return instance;
}
