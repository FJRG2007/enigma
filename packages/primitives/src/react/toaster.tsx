"use client";

import { defaultQueue } from "@/react/use-notifications";
import type { Notification, Notifications } from "@/core/notifications";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * `<Toaster />` - the stack, the movement and the gestures. No colours.
 *
 * The queue underneath already owns ordering, dedupe by key, sticky errors and timers that
 * HOLD while the tab is hidden. What this adds is everything you cannot express in a queue:
 * a toast that is on its way out is still on screen, a pointer resting on the stack must
 * stop the clock, and a swipe has to follow the finger before it decides anything.
 *
 * Every part carries a data attribute, so the theme is a stylesheet you own. `enigma add
 * toast --copy` writes one.
 */

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
    exitDuration = 200,
    swipeThreshold = 60,
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

    return (
        <section
            aria-label={label}
            data-enigma-toaster=""
            data-position={position}
            className={className}
            style={style}
            // A pointer resting on the stack stops every clock, so a message cannot expire
            // while it is being read. Focus counts too, for anyone using a keyboard.
            onPointerEnter={() => queue.pause()}
            onPointerLeave={() => queue.resume()}
            onFocusCapture={() => queue.pause()}
            onBlurCapture={() => queue.resume()}
        >
            {rendered.map((entry, index) => (
                <Toast
                    key={entry.notification.id}
                    entry={entry}
                    index={rendered.length - 1 - index}
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
    position: ToastPosition;
    swipeThreshold: number;
    onDismiss: () => void;
    render?: (notification: Notification, controls: ToastControls) => ReactNode;
}

function Toast({ entry, index, position, swipeThreshold, onDismiss, render }: ToastProps): ReactNode {
    const { notification, leaving } = entry;
    const [offset, setOffset] = useState(0);
    const [swiping, setSwiping] = useState(false);
    const start = useRef(0);
    const { axis, sign } = swipeAxis(position);

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
            data-enigma-toast=""
            data-tone={notification.tone}
            data-state={leaving ? "leaving" : "open"}
            data-index={index}
            data-front={index === 0 ? "" : undefined}
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
                // Read by the theme, so the transform stays the stylesheet's decision.
                "--enigma-toast-swipe": `${offset}px`,
                "--enigma-toast-index": index
            } as CSSProperties}
        >
            {render
                ? render(notification, controls)
                : (
                    <>
                        <p data-enigma-toast-title="">{notification.title}</p>
                        {notification.body && <p data-enigma-toast-body="">{notification.body}</p>}
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
                        <button type="button" data-enigma-toast-close="" aria-label="Dismiss" onClick={onDismiss}>&times;</button>
                    </>
                )}
        </article>
    );
}
