"use client";

import { Slot } from "@/react/slot";
import { createPortal } from "react-dom";
import { shortenQuery } from "@/core/search";
import { shortcutTokens } from "@/core/keys";
import { CONTEXT_MENU_STYLES } from "@/react/context-menu/styles";
import { ContextMenuContext, useContextMenuContext, type ContextMenuItem, type ContextMenuNode } from "@/react/context-menu/context";
import {
    CLIPBOARD_PREFIX, clipboardEntries, clipboardAction, clipboardHasText, inspectClipboardTarget, performClipboardAction,
    type ClipboardMenuOptions, type ClipboardTarget
} from "@/core/clipboard-menu";
import {
    useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
    type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode
} from "react";
import {
    createContextMenu, isAction,
    type ContextMenuEntry, type ContextMenuInstance, type ContextMenuMoveKey,
    type ContextMenuOptions, type ContextMenuPoint, type ContextMenuState
} from "@/core/context-menu";

/**
 * The context menu, as parts.
 *
 * ```tsx
 * <ContextMenu.Root items={rows} onSelect={run}>
 *     <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
 *     <ContextMenu.Content />
 * </ContextMenu.Root>
 * ```
 *
 * `<ContextMenu>` in the entry next to this file is exactly that composition, and the reason
 * to come here is a menu whose trigger is not the thing it wraps - a "..." button that opens
 * it at its own corner, a canvas that opens it wherever a shape was pressed.
 *
 * WHY EVERY PANEL IS PORTALED AND FIXED. The menu is placed in VIEWPORT coordinates, because
 * that is what a pointer event reports. Left in the tree it inherits any ancestor's
 * `overflow: hidden`, any `transform` (which makes `fixed` resolve against that ancestor
 * rather than the window) and any stacking context - so the menu ends up clipped by the row
 * that opened it. Rendered into `<body>`, it is subject to none of them.
 */

/**
 * The three glyphs the clipboard rows carry.
 *
 * Drawn here rather than imported: a menu whose caller gives every row an icon and whose
 * built-in rows have none reads as three broken rows, and an icon file would be a request.
 * Stroked with `currentColor` at 1em, so they inherit the row's colour and size.
 */
const CLIPBOARD_ICON = {
    viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
    "aria-hidden": true
} as const;

const CLIPBOARD_ICONS = {
    copy: (
        <svg {...CLIPBOARD_ICON}>
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    ),
    cut: (
        <svg {...CLIPBOARD_ICON}>
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" />
        </svg>
    ),
    paste: (
        <svg {...CLIPBOARD_ICON}>
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" />
        </svg>
    )
};

let injected = false;

/**
 * The baseline look, injected once.
 *
 * A popup cannot ship naked the way a button can: unstyled, a menu is transparent text lying
 * on top of whatever it was opened over - not plain, illegible. So the sheet is injected and
 * PREPENDED to `<head>`, where anything the document already has outranks it by source order
 * without one `!important`; `styles={false}` turns it off, and
 * `@enigmax/primitives/context-menu.css` is the same sheet for anyone who would rather import it.
 */
function injectStyles(): void {
    if (injected || typeof document === "undefined") return;
    injected = true;
    if (document.querySelector("[data-enigma-menu-styles]")) return;
    const element = document.createElement("style");
    element.setAttribute("data-enigma-menu-styles", "");
    element.textContent = CONTEXT_MENU_STYLES;
    document.head.prepend(element);
}

/** Keys the open panel owns wherever focus happens to be inside it. */
const MOVE_KEYS: Record<string, ContextMenuMoveKey> = {
    ArrowDown: "ArrowDown",
    ArrowUp: "ArrowUp",
    Home: "Home",
    End: "End",
    PageDown: "PageDown",
    PageUp: "PageUp"
};

/** How long the pointer rests on a row before its submenu opens. Windows waits about this long. */
const OPEN_DELAY = 140;
/**
 * How long a submenu survives the pointer leaving its row.
 *
 * This is the number that makes a nested menu usable: the way OUT of a submenu passes over
 * its siblings, so closing on the first crossing means the branch disappears under the
 * pointer on the way to it. Long enough to cross, short enough not to feel stuck.
 */
const CLOSE_DELAY = 260;

/** How far the finger may travel before a long press stops being one. */
const TOUCH_SLOP = 10;
/** How long a finger rests before a long press is a right-click. */
const LONG_PRESS_MS = 500;

/** Kept clear of the window edge, so a menu never sits flush against it. */
const MARGIN = 8;

