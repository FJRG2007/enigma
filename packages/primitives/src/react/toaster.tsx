"use client";

import { TOAST_STYLES } from "@/react/toast-styles";
import { defaultQueue } from "@/react/use-notifications";
import type { Notification, Notifications } from "@/core/notifications";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * `<Toaster />` - the stack, the movement, the gestures and, unlike the rest of this
 * package, a look.
 *
 * The queue underneath already owns ordering, dedupe by key, sticky errors and timers that
 * HOLD while the tab is hidden. What this adds is everything you cannot express in a queue:
 * a toast on its way out is still on screen, a pointer resting on the stack stops the clock,
 * a swipe follows the finger before it decides anything, and the stack itself is depth - the
 * newest toast in front, the older ones behind it, clipped to its height and fanning out
 * when the pointer arrives.
 *
 * WHY THIS ONE SHIPS STYLES. Everywhere else in this package a missing stylesheet gives you
 * an unstyled component you can see and fix. A toast renders at the edge of the screen,
 * stacked and animated, so the same omission gives you a pile of text in a corner - and
 * "remember to import the CSS" is a footgun to hand somebody for a component that appears
 * once every few minutes. The theme is injected once, PREPENDED to `<head>` so anything the
 * document already has outranks it by source order, and `styles={false}` turns it off.
 *
 * Every part still carries a data attribute, so overriding any of it is a selector rather
 * than a fork, and `enigma add toast --copy` writes the same stylesheet out to edit.
 */

/** How many toasts are on screen at once. The rest wait behind, counted but not drawn. */
const VISIBLE = 3;

let injected = false;

/**
 * The theme, once per document.
 *
 * Prepended rather than appended: at equal specificity the LAST rule wins, so putting this
 * first means a consumer stylesheet always beats it without a single `!important`.
 */
function injectStyles(): void {
    if (injected || typeof document === "undefined") return;
    injected = true;
    if (document.querySelector("[data-enigma-toast-styles]")) return;
    const element = document.createElement("style");
    element.setAttribute("data-enigma-toast-styles", "");
    element.textContent = TOAST_STYLES;
    document.head.prepend(element);
}

const ICONS: Record<string, ReactNode> = {
    success: <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.86-9.81a.75.75 0 00-1.22-.88l-3.48 4.79-1.88-1.88a.75.75 0 10-1.06 1.06l2.5 2.5a.75.75 0 001.14-.09l4-5.5z" />,
    error: <path d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" />,
    warning: <path d="M9.4 3a1.5 1.5 0 012.6 0l7.36 12.75A1.5 1.5 0 0118.06 18H3.94a1.5 1.5 0 01-1.3-2.25L10 3zm.85 4.5a.75.75 0 00-1.5 0v4a.75.75 0 001.5 0v-4zM10 15a.9.9 0 100-1.8.9.9 0 000 1.8z" />,
    info: <path d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.25a.25.25 0 01.25.3l-.46 2.07A1.75 1.75 0 0010.75 15H11a.75.75 0 000-1.5h-.25a.25.25 0 01-.25-.3l.46-2.07A1.75 1.75 0 009.25 9H9z" />
};

/** The tone's glyph, or the spinner a loading toast turns into. */
function ToneIcon({ tone }: { tone?: string; }): ReactNode {
    if (!tone || tone === "default") return null;
    if (tone === "loading") {
        return (
            <span data-enigma-toast-icon="" data-tone="loading">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-6.22-8.56" opacity="0.85" />
                </svg>
            </span>
        );
    }
    const glyph = ICONS[tone];
    if (!glyph) return null;
    return (
        <span data-enigma-toast-icon="" data-tone={tone}>
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">{glyph}</svg>
        </span>
    );
}

export type ToastPosition =
    | "top-left" | "top-center" | "top-right"
    | "bottom-left" | "bottom-center" | "bottom-right";

export interface ToasterProps {
    /** Which queue to render. The shared one by default. */
    queue?: Notifications;
    position?: ToastPosition;
    /**
     * How long the exit animation lasts, in ms. The node stays mounted for exactly this
     * long after it leaves the queue - a toast that vanishes the instant it is dismissed
     * cannot animate out, and that is the only reason this component keeps its own list.
     */
    exitDuration?: number;
    /** Px a toast must travel before the release dismisses it. */
    swipeThreshold?: number;
    /** Render a toast yourself. The default renders title, body and the action. */
    children?: (notification: Notification, controls: ToastControls) => ReactNode;
    /** How many toasts are drawn at once. The rest wait behind them. Default 3. */
    visibleCount?: number;
    /** Fan the stack out permanently, instead of only while the pointer is on it. */
    expand?: boolean;
    /**
     * Inject the theme. On by default - see the note above; `false` leaves the markup
     * unstyled for your own stylesheet, and `@enigmax/primitives/toast.css` is the same
     * sheet if you would rather import it.
     */
    styles?: boolean;
    /** Accessible name for the region. */
    label?: string;
    className?: string;
    style?: CSSProperties;
}

