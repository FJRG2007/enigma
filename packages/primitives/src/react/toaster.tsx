"use client";

import { TOAST_STYLES } from "@/react/toast/styles";
import { defaultQueue } from "@/react/use-notifications";
import { toast as vendorToast } from "@/react/toast/state";
import { Toaster as VendorToaster } from "@/react/toast/index";
import type { Notification, Notifications } from "@/core/notifications";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ToasterProps as VendorToasterProps } from "@/react/toast/types";

/**
 * `<Toaster />` - the toast stack, and the one component in this package that ships a look.
 *
 * The implementation under `react/toast/` is vendored and deliberately unedited: it is the
 * toast these projects already use, and a second one that merely resembled it would be a
 * different thing on every screen. Two mechanical changes were unavoidable to make it a
 * library - the `cn` helper became a local file rather than a path alias, and the
 * `import "./styles.css"` became the injection below, because a package cannot assume its
 * consumer has a CSS-capable bundler.
 *
 * WHY IT SHIPS STYLES. Everywhere else here a missing stylesheet gives you an unstyled
 * component you can see and fix. A toast renders at the edge of the screen, stacked and
 * animated, so the same omission gives you a pile of text in a corner - and "remember to
 * import the CSS" is a footgun for something that appears once every few minutes. The sheet
 * is injected once and PREPENDED to `<head>`, so anything the document already has outranks
 * it by source order without a single `!important`; `styles={false}` turns it off, and
 * `@enigmax/primitives/toast.css` is the same sheet for anyone who prefers the import.
 */

let injected = false;

function injectStyles(): void {
    if (injected || typeof document === "undefined") return;
    injected = true;
    if (document.querySelector("[data-enigma-toast-styles]")) return;
    const element = document.createElement("style");
    element.setAttribute("data-enigma-toast-styles", "");
    element.textContent = TOAST_STYLES;
    document.head.prepend(element);
}

export interface ToasterProps extends VendorToasterProps {
    /**
     * Inject the stylesheet. On by default - see the note above. `false` leaves the markup
     * bare for a theme of your own.
     */
    styles?: boolean;
    /**
     * A notification QUEUE to render, alongside anything raised with `toast()`.
     *
     * This is the bridge for `useNotifications().notify()`, which predates the vendored
     * component: everything already written against the queue keeps working, and both APIs
     * end up in one stack rather than in two competing ones. `null` unsubscribes.
     */
    queue?: Notifications | null;
}

export function Toaster({ styles = true, queue = defaultQueue, ...props }: ToasterProps): ReactNode {
    // Before paint: a sheet applied after the first frame shows the toast unstyled first.
    useLayoutEffect(() => { if (styles) injectStyles(); }, [styles]);

    /** Queue id -> the toast raised for it, so a dismissal reaches the right one. */
    const forwarded = useRef(new Map<string, string | number>());

    useEffect(() => {
        if (!queue) return;
        const sync = (items: readonly Notification[]): void => {
            const live = new Set(items.map((item) => item.id));

            for (const item of items) {
                if (forwarded.current.has(item.id)) continue;
                forwarded.current.set(item.id, raise(item));
            }
            // Dismissed in the queue is dismissed on screen: the queue owns its own timers,
            // and a toast that outlived the item behind it would be showing a state that no
            // longer exists.
            for (const [id, toastId] of forwarded.current) {
                if (live.has(id)) continue;
                vendorToast.dismiss(toastId);
                forwarded.current.delete(id);
            }
        };

        sync(queue.items);
        return queue.subscribe(sync);
    }, [queue]);

    return <VendorToaster {...props} />;
}

/** One queue item, as the vendored toast API expects it. */
function raise(item: Notification): string | number {
    const options = {
        description: item.body,
        // The queue already counts down and removes the item; leaving the toast's own timer
        // running as well would race it, and the shorter of the two would win at random.
        duration: Infinity,
        action: item.action
            ? { label: item.action.label, onClick: () => item.action?.onSelect() }
            : undefined
    };

    switch (item.tone) {
        case "success": return vendorToast.success(item.title, options);
        case "error": return vendorToast.error(item.title, options);
        case "warning": return vendorToast.warning(item.title, options);
        case "info": return vendorToast.info(item.title, options);
        case "loading": return vendorToast.loading(item.title, options);
        default: return vendorToast(item.title, options);
    }
}

/** The vendored API, which is the direct way to raise one. */
export { toast } from "@/react/toast/state";
export { useSonner } from "@/react/toast/index";
export type { ToastT, ExternalToast, ToastClassnames, Action } from "@/react/toast/types";

/**
 * The queue, from the entry that renders it.
 *
 * `@enigmax/primitives/react/toast` is where somebody looks for both halves - mounting the
 * stack and telling it something - and sending them to a second subpath for the second half
 * is the kind of split that makes an import line something to look up.
 */
export { useNotifications, createNotificationQueue, defaultQueue } from "@/react/use-notifications";
export type { Notification, NotificationInput, NotificationTone, NotificationAction, Notifications } from "@/core/notifications";