export interface ContextMenuRootProps {
    /** The rows. A list with nothing selectable in it opens no menu at all. */
    items: readonly ContextMenuNode[];
    /** A heading over the rows, naming what the menu is acting on. */
    title?: string;
    /** A row was invoked. The menu has already closed by the time this runs. */
    onSelect?: (item: ContextMenuItem, path: string[]) => void;
    onOpenChange?: (open: boolean) => void;
    /** Nothing opens, and the press is left to the browser. For a disabled row or a read-only view. */
    disabled?: boolean;
    /**
     * Copy, Cut and Paste, built from whatever was right-clicked. ON by default, and `false`
     * turns them off; an object turns off one of the three, renames them, or both.
     *
     * On by default because the browser's own menu has them and this one replaces it - a
     * custom menu over a text field that cannot copy is a loss the visitor discovers rather
     * than one anybody decided on. They appear only where they mean something: Copy over a
     * selection, Cut over a selection in something writable, Paste in anything writable.
     */
    clipboard?: boolean | ClipboardMenuOptions;
    /** Fuse.js's constructor, for fuzzy filtering. Omit it for the built-in matcher. */
    fuse?: ContextMenuOptions["fuse"];
    fuseOptions?: Record<string, unknown>;
    matcher?: ContextMenuOptions["matcher"];
    searchKeys?: string[];
    /** How long a fetched submenu stays cached. 0 refetches every time. Default 5 minutes. */
    cacheMs?: number;
    /** Hover timings, in ms. Leave them alone unless the design genuinely needs otherwise. */
    openDelay?: number;
    closeDelay?: number;
    /** Draw a row instead of the default icon / label / shortcut. */
    renderItem?: (item: ContextMenuItem, level: number, index: number) => ReactNode;
    loadingLabel?: ReactNode;
    emptyLabel?: ReactNode;
    /** Inject the baseline stylesheet. See the note above. */
    styles?: boolean;
    children?: ReactNode;
}

