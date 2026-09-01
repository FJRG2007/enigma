"use client";

import { Slot } from "@/react/slot";
import { createPortal } from "react-dom";
import { PaletteContext, usePaletteContext, type PaletteRow } from "@/react/palette/context";
import { createSearch, subsequenceMatcher, shortenQuery, type SearchInstance, type SearchMatch, type SearchOptions } from "@/core/search";
import { createRecentStore, groupRows, moveActive, shortcutLabel, isPaletteShortcut, type RecentEntry, type PaletteKey } from "@/core/palette";
import {
    useCallback, useEffect, useId, useMemo, useRef, useState,
    type ComponentPropsWithoutRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode
} from "react";

/**
 * The command palette: the panel that opens on Ctrl/Cmd+K, searches as you type, remembers
 * what was searched before, and is driven entirely from the keyboard.
 *
 * It is a DIALOG, which is why it is its own component rather than a prop on `<Input>`: a
 * palette is a trigger, an overlay, a focus trap, a listbox and a footer, and the thing that
 * makes those usable together is composition. Radix draws the line in the same place, and
 * for the same reason - one `<input>` is a component, a widget made of parts is an anatomy:
 *
 * ```tsx
 * <SearchPalette.Root items={docs} keys={["title"]} onSelect={open}>
 *     <SearchPalette.Trigger />
 *     <SearchPalette.Content>
 *         <SearchPalette.Field placeholder="Search the docs" />
 *         <SearchPalette.List />
 *         <SearchPalette.Footer />
 *     </SearchPalette.Content>
 * </SearchPalette.Root>
 * ```
 *
 * `<SearchPalette>` on its own renders exactly that, for the case that needs no arguing
 * with. Every part takes `asChild`, so any of them can be your own element instead.
 *
 * The keyboard sequence is ONE flat list across every group - a group boundary is invisible
 * to the arrow keys - and the highlight wraps, because in a short list the row after the
 * last one is the first, and a key that does nothing at the end reads as a frozen panel.
 */

export interface PaletteSection<Item> {
    label: string;
    items: Item[];
    /** Shown whatever the query, e.g. a list of commands. Off by default. */
    always?: boolean;
}

export interface PaletteRootProps<Item> {
    /** What to search. */
    items?: Item[];
    /** Fields to read. Dotted paths work. */
    keys?: SearchOptions<Item>["keys"];
    /** Fuse.js's constructor, for fuzzy matching. Without it, a substring matcher runs. */
    fuse?: SearchOptions<Item>["fuse"];
    fuseOptions?: SearchOptions<Item>["fuseOptions"];
    /** Replaces the engine outright. */
    matcher?: SearchOptions<Item>["matcher"];
    /** ms after the last keystroke. Default 120: a palette should feel immediate. */
    delay?: number;
    limit?: number;
    /** Which group a result belongs under. One group when this is left out. */
    groupBy?: (item: Item) => string;
    /** The row's text. Falls back to the first string field. */
    labelOf?: (item: Item) => string;
    descriptionOf?: (item: Item) => string | undefined;
    /** Rows the app always offers - commands, shortcuts, "create new". */
    sections?: PaletteSection<Item>[];
    /** What running a row does. Closing afterwards is the default; return false to stay. */
    onSelect?: (item: Item) => void | boolean;
    /** Remember what was searched, in this browser. On by default. */
    recents?: boolean;
    recentsKey?: string;
    recentsLimit?: number;
    /** The key that opens it, with Ctrl or Cmd. `null` binds nothing. Default "k". */
    shortcut?: string | null;
    /** Controlled open state. Leave both out for an uncontrolled palette. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    /** Wording for the empty group heading of ungrouped results. Default "Results". */
    resultsLabel?: string;
    recentsLabel?: string;
    children?: ReactNode;
}

const RECENTS_SHOWN = 5;

function firstString(item: unknown): string {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
        for (const value of Object.values(item as Record<string, unknown>)) {
            if (typeof value === "string" && value.trim()) return value;
        }
    }
    return "";
}