export interface ToastControls {
    dismiss: () => void;
}

interface Rendered {
    notification: Notification;
    /** Set once it has left the queue and is animating out. */
    leaving: boolean;
}

/** Swipe follows the edge the stack is pinned to, so a toast never slides across the page. */
function swipeAxis(position: ToastPosition): { axis: "x" | "y"; sign: number; } {
    if (position.endsWith("-center")) return { axis: "y", sign: position.startsWith("top") ? -1 : 1 };
    return { axis: "x", sign: position.endsWith("-left") ? -1 : 1 };
}

export function Toaster({
    queue = defaultQueue,
    position = "bottom-right",
    exitDuration = 350,
    swipeThreshold = 60,
    visibleCount = VISIBLE,
    expand = false,
    styles: withStyles = true,
    children,
    label = "Notifications",
    className,
    style
}: ToasterProps): ReactNode {
    // Seeded from the queue rather than empty: a notify() that happened before this mounted
    // - during a redirect, or from a module that runs early - would otherwise be invisible
    // for a frame. On a server the queue is empty, so this still renders nothing there.
    const [rendered, setRendered] = useState<Rendered[]>(
        () => queue.items.map((notification) => ({ notification, leaving: false }))
    );
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    /** Fanned out: the pointer is on the stack, or focus is inside it. */
    const [hovered, setHovered] = useState(false);
    /** Measured per toast, because the fan-out offset is the SUM of the ones in front. */
    const [heights, setHeights] = useState<Record<string, number>>({});

    // Before paint, so the first frame of a new toast is already at its right offset. An
    // effect that ran after would show the stack settle into place.
    useLayoutEffect(() => { if (withStyles) injectStyles(); }, [withStyles]);

    useEffect(() => {
        const sync = (items: readonly Notification[]): void => {
            setRendered((current) => {
                const live = new Map(items.map((item) => [item.id, item]));
                const kept = current.map((entry) => {
                    const still = live.get(entry.notification.id);
                    if (still) return { notification: still, leaving: false };
                    if (entry.leaving) return entry;

                    // It has just left the queue: hold the node for the exit animation, and
                    // only then drop it. Without this the stack jumps.
                    const timer = setTimeout(() => {
                        timers.current.delete(entry.notification.id);
                        setRendered((later) => later.filter((row) => row.notification.id !== entry.notification.id));
                    }, exitDuration);
                    timers.current.set(entry.notification.id, timer);
                    return { ...entry, leaving: true };
                });

                const seen = new Set(kept.map((entry) => entry.notification.id));
                const added = items.filter((item) => !seen.has(item.id)).map((item) => ({ notification: item, leaving: false }));
                return [...kept, ...added];
            });
        };

        sync(queue.items);
        return queue.subscribe(sync);
    }, [queue, exitDuration]);

    // Clearing on unmount only: a timer per exiting toast is cheap, and clearing them on
    // every render would cancel the exit that is currently running.
    useEffect(() => {
        const pending = timers.current;
        return () => {
            for (const timer of pending.values()) clearTimeout(timer);
            pending.clear();
        };
    }, []);

    if (!rendered.length) return null;

    const expanded = expand || hovered;
    // Newest first: index 0 is the front toast, and everything below is measured against it.
    const stack = [...rendered].reverse();
    const frontHeight = heights[stack[0]?.notification.id ?? ""] ?? 0;

    return (
        <section
            aria-label={label}
            data-enigma-toaster=""
            data-position={position}
            data-expanded={expanded ? "" : undefined}
            style={{ ...style, "--enigma-toast-front-height": `${frontHeight}px` } as CSSProperties}
            className={className}
            // A pointer resting on the stack stops every clock, so a message cannot expire
            // while it is being read, and fans it out so every one of them is readable.
            // Focus counts too, for anyone using a keyboard.
            onPointerEnter={() => { queue.pause(); setHovered(true); }}
            onPointerLeave={() => { queue.resume(); setHovered(false); }}
            onFocusCapture={() => { queue.pause(); setHovered(true); }}
            onBlurCapture={() => { queue.resume(); setHovered(false); }}
        >
            {stack.map((entry, index) => (
                <Toast
                    key={entry.notification.id}
                    entry={entry}
                    index={index}
                    hidden={index >= visibleCount}
                    // The summed height of everything in front of it, plus one gap each -
                    // which is what makes an expanded stack a list rather than a pile.
                    offset={stack.slice(0, index).reduce((total, row) => total + (heights[row.notification.id] ?? 0) + 14, 0)}
                    onMeasure={(height) => setHeights((current) => (
                        current[entry.notification.id] === height
                            ? current
                            : { ...current, [entry.notification.id]: height }
                    ))}
                    position={position}
                    swipeThreshold={swipeThreshold}
                    onDismiss={() => queue.dismiss(entry.notification.id)}
                    render={children}
                />
            ))}
        </section>
    );
}

