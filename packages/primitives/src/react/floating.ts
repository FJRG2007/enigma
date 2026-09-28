"use client";

import { placeFloating, type FloatingRect, type FloatingSide } from "@/core/floating";
import { useCallback, useEffect, useLayoutEffect, useState, type DependencyList, type KeyboardEvent, type RefObject } from "react";

/**
 * A popup that cannot be clipped: portaled out of the tree and placed in viewport coordinates.
 *
 * Left where it is declared, an absolutely positioned panel belongs to its ancestors: any
 * `overflow: hidden` between it and the page cuts it off, and any stacking context puts it
 * under whatever the page raised - so a select inside a dialog, a card or a scrolling table
 * opens a list that is half there. Every primitive popup that hangs from a trigger (the
 * select, the colour picker) and the context menu go through here, so they escape the same
 * way and sit on the same layer (`--enigma-floating-z`, above the lightbox).
 *
 * The portal goes into `<body>`, except inside a dialog. A native modal `<dialog>` makes
 * everything outside it inert, and a script dialog (anything with `role="dialog"` or
 * `aria-modal`) traps focus and treats a press outside itself as dismissal - a panel in
 * `<body>` would be unclickable, or would close the dialog it was opened from. Inside the
 * dialog it is still `position: fixed`, which escapes every scrolling region in the dialog;
 * only a dialog that is itself a containing block (a `transform`, typically the centring
 * one) can clip it, and then the dialog's box is the boundary the panel flips and shrinks
 * inside, rather than a line it is cut at.
 */

/** Where a panel that hangs from `anchor` is portaled to. Null during a server render. */
export function floatingContainer(anchor: Element | null): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const host = anchor?.closest<HTMLElement>("dialog[open], [popover], [role=dialog], [role=alertdialog], [aria-modal=true]");
    return host ?? document.body;
}

/**
 * The frame a fixed panel lives in: what `left: 0; top: 0` resolves to, and the box it has
 * to stay inside.
 *
 * Measured with a probe rather than assumed, because `fixed` resolves against the viewport
 * only until an ancestor has a `transform`, a `filter` or `contain` - and then it resolves
 * against that ancestor, so viewport coordinates written as-is land offset by wherever the
 * ancestor happens to be.
 */
export function measureFrame(panel: HTMLElement): { x: number; y: number; boundary: FloatingRect; } {
    const root = document.documentElement;
    const viewport: FloatingRect = { left: 0, top: 0, right: root.clientWidth || window.innerWidth, bottom: root.clientHeight || window.innerHeight };
    const host = panel.parentElement;
    if (!host || host === document.body) return { x: 0, y: 0, boundary: viewport };

    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none";
    host.appendChild(probe);
    const origin = probe.getBoundingClientRect();
    probe.remove();

    const box = host.getBoundingClientRect();
    // The host IS the containing block when the probe sits on its padding box. Then its own
    // overflow clips the panel, and the room the panel has is the part of the host on screen.
    const isBlock = Math.abs(origin.left - (box.left + host.clientLeft)) < 1 && Math.abs(origin.top - (box.top + host.clientTop)) < 1;
    const style = getComputedStyle(host);
    const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
    const boundary = isBlock && clips
        ? {
            left: Math.max(viewport.left, box.left), top: Math.max(viewport.top, box.top),
            right: Math.min(viewport.right, box.right), bottom: Math.min(viewport.bottom, box.bottom)
        }
        : viewport;
    return { x: origin.left, y: origin.top, boundary };
}

export interface UseFloatingOptions {
    /** Whether the panel is up. Listeners exist only while it is. */
    open: boolean;
    /** What the panel hangs from. */
    anchorRef: RefObject<HTMLElement | null>;
    /** The panel itself, which has to be rendered into the returned container. */
    panelRef: RefObject<HTMLElement | null>;
    gap?: number;
    margin?: number;
    side?: FloatingSide | "auto";
    /** Things that change the panel's size, re-placed in the same frame rather than the next. */
    deps?: DependencyList;
}

