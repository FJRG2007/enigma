/**
 * Notification queue: ordering, timers, dedupe and pause. No rendering, no styles.
 *
 * The timer is the part that is always wrong when hand-rolled. A dismiss timer
 * that keeps counting while the tab is hidden fires the moment the visitor comes
 * back and they never see the message, so the remaining time is held, not run.
 */

export type NotificationTone = "info" | "success" | "warning" | "error";

export interface NotificationInput {
    /** Reuses the slot of a live notification with the same key instead of stacking. */
    key?: string;
    title: string;
    body?: string;
    tone?: NotificationTone;
    /** ms before it dismisses itself. 0 or Infinity keeps it until dismissed. */
    duration?: number;
    /** Arbitrary payload for the renderer: an action label, an href, an icon name. */
    data?: unknown;
}

export interface Notification extends Required<Omit<NotificationInput, "body" | "data" | "key">> {
    id: string;
    key?: string;
    body?: string;
    data?: unknown;
    createdAt: number;
}

export interface NotificationsOptions {
    /** Live notifications kept at once. The oldest dismissable one makes room. */
    max?: number;
    /** Default ms before self-dismissal. */
    duration?: number;
    /** Errors default to staying until dismissed. */
    stickyTones?: NotificationTone[];
}

export interface Notifications {
    readonly items: readonly Notification[];
    notify(input: NotificationInput): string;
    dismiss(id: string): void;
    dismissAll(): void;
    /** Hold every timer, e.g. while a pointer rests on the stack. */
    pause(): void;
    resume(): void;
    subscribe(listener: (items: readonly Notification[]) => void): () => void;
    destroy(): void;
}

const DEFAULT_MAX = 4;
const DEFAULT_DURATION = 5000;

export function createNotifications(options: NotificationsOptions = {}): Notifications {
    // Null outside a browser: the queue has to survive a server render untouched.
    const view = typeof document === "undefined" ? null : document;
    const max = options.max ?? DEFAULT_MAX;
    const defaultDuration = options.duration ?? DEFAULT_DURATION;
    const sticky = new Set<NotificationTone>(options.stickyTones ?? ["error"]);

    let items: Notification[] = [];
    let paused = false;
    let sequence = 0;
    const listeners = new Set<(items: readonly Notification[]) => void>();
    const timers = new Map<string, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number; }>();

    function emit(): void {
        const snapshot = Object.freeze([...items]);
        for (const listener of listeners) listener(snapshot);
    }

    function clearTimer(id: string): void {
        const timer = timers.get(id);
        if (timer?.handle) clearTimeout(timer.handle);
        timers.delete(id);
    }

    function startTimer(id: string, remaining: number): void {
        if (!Number.isFinite(remaining) || remaining <= 0) return;
        const handle = paused ? null : setTimeout(() => dismiss(id), remaining);
        timers.set(id, { handle, remaining, startedAt: Date.now() });
    }

    function dismiss(id: string): void {
        const next = items.filter(item => item.id !== id);
        if (next.length === items.length) return;
        items = next;
        clearTimer(id);
        emit();
    }

    function notify(input: NotificationInput): string {
        const tone = input.tone ?? "info";
        const duration = input.duration ?? (sticky.has(tone) ? Infinity : defaultDuration);

        // A repeated key replaces in place, so a retry loop does not build a wall.
        const existing = input.key ? items.find(item => item.key === input.key) : undefined;
        const id = existing?.id ?? `n${++sequence}`;
        const notification: Notification = {
            id,
            key: input.key,
            title: input.title,
            body: input.body,
            tone,
            duration,
            data: input.data,
            createdAt: Date.now()
        };

        items = existing
            ? items.map(item => (item.id === id ? notification : item))
            : [...items, notification];

        if (items.length > max) {
            // Never silently drop something that has no timer of its own.
            const evictable = items.find(item => Number.isFinite(item.duration) && item.id !== id);
            if (evictable) {
                items = items.filter(item => item.id !== evictable.id);
                clearTimer(evictable.id);
            } else {
                items = items.slice(items.length - max);
            }
        }

        clearTimer(id);
        startTimer(id, duration);
        emit();
        return id;
    }

    const onVisibility = (): void => {
        if (!view) return;
        // A hidden tab must not burn a notification nobody could read.
        if (view.hidden) instance.pause();
        else instance.resume();
    };

    const instance: Notifications = {
        get items() { return Object.freeze([...items]); },
        notify,
        dismiss,
        dismissAll(): void {
            for (const item of items) clearTimer(item.id);
            items = [];
            emit();
        },
        pause(): void {
            if (paused) return;
            paused = true;
            for (const [id, timer] of timers) {
                if (!timer.handle) continue;
                clearTimeout(timer.handle);
                timers.set(id, {
                    handle: null,
                    remaining: Math.max(timer.remaining - (Date.now() - timer.startedAt), 0),
                    startedAt: Date.now()
                });
            }
        },
        resume(): void {
            if (!paused) return;
            paused = false;
            for (const [id, timer] of [...timers]) {
                clearTimer(id);
                startTimer(id, timer.remaining);
            }
        },
        subscribe(listener): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        destroy(): void {
            for (const item of items) clearTimer(item.id);
            items = [];
            listeners.clear();
            view?.removeEventListener("visibilitychange", onVisibility);
        }
    };

    view?.addEventListener("visibilitychange", onVisibility);
    return instance;
}