interface ToastProps {
    entry: Rendered;
    /** 0 is the front of the stack. Drives the offset and scale in the theme. */
    index: number;
    /** Past the visible count: still counted and still measured, just not drawn. */
    hidden: boolean;
    /** Px to lift it by when the stack is fanned out. */
    offset: number;
    /** Reports its own height, which is what every offset behind it is computed from. */
    onMeasure: (height: number) => void;
    position: ToastPosition;
    swipeThreshold: number;
    onDismiss: () => void;
    render?: (notification: Notification, controls: ToastControls) => ReactNode;
}

function Toast({ entry, index, hidden, offset: stackOffset, onMeasure, position, swipeThreshold, onDismiss, render }: ToastProps): ReactNode {
    const { notification, leaving } = entry;
    const [offset, setOffset] = useState(0);
    const [swiping, setSwiping] = useState(false);
    /** Off for the first frame, so the enter animation has somewhere to come from. */
    const [mounted, setMounted] = useState(false);
    const node = useRef<HTMLElement | null>(null);
    const start = useRef(0);
    const { axis, sign } = swipeAxis(position);

    // Measured, not assumed: a toast is as tall as its text, and the offsets behind it are
    // the sum of those heights. A ResizeObserver rather than one reading, because a body
    // that wraps differently after a font loads changes every offset behind it.
    useLayoutEffect(() => {
        const element = node.current;
        if (!element) return;
        const report = (): void => onMeasure(element.getBoundingClientRect().height);
        report();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [notification.title, notification.body]);

    // One frame later: setting it in the same commit as the mount would give the browser no
    // "before" to animate from, and the toast would appear rather than arrive.
    useEffect(() => {
        const frame = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
        // Not on the buttons: a press on "Undo" is a press, not the start of a drag.
        if ((event.target as HTMLElement).closest("button")) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        start.current = axis === "x" ? event.clientX : event.clientY;
        setSwiping(true);
    }, [axis]);

    const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (!swiping) return;
        const delta = (axis === "x" ? event.clientX : event.clientY) - start.current;
        // Only towards the edge it is pinned to. Dragging the other way does nothing, so a
        // scroll or a misread gesture cannot pull the toast into the middle of the page.
        setOffset(sign > 0 ? Math.max(0, delta) : Math.min(0, delta));
    }, [swiping, axis, sign]);

    const onPointerUp = useCallback(() => {
        if (!swiping) return;
        setSwiping(false);
        if (Math.abs(offset) >= swipeThreshold) {
            onDismiss();
            return;
        }
        setOffset(0);   // Under the threshold it springs back, so nothing is lost by accident.
    }, [swiping, offset, swipeThreshold, onDismiss]);

    const controls: ToastControls = { dismiss: onDismiss };

    return (
        <article
            ref={(element) => { node.current = element; }}
            data-enigma-toast=""
            data-tone={notification.tone}
            data-state={leaving ? "leaving" : "open"}
            data-index={index}
            data-front={index === 0 ? "" : undefined}
            data-mounted={mounted && !leaving ? "" : undefined}
            data-hidden={hidden ? "" : undefined}
            data-swiping={swiping ? "" : undefined}
            // An error interrupts; anything else waits its turn rather than talking over
            // whatever a screen reader is in the middle of.
            role={notification.tone === "error" ? "alert" : "status"}
            aria-live={notification.tone === "error" ? "assertive" : "polite"}
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === "Escape") onDismiss(); }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
                // Read by the theme, so every transform stays the stylesheet's decision.
                "--enigma-toast-swipe": `${offset}px`,
                "--enigma-toast-index": index,
                "--enigma-toast-before": index,
                "--enigma-toast-offset": `${stackOffset}px`,
                // The front toast is on top, and each one behind it a layer lower.
                "--enigma-toast-z": 100 - index
            } as CSSProperties}
        >
            {render
                ? render(notification, controls)
                : (
                    <>
                        <ToneIcon tone={notification.tone} />
                        <span data-enigma-toast-content="">
                            <p data-enigma-toast-title="">{notification.title}</p>
                            {notification.body && <p data-enigma-toast-body="">{notification.body}</p>}
                        </span>
                        {notification.action && (
                            <button
                                type="button"
                                data-enigma-toast-action=""
                                onClick={() => {
                                    notification.action?.onSelect();
                                    if (notification.action?.dismiss !== false) onDismiss();
                                }}
                            >{notification.action.label}</button>
                        )}
                        <button type="button" data-enigma-toast-close="" aria-label="Dismiss" onClick={onDismiss}>
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </>
                )}
        </article>
    );
}

/**
 * The queue, from the entry that renders it.
 *
 * `@enigmax/primitives/react/toast` is where somebody looks for both halves - mounting the
 * stack and telling it something - and sending them to a second subpath for the second half
 * is the kind of split that makes an import line something to look up. It costs nothing:
 * the toaster already holds the queue.
 */
export { useNotifications, createNotificationQueue, defaultQueue } from "@/react/use-notifications";
export type { Notification, NotificationInput, NotificationTone, NotificationAction, Notifications } from "@/core/notifications";