export function ContextMenuRoot(props: ContextMenuRootProps): ReactNode {
    const {
        items,
        title,
        disabled = false,
        fuse,
        fuseOptions,
        matcher,
        searchKeys,
        cacheMs,
        openDelay = OPEN_DELAY,
        closeDelay = CLOSE_DELAY,
        renderItem,
        loadingLabel = "Loading...",
        emptyLabel = "Nothing here.",
        styles = true,
        clipboard = true,
        children
    } = props;

    // Before paint: a sheet applied after the first frame shows the menu unstyled first.
    useLayoutEffect(() => { if (styles) injectStyles(); }, [styles]);

    const id = useId();
    const ids = useMemo(() => ({ trigger: `${id}-trigger` }), [id]);
    const triggerRef = useRef<HTMLElement | null>(null);
    /**
     * The pending "close this branch" beat, one for the whole menu rather than one per panel.
     *
     * Whoever the pointer arrives at has to be able to cancel it, and only a timer held here
     * can be: one owned by the panel the pointer LEFT outlives the row it came back to, and
     * the branch that row reopens is then shut by a timer nothing on screen can reach.
     */
    const closing = useRef(0);

    // Kept in a ref so the instance - built once - always calls the CURRENT props rather than
    // the ones it closed over on the first render.
    const latest = useRef(props);
    latest.current = props;

    const instance = useMemo<ContextMenuInstance>(() => createContextMenu({
        items: items as readonly ContextMenuEntry[],
        title,
        fuse,
        fuseOptions,
        matcher,
        searchKeys,
        cacheMs,
        onSelect: (item, path) => {
            // Ours are performed here and STILL reported: the caller may want to log the
            // copy, or undo it, and a row that reaches onSelect for every other item but
            // these three would be a hole nobody expects.
            const action = clipboardAction(item.id);
            if (action) void performClipboardAction(action, clipboardTarget.current);
            latest.current.onSelect?.(item as ContextMenuItem, path);
        },
        onOpenChange: (open) => latest.current.onOpenChange?.(open)
        // Built once: rebuilding it would drop the open branch and the highlight on every
        // render. Every option below is pushed in through update().
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    const [state, setState] = useState<ContextMenuState>(() => instance.state);

    useEffect(() => {
        const unsubscribe = instance.subscribe(setState);
        setState(instance.state);
        return () => {
            unsubscribe();
            instance.destroy();
        };
    }, [instance]);

    /**
     * What the rows ARE, as a string.
     *
     * The effect below cannot depend on the array: `items={[{ id: "copy", ... }]}` is a new
     * array of new objects on every render, so pushing it in would emit a new state, render
     * again, and build another array - a loop, and inline items are how everyone writes them.
     * React nodes are left out of the signature on purpose: an icon is a fresh element object
     * every render and no two are ever equal. Functions are left out for the same reason,
     * which is why `loadItems` is keyed by the row's id and not by its identity.
     *
     * `data` is whatever the caller wants back in `onSelect` - a record, a DOM node, a class
     * instance that points back at the thing holding it. A cycle in there is not a mistake,
     * so it is written as a marker rather than followed, and anything else that cannot be
     * written leaves the tree unsignable instead of throwing out of a render.
     */
    const signature = useMemo(() => {
        const seen = new WeakSet<object>();
        try {
            return JSON.stringify(items, (key, value) => {
                if (key === "icon") return undefined;
                if (typeof value === "function") return "fn";
                if (typeof value === "bigint") return String(value);
                if (typeof value === "object" && value !== null) {
                    if (seen.has(value)) return "[circular]";
                    seen.add(value);
                }
                return value as unknown;
            });
        } catch {
            return "[unserializable]";
        }
    }, [items]);

    const currentItems = useRef(items);
    currentItems.current = items;

    /* -------- the clipboard rows, and what they were built over -------- */

    /**
     * What the menu was opened over, and the rows that came out of it.
     *
     * Refs rather than state, and read at open time rather than derived: the selection and the
     * caret belong to the DOM at the instant of the press, and a render later they are gone -
     * choosing a row moves focus into the panel. Keeping them here also means the merge below
     * never re-runs the inspection, so what is performed is what the rows were built from.
     */
    const clipboardTarget = useRef<ClipboardTarget>(inspectClipboardTarget(null));
    const clipboardRows = useRef<ContextMenuEntry[]>([]);

    const clipboardOptions = useMemo<ClipboardMenuOptions | null>(() => {
        if (clipboard === false) return null;
        return { icons: CLIPBOARD_ICONS, ...(clipboard === true ? {} : clipboard) };
    }, [clipboard]);

    /**
     * The caller's rows with ours in front of them.
     *
     * In front because that is where every desktop menu puts them, and separated because they
     * are about the SELECTION rather than about the thing the menu was opened on - two blocks
     * with a rule between them, not one list where Copy sits next to Delete.
     */
    const withClipboard = useCallback((rows: readonly ContextMenuNode[]): readonly ContextMenuEntry[] => {
        const clip = clipboardRows.current;
        if (clip.length === 0) return rows as readonly ContextMenuEntry[];
        if (rows.length === 0) return clip;
        return [...clip, { type: "separator", id: `${CLIPBOARD_PREFIX}rule` }, ...(rows as readonly ContextMenuEntry[])];
    }, []);

    useEffect(() => {
        instance.update({ items: withClipboard(currentItems.current), title });
    }, [instance, signature, title, withClipboard]);

    const cancelClose = useCallback(() => { window.clearTimeout(closing.current); }, []);

    const scheduleClose = useCallback((level: number) => {
        window.clearTimeout(closing.current);
        closing.current = window.setTimeout(() => instance.closeBelow(level), closeDelay);
    }, [instance, closeDelay]);

    useEffect(() => cancelClose, [cancelClose]);

    /**
     * Open at a point, over `target` - whatever the press actually landed on.
     *
     * The rows are pushed in SYNCHRONOUSLY, before the menu opens: state would arrive a render
     * too late and the first paint of the menu would be the one without them.
     */
    const open = useCallback((point: ContextMenuPoint, target?: EventTarget | null): boolean => {
        if (disabled) return false;
        cancelClose();

        if (clipboardOptions) {
            clipboardTarget.current = inspectClipboardTarget(target ?? null);
            clipboardRows.current = clipboardEntries(clipboardTarget.current, clipboardOptions);
            instance.update({ items: withClipboard(currentItems.current) });

            /**
             * And then, where the browser will say so without a prompt, whether there is
             * anything to paste. It answers a microtask later at best, so Paste opens enabled
             * and greys out if the clipboard turns out to be empty - the other way round would
             * flash a disabled row on every menu that opens over a field.
             */
            if (clipboardRows.current.some((entry) => isAction(entry) && clipboardAction(entry.id) === "paste")) {
                void clipboardHasText().then((has) => {
                    if (has !== false || !instance.state.open) return;
                    clipboardRows.current = clipboardRows.current.map((entry) => (
                        isAction(entry) && clipboardAction(entry.id) === "paste" ? { ...entry, disabled: true } : entry
                    ));
                    instance.update({ items: withClipboard(currentItems.current) });
                });
            }
        }

        return instance.open(point);
    }, [instance, disabled, cancelClose, clipboardOptions, withClipboard]);

    const close = useCallback(() => {
        cancelClose();
        instance.close();
        // Focus goes back to the trigger rather than to the body: the menu is gone, and a
        // keyboard visitor left standing on nothing has to tab from the top of the page.
        triggerRef.current?.focus?.();
    }, [instance, cancelClose]);

    /**
     * What dismisses it, other than choosing something.
     *
     * A press outside is handled on the way DOWN, before whatever was pressed runs, so the
     * click that dismisses the menu does not also activate what is under it. Scrolling and
     * resizing close it outright rather than moving it: the menu was opened at a point on the
     * page that is no longer under the pointer, and every desktop menu does the same.
     */
    useEffect(() => {
        if (!state.open) return;

        const inside = (target: EventTarget | null) => Boolean((target as Element | null)?.closest?.("[data-enigma-menu-panel]"));
        const onPointerDown = (event: globalThis.PointerEvent) => {
            if (inside(event.target)) return;
            // Not `close()`: focus belongs wherever the press is going, not back on the
            // trigger. Taking it would move the caret out of the field the user just clicked.
            instance.close();
        };
        const onContextMenu = (event: globalThis.MouseEvent) => {
            // A right-click elsewhere opens THAT menu; ours has to be gone before it does.
            if (!inside(event.target)) instance.close();
        };
        const onScroll = (event: Event) => {
            if (inside(event.target)) return;
            instance.close();
        };
        const onBlur = () => instance.close();

        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("contextmenu", onContextMenu, true);
        // Capture, because a scroll inside a container does not bubble to the window.
        document.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onBlur);
        window.addEventListener("blur", onBlur);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("contextmenu", onContextMenu, true);
            document.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onBlur);
            window.removeEventListener("blur", onBlur);
        };
    }, [state.open, instance]);

    const onMenuKeyDown = useCallback((event: KeyboardEvent) => {
        const deepest = instance.state.levels.length - 1;
        const level = instance.state.levels[deepest];
        if (!level) return;
        const field = (event.target as HTMLElement | null)?.matches?.("[data-enigma-menu-search]") ?? false;

        const move = MOVE_KEYS[event.key];
        if (move) {
            event.preventDefault();
            instance.move(move);
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            instance.selectActive();
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            // Stopped here so one Escape closes the menu and not the dialog around it.
            event.stopPropagation();
            // A submenu closes back to its parent; the root closes the menu. Anything else
            // would make a three-deep menu take one keystroke to dismiss and lose your place.
            if (deepest > 0) instance.leaveSubmenu();
            else close();
            return;
        }
        if (event.key === "ArrowRight" && !field) {
            event.preventDefault();
            instance.enterSubmenu();
            return;
        }
        if (event.key === "ArrowLeft" && !field) {
            event.preventDefault();
            instance.leaveSubmenu();
            return;
        }
        if (event.key === "Tab") {
            // A menu is not part of the page's tab order: tabbing out of it dismisses it,
            // which is what every desktop menu does and what stops focus escaping into the
            // portal's siblings.
            event.preventDefault();
            close();
            return;
        }
        // Space chooses where there is no field to type into; inside the filter it is a
        // space, and taking it would make phrases unsearchable.
        if (event.key === " " && !field) {
            event.preventDefault();
            instance.selectActive();
            return;
        }
        // Typeahead, the way a desktop menu does it - and only where there is no field,
        // because there the letters ARE the filter.
        if (!field && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            instance.typeahead(event.key);
        }
    }, [instance, close]);

    const context = useMemo(() => ({
        instance,
        state,
        open,
        close,
        ids,
        panelId: (level: number) => `${id}-panel-${level}`,
        itemId: (level: number, index: number) => `${id}-item-${level}-${index}`,
        triggerRef,
        onMenuKeyDown,
        delays: { open: openDelay, close: closeDelay },
        cancelClose,
        scheduleClose,
        renderItem,
        loadingLabel,
        emptyLabel
    }), [instance, state, open, close, ids, id, onMenuKeyDown, openDelay, closeDelay, cancelClose, scheduleClose, renderItem, loadingLabel, emptyLabel]);

    return <ContextMenuContext.Provider value={context}>{children}</ContextMenuContext.Provider>;
}