export function PaletteRoot<Item>({
    items,
    keys,
    fuse,
    fuseOptions,
    matcher,
    delay = 120,
    limit = 40,
    groupBy,
    labelOf = firstString,
    descriptionOf,
    sections = [],
    onSelect,
    recents = true,
    recentsKey,
    recentsLimit = 8,
    shortcut = "k",
    open: openProp,
    onOpenChange,
    defaultOpen = false,
    resultsLabel = "Results",
    recentsLabel = "Recent",
    children
}: PaletteRootProps<Item>): ReactNode {
    const [ownOpen, setOwnOpen] = useState(defaultOpen);
    const controlled = openProp !== undefined;
    const open = controlled ? openProp : ownOpen;

    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [results, setResults] = useState<SearchMatch<Item>[]>([]);
    const [remembered, setRemembered] = useState<RecentEntry[]>([]);
    const [busy, setBusy] = useState(false);

    const triggerRef = useRef<HTMLElement | null>(null);
    const fieldRef = useRef<HTMLInputElement | null>(null);
    const base = useId();
    const ids = useMemo(() => ({ field: `${base}-field`, list: `${base}-list`, title: `${base}-title` }), [base]);

    const store = useMemo(
        () => createRecentStore({ key: recentsKey, limit: recentsLimit }),
        [recentsKey, recentsLimit]
    );

    const setOpen = useCallback((next: boolean) => {
        if (!controlled) setOwnOpen(next);
        onOpenChange?.(next);
    }, [controlled, onOpenChange]);

    /* -------- the engine -------- */

    /**
     * A palette ranks by SUBSEQUENCE unless told otherwise: "qgate" has to find "Quality
     * gate" and "plyg" has to find "Playground", which a substring filter cannot do. A plain
     * search field keeps the substring matcher, where a typo should fail rather than quietly
     * match something four words away.
     *
     * Computed ONCE and used by both the constructor and the update below. Passing the raw
     * prop to `update` instead is how the first version lost it: the effect overwrote the
     * default with `undefined` on the very next render, and the palette silently went back
     * to substring matching.
     */
    const ranking = useMemo(
        () => matcher ?? (fuse ? undefined : subsequenceMatcher<Item>(keys ?? [])),
        [matcher, fuse, keys]
    );

    const engine = useMemo<SearchInstance<Item>>(() => createSearch<Item>({
        items,
        keys,
        fuse,
        fuseOptions,
        matcher: ranking,
        debounce: delay,
        limit,
        onResults: (next) => {
            setResults(next);
            setBusy(false);
        }
        // Built once: the engine indexes on construction, so rebuilding it per render would
        // re-index the whole corpus on every keystroke.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    useEffect(() => () => engine.destroy(), [engine]);
    useEffect(() => { engine.setItems(items ?? []); }, [engine, items]);
    useEffect(() => { engine.update({ keys, fuse, fuseOptions, matcher: ranking, debounce: delay, limit }); }, [engine, keys, fuse, fuseOptions, ranking, delay, limit]);

    /* -------- opening and closing -------- */

    // Read on OPEN rather than on mount: storage is shared with every other tab, and a
    // palette that read it once would show a list that is already out of date.
    //
    // Opening also CLEARS the query. A palette that comes back holding the last search is
    // a palette you have to empty before you can use it, and it hides the one thing an
    // empty query is for - what was searched before, which is the shortcut on the second
    // visit. The engine is cleared with it, or the old results would outlive their query.
    useEffect(() => {
        if (!open) return;
        setRemembered(recents ? store.list() : []);
        setQuery("");
        engine.searchNow("");
        setActive(0);
    }, [open, recents, store, engine]);

    useEffect(() => {
        if (shortcut === null || typeof window === "undefined") return;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (!isPaletteShortcut(event, shortcut)) return;
            // Taken from the browser deliberately: Ctrl+K is a browser shortcut in some
            // builds, and a palette that only sometimes opens is worse than one that never
            // does. The page has the focus, so this is the page's key.
            event.preventDefault();
            setOpen(!open);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [shortcut, open, setOpen]);

    /* -------- rows -------- */

    const rows = useMemo<PaletteRow<Item>[]>(() => {
        const trimmed = query.trim();
        const out: PaletteRow<Item>[] = [];

        if (!trimmed && recents && remembered.length) {
            remembered.slice(0, RECENTS_SHOWN).forEach((entry, index) => {
                out.push({
                    id: `recent-${index}`,
                    kind: "recent",
                    group: recentsLabel,
                    recent: entry,
                    label: entry.label ?? entry.term
                });
            });
        }

        for (const section of sections) {
            const pool = section.always || !trimmed
                ? section.items
                : section.items.filter((item) => labelOf(item).toLowerCase().includes(trimmed.toLowerCase()));
            pool.forEach((item, index) => {
                out.push({
                    id: `section-${section.label}-${index}`,
                    kind: "action",
                    group: section.label,
                    item,
                    label: labelOf(item),
                    description: descriptionOf?.(item)
                });
            });
        }

        results.forEach((match, index) => {
            out.push({
                id: `result-${index}`,
                kind: "item",
                group: groupBy?.(match.item) ?? resultsLabel,
                item: match.item,
                match,
                label: labelOf(match.item),
                description: descriptionOf?.(match.item)
            });
        });

        return out;
    }, [query, recents, remembered, recentsLabel, sections, results, groupBy, labelOf, descriptionOf, resultsLabel]);

    // A shorter list must never leave the highlight past its end, or Enter opens nothing.
    useEffect(() => {
        setActive((current) => (current < rows.length ? current : 0));
    }, [rows.length]);

    const select = useCallback((row: PaletteRow<Item> | undefined) => {
        if (!row) return;

        if (row.kind === "recent" && row.recent) {
            // A remembered query goes back in the field and runs again; a remembered RESULT
            // is opened. The difference is whether it had somewhere to go.
            if (!row.recent.href) {
                setQuery(row.recent.term);
                setBusy(true);
                engine.search(row.recent.term);
                fieldRef.current?.focus();
                return;
            }
        }

        const stay = row.onSelect ? row.onSelect() : row.item !== undefined ? onSelect?.(row.item) : undefined;
        if (recents) {
            setRemembered(store.remember({
                term: query.trim(),
                label: row.label,
                scope: row.group
            }));
        }
        if (stay !== false) setOpen(false);
    }, [engine, onSelect, query, recents, setOpen, store]);

    const handleQuery = useCallback((next: string) => {
        setQuery(next);
        setActive(0);
        setBusy(Boolean(next.trim()));
        engine.search(next);
    }, [engine]);

    const value = useMemo(() => ({
        open,
        setOpen,
        query,
        setQuery: handleQuery,
        rows,
        active,
        setActive,
        select,
        clearRecents: () => { store.clear(); setRemembered([]); },
        forgetRecent: (entry: RecentEntry) => setRemembered(store.forget(entry)),
        busy,
        ids,
        shortcutLabel: shortcutLabel(shortcut ?? "k"),
        triggerRef,
        fieldRef,
        rowId: (row: PaletteRow<Item>) => `${ids.list}-${row.id}`
    }), [open, setOpen, query, handleQuery, rows, active, select, busy, ids, shortcut, store]);

    return <PaletteContext.Provider value={value as never}>{children}</PaletteContext.Provider>;
}

/* ------------------------------------------------------------------ parts */

export interface PaletteTriggerProps extends ComponentPropsWithoutRef<"button"> {
    asChild?: boolean;
}

/** Opens the palette. Carries the shortcut in `aria-keyshortcuts`, so it is announced. */
export function PaletteTrigger({ asChild = false, children, onClick, ...props }: PaletteTriggerProps): ReactNode {
    const palette = usePaletteContext("SearchPalette.Trigger");
    const Tag = asChild ? Slot : "button";
    return (
        <Tag
            {...(asChild ? {} : { type: "button" as const })}
            {...props}
            ref={palette.triggerRef as never}
            data-enigma-palette-trigger=""
            aria-haspopup="dialog"
            aria-expanded={palette.open}
            aria-keyshortcuts="Control+K Meta+K"
            onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                onClick?.(event);
                if (!event.defaultPrevented) palette.setOpen(true);
            }}
        >
            {children ?? (
                <>
                    <span data-enigma-palette-trigger-label="">Search</span>
                    <kbd data-enigma-palette-trigger-key="">{palette.shortcutLabel}</kbd>
                </>
            )}
        </Tag>
    );
}

export interface PaletteContentProps extends ComponentPropsWithoutRef<"div"> {
    /** Accessible name for the dialog. Rendered for screen readers only. */
    title?: string;
    /** Render into `document.body`. On by default: a palette inside a clipped or
     *  transformed ancestor is a panel nobody can see. */
    portal?: boolean;
    /** Rendered behind the panel. Pass null for no overlay of ours. */
    overlayProps?: ComponentPropsWithoutRef<"div"> | null;
    /**
     * How long the closing animation is given before the panel leaves the DOM, in ms.
     *
     * It exists because a component that unmounts on close can only ever animate IN: the
     * element is gone before a leaving animation has a frame to run. `data-state="closed"`
     * is set first, the stylesheet animates it, and only then does it unmount. 0 removes it
     * immediately, which is also what a reader with reduced motion gets.
     */
    closeDuration?: number;
}

/**
 * The panel: overlay, focus trap, Escape, scroll lock, and focus handed back to the trigger.
 *
 * Mounted only while open, so nothing of the palette is in the document (or in the tab
 * order) the rest of the time.
 */
export function PaletteContent({ title = "Search", portal = true, overlayProps, closeDuration = 160, children, ...props }: PaletteContentProps): ReactNode {
    const palette = usePaletteContext("SearchPalette.Content");
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [mounted, setMounted] = useState(false);
    /** Stays true through the closing animation, so the panel has frames to leave in. */
    const [present, setPresent] = useState(palette.open);

    // A portal has no server render: `document` does not exist there, and rendering the
    // panel into the tree instead would put it in the wrong place for one frame.
    useEffect(() => setMounted(true), []);

    useEffect(() => {
        if (palette.open) {
            setPresent(true);
            return;
        }
        if (!present) return;
        const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        const timer = setTimeout(() => setPresent(false), reduced ? 0 : closeDuration);
        return () => clearTimeout(timer);
    }, [palette.open, present, closeDuration]);

    useEffect(() => {
        if (!palette.open || typeof document === "undefined") return;

        const previous = document.activeElement as HTMLElement | null;
        const body = document.body;
        const overflow = body.style.overflow;
        // The page behind a modal must not scroll under it, and it must not shift either:
        // hiding the scrollbar without compensating for its width moves the whole layout.
        const gap = window.innerWidth - document.documentElement.clientWidth;
        const padding = body.style.paddingRight;
        body.style.overflow = "hidden";
        if (gap > 0) body.style.paddingRight = `${gap}px`;

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                event.preventDefault();
                palette.setOpen(false);
                return;
            }
            if (event.key !== "Tab") return;
            // The trap: Tab cycles inside the panel. Without it the next Tab lands on the
            // page behind, where a click does nothing and nothing says why.
            const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            if (!focusable || focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            body.style.overflow = overflow;
            body.style.paddingRight = padding;
            // Back where it came from, so closing with Escape does not drop the visitor at
            // the top of the document.
            (palette.triggerRef.current ?? previous)?.focus?.();
        };
    }, [palette.open, palette.setOpen, palette.triggerRef]);

    if (!present) return null;

    const panel = (
        <div data-enigma-palette-portal="" data-state={palette.open ? "open" : "closed"}>
            {overlayProps !== null && (
                <div
                    {...overlayProps}
                    data-enigma-palette-overlay=""
                    data-state={palette.open ? "open" : "closed"}
                    // A click outside is a dismiss, and it is not a keyboard event, so it
                    // never reaches the Escape handler.
                    onClick={(event) => {
                        overlayProps?.onClick?.(event);
                        if (!event.defaultPrevented) palette.setOpen(false);
                    }}
                />
            )}
            <div
                {...props}
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={palette.ids.title}
                data-enigma-palette-content=""
                data-state={palette.open ? "open" : "closed"}
            >
                <h2 id={palette.ids.title} data-enigma-palette-title="">{title}</h2>
                {children}
            </div>
        </div>
    );

    if (!portal) return panel;
    if (!mounted || typeof document === "undefined") return null;
    return createPortal(panel, document.body);
}

export interface PaletteFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange"> {
    asChild?: boolean;
}

