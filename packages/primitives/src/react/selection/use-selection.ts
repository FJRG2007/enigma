"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, HTMLAttributes, ReactNode } from "react";
import {
    createSelection,
    type SelectionInstance,
    type SelectionOptions,
    type SelectionState
} from "@/core/selection";

/**
 * The selection model as a hook, plus the props that put it on real elements.
 *
 * Prop getters rather than components, because a selectable list is every shape at once - a
 * table, a grid of cards, a tree, a virtualized window - and a component that owned the markup
 * would fit exactly one of them. `<SelectionList>` next door IS this hook with a container and
 * rows around it, for the case where the shape is a plain list.
 */

export interface UseSelectionOptions<Item> extends Omit<SelectionOptions<Item>, "items"> {
    items: readonly Item[];
    /** Bring the cursor into view when the keyboard moves it. Default: on. */
    scrollIntoView?: boolean;
}

export interface UseSelectionResult<Item> {
    instance: SelectionInstance<Item>;
    state: SelectionState<Item>;
    /** Whether a row is selected, by id. */
    isSelected: (id: string) => boolean;
    /** The container: the keyboard, the roles and the id the rows point at. */
    getListProps: <T extends HTMLElement = HTMLElement>(props?: HTMLAttributes<T>) => HTMLAttributes<T> & { ref: (node: T | null) => void; };
    /** One row: its state, its id, and the click rule. */
    getItemProps: <T extends HTMLElement = HTMLElement>(index: number, props?: HTMLAttributes<T>) => HTMLAttributes<T> & { id: string; };
    /**
     * A press on the empty space of the container, for a rubber band. Composed OVER the list
     * props rather than beside them, so the two handlers do not overwrite each other:
     * `<div {...getMarqueeProps(getListProps())}>`.
     */
    getMarqueeProps: <T extends HTMLElement = HTMLElement>(props?: HTMLAttributes<T>) => HTMLAttributes<T>;
    /** The rubber band's rectangle while it is being dragged, in container coordinates. */
    marquee: MarqueeRect | null;
    ids: { list: string; };
    itemId: (index: number) => string;
}

/** A rubber band, in coordinates relative to the scrolling container's content. */
export interface MarqueeRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** How far the pointer must travel before a press becomes a rubber band rather than a click. */
const MARQUEE_SLOP = 4;