export interface ContextMenuTriggerProps extends ComponentPropsWithoutRef<"div"> {
    /** Put the behaviour on your own element instead of a wrapper div. */
    asChild?: boolean;
    /** Open on a long press as well, which is what a right-click is on a touch screen. */
    longPress?: boolean;
}

/**
 * The area a right-click opens the menu over.
 *
 * It is `tabIndex={0}` and answers Shift+F10 and the Menu key, because a context menu reached
 * only by right-clicking is one a keyboard user cannot open at all - and those two are the
 * shortcuts the platform already assigns to it. Opened that way it appears at the element's
 * own corner rather than at a pointer that was never there.
 */
export function ContextMenuTrigger({ asChild = false, longPress = true, children, ...props }: ContextMenuTriggerProps): ReactNode {
    const menu = useContextMenuContext("ContextMenu.Trigger");
    const Tag = asChild ? Slot : "div";
    const press = useRef<{ timer: number; x: number; y: number; } | null>(null);

    const cancelPress = useCallback(() => {
        if (press.current) window.clearTimeout(press.current.timer);
        press.current = null;
    }, []);

    useEffect(() => cancelPress, [cancelPress]);

    return (
        <Tag
            {...props}
            ref={menu.triggerRef as never}
            id={menu.ids.trigger}
            tabIndex={props.tabIndex ?? 0}
            data-enigma-menu-trigger=""
            data-open={menu.state.open ? "" : undefined}
            aria-haspopup="menu"
            aria-expanded={menu.state.open}
            onContextMenu={(event) => {
                props.onContextMenu?.(event);
                if (event.defaultPrevented) return;
                // The default is prevented only when a menu actually opened. With nothing to
                // show, the browser's own menu is better than none - and than an empty box.
                // The event TARGET, not the trigger: the clipboard rows are built from the
                // field or the selection the press actually landed on, which is usually a
                // descendant of the area this menu covers.
                if (menu.open({ x: event.clientX, y: event.clientY }, event.target)) event.preventDefault();
            }}
            onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
                props.onPointerDown?.(event);
                if (event.defaultPrevented || !longPress || event.pointerType !== "touch") return;
                const { clientX: x, clientY: y } = event;
                cancelPress();
                const target = event.target;
                press.current = { x, y, timer: window.setTimeout(() => { press.current = null; menu.open({ x, y }, target); }, LONG_PRESS_MS) };
            }}
            onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
                props.onPointerMove?.(event);
                // A finger that travels is a scroll or a drag, not a press. Without this the
                // menu opens in the middle of flicking the list.
                const held = press.current;
                if (held && (Math.abs(event.clientX - held.x) > TOUCH_SLOP || Math.abs(event.clientY - held.y) > TOUCH_SLOP)) cancelPress();
            }}
            onPointerUp={(event: PointerEvent<HTMLDivElement>) => { props.onPointerUp?.(event); cancelPress(); }}
            onPointerCancel={(event: PointerEvent<HTMLDivElement>) => { props.onPointerCancel?.(event); cancelPress(); }}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                props.onKeyDown?.(event);
                if (event.defaultPrevented) return;
                // Shift+F10 and the Menu key: what the platform gives a keyboard user to open
                // a context menu with, on every desktop there is.
                const wanted = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
                if (!wanted) return;
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                // At the element's own corner, inset a little: a menu opened by key has no
                // pointer to appear under, and the corner is where every platform puts it.
                // Opened by key, so what it is over is wherever the caret is - which is what
                // a keyboard visitor means by "here".
                if (menu.open({ x: rect.left + 8, y: rect.top + 8 }, document.activeElement)) event.preventDefault();
            }}
        >
            {children}
        </Tag>
    );
}