/**
 * The query field.
 *
 * A `combobox` that keeps the caret while the arrows move a highlight somewhere else -
 * which is exactly what `aria-activedescendant` is for. Without it a screen reader hears
 * nothing move, because focus never leaves the field.
 */
export function PaletteField({ asChild = false, onKeyDown, ...props }: PaletteFieldProps): ReactNode {
    const palette = usePaletteContext("SearchPalette.Field");
    const Tag = asChild ? Slot : "input";
    const activeRow = palette.rows[palette.active];

    return (
        <Tag
            {...props}
            ref={palette.fieldRef as never}
            id={palette.ids.field}
            type="search"
            value={palette.query}
            // The palette is opened by a keystroke and closed by one; landing anywhere but
            // the field would make the first thing typed go missing.
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={palette.ids.list}
            aria-activedescendant={activeRow ? palette.rowId(activeRow) : undefined}
            data-enigma-palette-field=""
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => palette.setQuery(event.target.value)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                onKeyDown?.(event);
                if (event.defaultPrevented) return;
                const key = event.key as PaletteKey | "Enter";
                if (key === "Enter") {
                    event.preventDefault();
                    palette.select(palette.rows[palette.active]);
                    return;
                }
                if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(key)) {
                    event.preventDefault();
                    palette.setActive(moveActive(palette.active, palette.rows.length, key as PaletteKey));
                }
            }}
        />
    );
}

