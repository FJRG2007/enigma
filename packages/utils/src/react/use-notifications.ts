import { useRef, useMemo, useSyncExternalStore } from "react";
import { createNotifications, type Notifications, type Notification, type NotificationsOptions } from "@/core/notifications";

/** One queue per app by default; a second one would race the first for the corner. */
const defaultQueue = createNotifications();

export interface UseNotificationsResult extends Pick<Notifications, "notify" | "dismiss" | "dismissAll" | "pause" | "resume"> {
    items: readonly Notification[];
}

/**
 * Subscribe to a notification queue.
 *
 * Rendering is yours: this returns the list, the ordering and the timers, and
 * nothing about how a notification looks.
 */
export function useNotifications(queue: Notifications = defaultQueue): UseNotificationsResult {
    const snapshot = useRef<readonly Notification[]>(queue.items);

    const items = useSyncExternalStore(
        listener => queue.subscribe(next => {
            snapshot.current = next;
            listener();
        }),
        () => snapshot.current,
        () => snapshot.current
    );

    return useMemo(() => ({
        items,
        notify: queue.notify,
        dismiss: queue.dismiss,
        dismissAll: queue.dismissAll,
        pause: queue.pause,
        resume: queue.resume
    }), [items, queue]);
}

export function createNotificationQueue(options?: NotificationsOptions): Notifications {
    return createNotifications(options);
}

export { defaultQueue };