export interface ContextMenuContentProps extends ComponentPropsWithoutRef<"div"> {
    /** How many rows to put in the document at once. `Infinity` renders the lot. */
    chunk?: number;
    /** Render the panels where they are instead of in `<body>`. See the note on Root. */
    portal?: boolean;
}

/** The whole open branch: the root panel, then one panel per open submenu. */
export function ContextMenuContent({ chunk = 40, portal = true, ...props }: ContextMenuContentProps): ReactNode {
    const menu = useContextMenuContext("ContextMenu.Content");
    const [mounted, setMounted] = useState(false);

    // The portal cannot exist during a server render and must not be created on the first
    // client render either, or the two trees disagree.
    useEffect(() => { setMounted(true); }, []);

    if (!menu.state.open || menu.state.levels.length === 0) return null;

    const panels = (
        <>
            {menu.state.levels.map((_, level) => (
                <ContextMenuPanel key={level} level={level} chunk={chunk} {...props} />
            ))}
        </>
    );

    if (!portal) return panels;
    if (!mounted || typeof document === "undefined") return null;
    return createPortal(panels, document.body);
}

export interface ContextMenuPanelProps extends ComponentPropsWithoutRef<"div"> {
    level: number;
    chunk?: number;
}

/**
 * One level: its heading, its filter and its rows, placed against the thing that opened it.
 *
 * The root panel is placed at the pointer; a submenu is placed against the ROW that opened
 * it. Both flip rather than overflow - a menu opened near the right edge of the window opens
 * leftwards, and one near the bottom opens upwards, because the alternative is a panel whose
 * rows are off the screen and unreachable.
 */