export interface PaletteListProps<Item> extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
    /** Render one row. The default prints its label, which is enough to be usable. */
    children?: (row: PaletteRow<Item>, state: { active: boolean; index: number; }) => ReactNode;
    /** Rendered when there is nothing to show. */
    empty?: ReactNode;
    /** The group heading. Pass null for a flat list with no headings. */
    heading?: ((label: string) => ReactNode) | null;
}

/** The results, grouped, with one flat keyboard sequence running through them. */
export function PaletteList<Item>({ children, empty, heading, ...props }: PaletteListProps<Item>): ReactNode {
    const palette = usePaletteContext<Item>("SearchPalette.List");
    const listRef = useRef<HTMLDivElement | null>(null);
    const groups = useMemo(() => groupRows(palette.rows, (row) => row.group), [palette.rows]);

    // Keeps the highlight in view when it is moved by the keyboard. `nearest` so the list
    // does not jump a whole panel for a row that was already half visible.
    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
    }, [palette.active, palette.rows]);

    return (
        <div
            {...props}
            ref={listRef}
            id={palette.ids.list}
            role="listbox"
            aria-label="Results"
            data-enigma-palette-list=""
        >
            {palette.rows.length === 0
                ? empty ?? <p data-enigma-palette-empty="">{palette.query.trim() ? `Nothing matches "${shortenQuery(palette.query)}".` : "Type to search."}</p>
                : groups.map((group) => (
                    <div key={group.label} role="group" aria-label={group.label} data-enigma-palette-group="">
                        {heading !== null && (
                            heading?.(group.label) ?? (
                                // The group carries the name already, so announcing the
                                // heading again would only repeat it.
                                <p data-enigma-palette-group-label="" aria-hidden="true">{group.label}</p>
                            )
                        )}
                        {group.rows.map(({ row, position }) => (
                            <PaletteItem
                                key={row.id}
                                row={row}
                                index={position}
                            >
                                {children?.(row, { active: position === palette.active, index: position })}
                            </PaletteItem>
                        ))}
                    </div>
                ))}
        </div>
    );
}