export function useSelection<Item>(options: UseSelectionOptions<Item>): UseSelectionResult<Item> {
    const { items, scrollIntoView = true, ...rest } = options;

    const id = useId();
    const listRef = useRef<HTMLElement | null>(null);
    const latest = useRef(options);
    latest.current = options;

    const instance = useMemo(() => createSelection<Item>({
        items,
        getId: (item, index) => (latest.current.getId ?? ((_: Item, position: number) => String(position)))(item, index),
        disabled: (item, index) => Boolean(latest.current.disabled?.(item, index)),
        onCommand: (event) => latest.current.onCommand?.(event),
        onSelectionChange: (ids, chosen) => latest.current.onSelectionChange?.(ids, chosen)
        // Built once: rebuilding it would drop the selection and the cursor on every render.
        // Everything below is pushed in through update().
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    const [state, setState] = useState<SelectionState<Item>>(() => instance.state);

    useEffect(() => {
        const unsubscribe = instance.subscribe(setState);
        setState(instance.state);
        return () => {
            unsubscribe();
            instance.destroy();
        };
    }, [instance]);

    const { multiple, columns, page, shortcuts } = rest;
    // The bindings as a string, because `shortcuts={{ rename: "F3" }}` is a new object on every
    // render: depending on its identity would push it in each time and emit a state for a
    // binding table nobody changed.
    const shortcutSignature = JSON.stringify(shortcuts ?? null);

    useEffect(() => {
        instance.update({ items, multiple, columns, page, shortcuts: latest.current.shortcuts });
    }, [instance, items, multiple, columns, page, shortcutSignature]);

    // The cursor can move by key onto a row that is scrolled out of sight, and a cursor nobody
    // can see is the same as none - every arrow press then looks like it did nothing.
    const cursor = state.cursor;
    useEffect(() => {
        if (!scrollIntoView || cursor < 0) return;
        const row = listRef.current?.querySelector<HTMLElement>(`[data-enigma-selection-index="${cursor}"]`);
        row?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [cursor, scrollIntoView]);

    const isSelected = useCallback((rowId: string) => state.selectedSet.has(rowId), [state.selectedSet]);

    const itemId = useCallback((index: number) => `${id}-item-${index}`, [id]);

    const getListProps = useCallback(<T extends HTMLElement>(props: HTMLAttributes<T> = {}) => ({
        ...props,
        ref: (node: T | null) => { listRef.current = node; },
        id: `${id}-list`,
        role: props.role ?? "listbox",
        "aria-multiselectable": (latest.current.multiple ?? true) || undefined,
        // A single tab stop, with the arrows moving a cursor INSIDE it: a list of two hundred
        // rows that are each tabbable is a list nobody can tab past.
        tabIndex: props.tabIndex ?? 0,
        "aria-activedescendant": state.cursor >= 0 ? itemId(state.cursor) : undefined,
        "data-enigma-selection-list": "",
        "data-selected-count": String(state.count),
        onKeyDown: (event: KeyboardEvent<T>) => {
            props.onKeyDown?.(event);
            if (event.defaultPrevented) return;
            // The browser's own meaning is taken only when a binding matched: Ctrl+A selects
            // the whole page, F2 does nothing, and Backspace still navigates back where the
            // list has not claimed them.
            if (instance.keyDown(event)) event.preventDefault();
        }
    }), [id, instance, itemId, state.cursor, state.count]);

    const getItemProps = useCallback(<T extends HTMLElement>(index: number, props: HTMLAttributes<T> = {}) => {
        const item = latest.current.items[index];
        const rowId = item === undefined ? null : (latest.current.getId ?? ((_: Item, position: number) => String(position)))(item, index);
        const disabled = item !== undefined && Boolean(latest.current.disabled?.(item, index));
        const chosen = rowId !== null && state.selectedSet.has(rowId);
        return {
            ...props,
            id: itemId(index),
            role: props.role ?? "option",
            "aria-selected": chosen,
            "aria-disabled": disabled || undefined,
            "data-enigma-selection-item": "",
            "data-enigma-selection-index": String(index),
            "data-selected": chosen ? "" : undefined,
            "data-cursor": state.cursor === index ? "" : undefined,
            "data-disabled": disabled ? "" : undefined,
            onPointerDown: (event: PointerEvent<T>) => {
                props.onPointerDown?.(event);
                if (event.defaultPrevented || disabled || event.button !== 0) return;
                // Down rather than click, so a drag that starts on a row begins from a
                // selection that already includes it - which is what makes dragging a group
                // work instead of collapsing it to the row under the pointer.
                instance.click(index, event);
            },
            onContextMenu: (event: React.MouseEvent<T>) => {
                props.onContextMenu?.(event);
                if (event.defaultPrevented || disabled) return;
                // A right-click on a row OUTSIDE the selection selects it first, and one
                // inside leaves the group alone. Same rule as `targets`, applied to the
                // selection itself - so what the menu acts on is what is highlighted.
                if (rowId !== null && !state.selectedSet.has(rowId)) instance.click(index);
            }
        } as HTMLAttributes<T> & { id: string; };
    }, [instance, itemId, state.selectedSet, state.cursor]);

    const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
    const drag = useRef<{ x: number; y: number; pointer: number; } | null>(null);

    const getMarqueeProps = useCallback(<T extends HTMLElement>(props: HTMLAttributes<T> = {}) => ({
        ...props,
        onPointerDown: (event: PointerEvent<T>) => {
            props.onPointerDown?.(event);
            if (event.defaultPrevented || event.button !== 0) return;
            // Only from EMPTY space: a press that lands on a row is that row's click, and a
            // band started there would fight the drag-and-drop the row probably has.
            if ((event.target as HTMLElement).closest("[data-enigma-selection-item]")) return;
            drag.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
        }
    }), []);

    // The band lives on the window rather than on the container: the pointer leaves the list
    // constantly while dragging one, and a listener on the element would stop tracking there.
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;

        const move = (event: globalThis.PointerEvent) => {
            const start = drag.current;
            if (!start || event.pointerId !== start.pointer) return;
            if (!marquee && Math.abs(event.clientX - start.x) < MARQUEE_SLOP && Math.abs(event.clientY - start.y) < MARQUEE_SLOP) return;
            if (!marquee) instance.beginMarquee(event.ctrlKey || event.metaKey);

            const bounds = list.getBoundingClientRect();
            const left = Math.min(start.x, event.clientX);
            const top = Math.min(start.y, event.clientY);
            const rect = {
                left: left - bounds.left + list.scrollLeft,
                top: top - bounds.top + list.scrollTop,
                width: Math.abs(event.clientX - start.x),
                height: Math.abs(event.clientY - start.y)
            };
            setMarquee(rect);

            // Measured from the rows themselves rather than from an assumed row height, so
            // this works for a grid, a table and a list of different-sized cards alike.
            const covered: number[] = [];
            for (const row of list.querySelectorAll<HTMLElement>("[data-enigma-selection-item]")) {
                const box = row.getBoundingClientRect();
                const hits = box.right >= Math.min(start.x, event.clientX)
                    && box.left <= Math.max(start.x, event.clientX)
                    && box.bottom >= Math.min(start.y, event.clientY)
                    && box.top <= Math.max(start.y, event.clientY);
                if (hits) covered.push(Number(row.dataset.enigmaSelectionIndex));
            }
            instance.marqueeTo(covered);
        };

        const up = () => {
            if (!drag.current) return;
            drag.current = null;
            setMarquee(null);
            instance.endMarquee();
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
        };
    }, [instance, marquee]);

    return {
        instance,
        state,
        isSelected,
        getListProps,
        getItemProps,
        getMarqueeProps,
        marquee,
        ids: { list: `${id}-list` },
        itemId
    };
}

/** What a row renderer is handed. Everything it needs to draw one row and nothing else. */
export interface SelectionRowRender<Item> {
    item: Item;
    index: number;
    selected: boolean;
    cursor: boolean;
    disabled: boolean;
}

export type SelectionRenderer<Item> = (row: SelectionRowRender<Item>) => ReactNode;