export function ContextMenuPanel({ level, chunk = 40, ...props }: ContextMenuPanelProps): ReactNode {
    const menu = useContextMenuContext("ContextMenu.Panel");
    const state = menu.state.levels[level];
    const ref = useRef<HTMLDivElement | null>(null);
    const [placed, setPlaced] = useState<CSSProperties | null>(null);

    const point = menu.state.point;
    const rows = state?.visible.length ?? 0;
    const loading = state?.loading ?? false;

    useLayoutEffect(() => {
        const panel = ref.current;
        if (!panel) return;
        // Measured with the placement cleared, so a panel that shrank is not measured against
        // the width it had while it was longer.
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left: number;
        let top: number;

        if (level === 0) {
            left = point?.x ?? MARGIN;
            top = point?.y ?? MARGIN;
            // Flipped rather than clamped: a menu whose left edge is dragged back to fit
            // would sit UNDER the pointer, and the first row would be chosen by the release.
            if (left + width > vw - MARGIN) left = Math.max(MARGIN, left - width);
            if (top + height > vh - MARGIN) top = Math.max(MARGIN, top - height);
        } else {
            const parent = document.getElementById(menu.panelId(level - 1))?.getBoundingClientRect();
            const row = document.getElementById(menu.itemId(level - 1, menu.state.levels[level - 1]?.active ?? -1))?.getBoundingClientRect();
            const anchor = parent ?? { left: point?.x ?? MARGIN, right: point?.x ?? MARGIN, top: point?.y ?? MARGIN } as DOMRect;
            // Overlapped by a couple of pixels on purpose: a gap between a row and its
            // submenu is a strip of page that closes the branch when the pointer crosses it.
            left = anchor.right - 2;
            if (left + width > vw - MARGIN) left = Math.max(MARGIN, anchor.left - width + 2);
            top = (row?.top ?? anchor.top) - 4;
            if (top + height > vh - MARGIN) top = Math.max(MARGIN, vh - MARGIN - height);
        }

        setPlaced({ left: Math.max(MARGIN, Math.round(left)), top: Math.max(MARGIN, Math.round(top)) });
        // Re-placed whenever the panel's own size can have changed: a filter that shortens the
        // list, a fetched submenu that arrived, another chunk of a long one.
    }, [level, point?.x, point?.y, rows, loading, menu, menu.state.levels.length]);

    /**
     * The panel takes focus so the keyboard has somewhere to be - the search field when there
     * is one, the panel itself otherwise. Without it the keys keep going to the trigger, and
     * every arrow press looks like the menu ignoring it.
     *
     * AFTER it has been placed, which is the part that is easy to get wrong: the panel is
     * `visibility: hidden` until then so it cannot be seen at 0,0 for a frame, and `focus()`
     * on a hidden element does nothing at all - silently, with the panel on screen a moment
     * later looking exactly as if it had worked.
     *
     * And whenever this panel becomes the DEEPEST one again, not only when it mounts: closing
     * a submenu unmounts the element that held focus, which leaves it on the body - and the
     * next Escape then reaches nothing at all.
     */
    const isPlaced = placed !== null;
    const isDeepest = menu.state.levels.length - 1 === level;
    useEffect(() => {
        const panel = ref.current;
        if (!panel || !isPlaced || !isDeepest) return;
        const field = panel.querySelector<HTMLInputElement>("[data-enigma-menu-search]");
        (field ?? panel).focus({ preventScroll: true });
    }, [level, state?.searchable, isPlaced, isDeepest]);

    if (!state) return null;

    return (
        <div
            {...props}
            ref={ref}
            id={menu.panelId(level)}
            role="menu"
            tabIndex={-1}
            aria-label={state.title ?? undefined}
            aria-activedescendant={state.active >= 0 ? menu.itemId(level, state.active) : undefined}
            data-enigma-menu-panel=""
            data-level={level}
            data-placed={placed ? "" : undefined}
            style={{ ...placed, ...props.style }}
            onKeyDown={(event) => {
                props.onKeyDown?.(event);
                if (!event.defaultPrevented) menu.onMenuKeyDown(event);
            }}
            onPointerEnter={(event) => {
                props.onPointerEnter?.(event);
                // Coming back into a panel cancels the close scheduled on the way out of one.
                // Without this, crossing a sibling on the way to a submenu closes it.
                menu.cancelClose();
            }}
            onPointerLeave={(event) => {
                props.onPointerLeave?.(event);
                // Leaving the DEEPEST panel closes it after a beat, so the pointer can pass
                // over the parent's other rows on its way somewhere without the branch
                // vanishing under it.
                if (level !== menu.state.levels.length - 1 || level === 0) return;
                menu.scheduleClose(level - 1);
            }}
        >
            {state.title && <p data-enigma-menu-title="" title={state.title}>{state.title}</p>}
            {state.searchable && <ContextMenuSearch level={level} />}
            <ContextMenuList level={level} chunk={chunk} />
        </div>
    );
}

export interface ContextMenuSearchProps extends Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "type"> {
    level: number;
    placeholder?: string;
}