export interface PaletteItemProps<Item> extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
    row: PaletteRow<Item>;
    index: number;
    children?: ReactNode;
}

/**
 * One row.
 *
 * The pointer MOVES the highlight rather than running a second one of its own: two
 * highlights on screen is the thing that makes a palette feel unpredictable, because Enter
 * then opens the row the mouse is not on.
 */
export function PaletteItem<Item>({ row, index, children, ...props }: PaletteItemProps<Item>): ReactNode {
    const palette = usePaletteContext<Item>("SearchPalette.Item");
    const active = index === palette.active;
    return (
        <div
            {...props}
            id={palette.rowId(row)}
            role="option"
            aria-selected={active}
            data-enigma-palette-item=""
            data-kind={row.kind}
            data-active={active ? "true" : undefined}
            onMouseMove={() => { if (!active) palette.setActive(index); }}
            onClick={() => palette.select(row)}
        >
            {children ?? (
                <>
                    <span data-enigma-palette-item-label="">{row.label}</span>
                    {row.description && <span data-enigma-palette-item-description="">{row.description}</span>}
                </>
            )}
        </div>
    );
}

export interface PaletteFooterProps extends ComponentPropsWithoutRef<"div"> {
    /** Replace the hints. The default names the three keys that actually matter. */
    hints?: ReactNode;
}

/** The strip along the bottom that says which keys do what. */
export function PaletteFooter({ hints, children, ...props }: PaletteFooterProps): ReactNode {
    usePaletteContext("SearchPalette.Footer");
    return (
        <div {...props} data-enigma-palette-footer="">
            {children ?? hints ?? (
                <>
                    <span data-enigma-palette-hint=""><kbd>up</kbd><kbd>down</kbd> to move</span>
                    <span data-enigma-palette-hint=""><kbd>enter</kbd> to open</span>
                    <span data-enigma-palette-hint=""><kbd>esc</kbd> to close</span>
                </>
            )}
        </div>
    );
}