/**
 * Places a portaled panel against its anchor and keeps it there.
 *
 * Returns the element to portal into - null until the first client effect, so a server
 * render and the hydration render agree on rendering no panel at all.
 *
 * The placement is written onto the element rather than kept in state: it lands in the same
 * layout pass the panel mounts in, before paint and before any effect of the panel's own
 * children. That order matters - the select's search field focuses itself in an effect, and a
 * panel still waiting for a state round-trip to be placed would be taking focus off-screen.
 * `--enigma-anchor-width` is the trigger's width, which is what a list's `min-width` needs now
 * that `100%` would be a percentage of the window.
 */
export function useFloating({ open, anchorRef, panelRef, gap = 4, margin = 8, side = "auto", deps = [] }: UseFloatingOptions): HTMLElement | null {
    const [container, setContainer] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        if (open) setContainer(floatingContainer(anchorRef.current));
    }, [open, anchorRef]);

    const place = useCallback(() => {
        const anchor = anchorRef.current;
        const panel = panelRef.current;
        if (!anchor || !panel) return;
        const rect = anchor.getBoundingClientRect();
        panel.style.setProperty("--enigma-anchor-width", `${rect.width}px`);
        // Measured at its natural height: the cap from the last placement would otherwise be
        // read back as the panel's size, and a panel that shrank once could never grow again.
        panel.style.maxHeight = "";
        const frame = measureFrame(panel);
        const placed = placeFloating(rect, { width: panel.offsetWidth, height: panel.offsetHeight }, { boundary: frame.boundary, margin, gap, side });
        panel.style.left = `${placed.left - frame.x}px`;
        panel.style.top = `${placed.top - frame.y}px`;
        panel.style.maxHeight = `${placed.maxHeight}px`;
        panel.setAttribute("data-side", placed.side);
    }, [anchorRef, panelRef, margin, gap, side]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useLayoutEffect(() => { if (open) place(); }, [open, container, place, ...deps]);

    /**
     * Kept against its anchor while anything moves. Fixed coordinates do not follow a scroll,
     * so every scroll anywhere (captured - a container's scroll does not bubble) and every
     * resize re-places it, one frame at a time. A ResizeObserver covers what no event reports:
     * the trigger growing a row of tags, the list filtering down to three rows.
     */
    useEffect(() => {
        if (!open || !container) return;
        let frame = 0;
        const schedule = (): void => {
            if (frame) return;
            frame = requestAnimationFrame(() => { frame = 0; place(); });
        };
        const onScroll = (event: Event): void => {
            // The panel's own list scrolling moves nothing.
            if (panelRef.current?.contains(event.target as Node | null)) return;
            schedule();
        };
        document.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", schedule);
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
        if (anchorRef.current) observer?.observe(anchorRef.current);
        if (panelRef.current) observer?.observe(panelRef.current);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", schedule);
            observer?.disconnect();
        };
    }, [open, container, place, anchorRef, panelRef]);

    return container;
}

const TABBABLE = "a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * Tab out of a portaled panel, landing where it would have if the panel were still next to
 * its trigger.
 *
 * In the tree, the panel came straight after the trigger, so Tab off its last control went to
 * whatever follows the trigger and Shift+Tab off its first went back to the trigger. In
 * `<body>` the panel is at the end of the page, and the same keys would send focus to the
 * browser's own chrome or the last link on the page. So: Shift+Tab off the first control
 * focuses the trigger itself, and Tab off the last focuses the trigger and lets the key carry
 * on from there, which is the element after it.
 *
 * Returns whether the key left the panel.
 */
export function tabOut(event: KeyboardEvent, panel: HTMLElement | null, trigger: HTMLElement | null): boolean {
    if (event.key !== "Tab" || !panel || !trigger) return false;
    const stops = Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE));
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey) {
        if (at > 0) return false;
        event.preventDefault();
        trigger.focus();
        return true;
    }
    if (at !== -1 && at < stops.length - 1) return false;
    trigger.focus();
    return true;
}