export function ContextMenuSearch({ level, placeholder = "Search", onKeyDown, ...props }: ContextMenuSearchProps): ReactNode {
    const menu = useContextMenuContext("ContextMenu.Search");
    const state = menu.state.levels[level];
    if (!state) return null;

    return (
        <input
            {...props}
            // `search` and not `text`: it is a search field, and the platform knows what that
            // means for the keyboard's enter key and for autofill.
            type="search"
            role="combobox"
            aria-expanded
            aria-controls={menu.panelId(level)}
            aria-autocomplete="list"
            aria-activedescendant={state.active >= 0 ? menu.itemId(level, state.active) : undefined}
            aria-label={props["aria-label"] ?? placeholder}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            data-enigma-menu-search=""
            value={state.query}
            onChange={(event) => menu.instance.setQuery(level, event.target.value)}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (!event.defaultPrevented) menu.onMenuKeyDown(event);
            }}
        />
    );
}

/** Rows kept ahead of the highlight, so arrowing down never runs into an unrendered row. */
const OVERSCAN = 10;

export interface ContextMenuListProps extends ComponentPropsWithoutRef<"div"> {
    level: number;
    chunk?: number;
}

/**
 * The rows of one level, rendered a window at a time.
 *
 * A menu is usually short and this costs nothing there. It stops costing nothing the moment a
 * submenu is a list of files, a branch, a tag or a device - which is exactly the submenu that
 * is fetched, and the one that would otherwise put five hundred subtrees in the document for
 * the eight rows anybody sees.
 */
export function ContextMenuList({ level, chunk = 40, ...props }: ContextMenuListProps): ReactNode {
    const menu = useContextMenuContext("ContextMenu.List");
    const state = menu.state.levels[level];
    const sentinel = useRef<HTMLDivElement | null>(null);
    const [limit, setLimit] = useState(chunk);

    const query = state?.query ?? "";
    // A new filter is a new list: keeping the old window would leave a short result set
    // rendering rows it no longer has, and a long one starting halfway down.
    useEffect(() => { setLimit(chunk); }, [query, chunk]);

    const total = state?.visible.length ?? 0;
    const active = state?.active ?? -1;
    const shown = Math.min(total, Math.max(limit, active + 1 + OVERSCAN));
    const rest = total - shown;

    useEffect(() => {
        const target = sentinel.current;
        if (!target) return;
        // Without IntersectionObserver the whole list renders rather than a window of it:
        // slower to open beats unreachable rows.
        if (typeof IntersectionObserver === "undefined") { setLimit(Number.POSITIVE_INFINITY); return; }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) setLimit((current) => current + chunk);
        }, { root: target.parentElement, rootMargin: "120px" });
        observer.observe(target);
        return () => observer.disconnect();
    }, [chunk, rest]);

    if (!state) return null;

    if (state.loading) return <div {...props} data-enigma-menu-list=""><p data-enigma-menu-status="">{menu.loadingLabel}</p></div>;
    if (state.error) {
        return (
            <div {...props} data-enigma-menu-list="">
                {/* The reason, not a blank panel: a branch that came back empty and one that
                    failed look identical otherwise, and only one of them is worth retrying. */}
                <p data-enigma-menu-status="" data-error="" role="alert">{state.error.message}</p>
            </div>
        );
    }
    if (total === 0) {
        return (
            <div {...props} data-enigma-menu-list="">
                <p data-enigma-menu-status="">
                    {state.query.trim() ? `Nothing matches "${shortenQuery(state.query)}".` : menu.emptyLabel}
                </p>
            </div>
        );
    }

    return (
        <div {...props} data-enigma-menu-list="">
            {state.visible.slice(0, shown).map((entry, index) => (
                <ContextMenuRow key={entryKey(entry, index)} level={level} index={index} entry={entry} />
            ))}
            {rest > 0 && (
                // The end of what is rendered. Reaching it renders the next chunk, so the list
                // appears endless while the document holds a screenful of it.
                <div ref={sentinel} data-enigma-menu-more="" aria-hidden="true" />
            )}
        </div>
    );
}

/** Furniture has no id of its own, and two separators in one menu are not the same node. */
function entryKey(entry: ContextMenuEntry, index: number): string {
    return isAction(entry) ? entry.id : `${entry.type}-${entry.id ?? index}`;
}

export interface ContextMenuRowProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
    level: number;
    /** Its position in the level's VISIBLE list, which is what the keyboard moves through. */
    index: number;
    entry: ContextMenuEntry;
    children?: ReactNode;
}

export function ContextMenuRow({ level, index, entry, children, ...props }: ContextMenuRowProps): ReactNode {
    const menu = useContextMenuContext("ContextMenu.Item");
    const ref = useRef<HTMLDivElement | null>(null);
    const timers = useRef({ open: 0 });

    const state = menu.state.levels[level];
    const isActive = state?.active === index;
    const item = isAction(entry) ? (entry as ContextMenuItem) : null;
    const submenu = Boolean(item && (item.loadItems || (item.items && item.items.some((child) => isAction(child as ContextMenuEntry)))));
    const expanded = submenu && menu.state.levels[level + 1]?.path[level] === item?.id;

    // The highlight can move by key onto a row that is scrolled out of sight, and a highlight
    // nobody can see is the same as no highlight.
    useEffect(() => {
        if (isActive) ref.current?.scrollIntoView({ block: "nearest" });
    }, [isActive]);

    // A row that opened a submenu by key must open it there too: the keyboard path goes
    // through instance.enterSubmenu, so this only cleans up the pointer's timers.
    useEffect(() => {
        const held = timers.current;
        return () => { window.clearTimeout(held.open); };
    }, []);

    if (!item) {
        if (entry.type === "separator") return <div {...props} role="separator" data-enigma-menu-separator="" />;
        return <p {...props} data-enigma-menu-label="" aria-hidden="true">{entry.label}</p>;
    }

    const checkable = item.checked !== undefined;
    // A checkable row inside a group is a radio: choosing one is choosing INSTEAD of its
    // siblings, and a screen reader announces the two differently.
    const role = checkable ? (item.group ? "menuitemradio" : "menuitemcheckbox") : "menuitem";

    return (
        <div
            {...props}
            ref={ref}
            id={menu.itemId(level, index)}
            role={role}
            aria-disabled={item.disabled || undefined}
            aria-haspopup={submenu ? "menu" : undefined}
            aria-expanded={submenu ? expanded : undefined}
            aria-checked={checkable ? Boolean(item.checked) : undefined}
            // The printed shortcut is decoration (`aria-hidden`), so the announced one is
            // this - and it is announced in the platform-neutral spelling, which is what the
            // attribute is defined to take.
            aria-keyshortcuts={item.shortcut}
            data-enigma-menu-item=""
            data-active={isActive ? "" : undefined}
            data-disabled={item.disabled ? "" : undefined}
            data-destructive={item.destructive ? "" : undefined}
            data-submenu={submenu ? "" : undefined}
            onPointerEnter={() => {
                window.clearTimeout(timers.current.open);
                menu.cancelClose();
                if (!item.disabled) menu.instance.setActive(level, index);
                if (!item.disabled && submenu) {
                    timers.current.open = window.setTimeout(() => menu.instance.openSubmenu(level, index), menu.delays.open);
                } else if (menu.state.levels.length > level + 1) {
                    // Resting on a plain row closes the branch a sibling had open - after the
                    // same beat, so passing over it on the way somewhere costs nothing.
                    menu.scheduleClose(level);
                }
            }}
            onPointerLeave={() => {
                window.clearTimeout(timers.current.open);
            }}
            // Up rather than down: the press that OPENED the menu is a `contextmenu`, and the
            // release of that same press lands on whichever row is under the pointer. Choosing
            // on the way down would invoke it before the menu was ever seen.
            onPointerUp={(event) => {
                props.onPointerUp?.(event);
                // The primary button only: a right-click inside a panel deliberately leaves
                // the menu open, so its release over a row would invoke that row - and one of
                // them is usually the destructive one.
                if (event.defaultPrevented || item.disabled || event.button !== 0) return;
                menu.instance.select(level, index);
            }}
            onClick={(event) => {
                props.onClick?.(event);
                // A click with no pointer behind it - a screen reader, a synthetic press.
                // `detail` is 0 exactly then, and the pointerup path has already handled the
                // rest, so this cannot double-fire.
                if (event.defaultPrevented || item.disabled || event.detail !== 0) return;
                menu.instance.select(level, index);
            }}
        >
            {children ?? menu.renderItem?.(item, level, index) ?? <ContextMenuRowContent item={item} submenu={submenu} />}
        </div>
    );
}

/** The default row: what a desktop menu draws, in the order it draws it. */
function ContextMenuRowContent({ item, submenu }: { item: ContextMenuItem; submenu: boolean; }): ReactNode {
    return (
        <>
            {item.checked !== undefined && <span data-enigma-menu-check="" aria-hidden="true" />}
            {item.icon ? <span data-enigma-menu-icon="">{item.icon}</span> : null}
            <span data-enigma-menu-item-text="">
                <span data-enigma-menu-item-label="">{item.label}</span>
                {item.description && <span data-enigma-menu-item-description="">{item.description}</span>}
            </span>
            {item.shortcut && (
                // One `<kbd>` per key, so `Ctrl` and `C` can be spaced apart - and written for
                // THIS platform, because a menu that says Ctrl on a Mac is a hint that misleads.
                <span data-enigma-menu-shortcut="" aria-hidden="true">
                    {shortcutTokens(item.shortcut).map((token, index) => <kbd key={index}>{token}</kbd>)}
                </span>
            )}
            {submenu && <span data-enigma-menu-arrow="" aria-hidden="true" />}
        </>
    );
}
