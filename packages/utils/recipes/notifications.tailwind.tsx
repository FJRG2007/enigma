import { useNotifications } from "@enigmax/utils/react";

/**
 * A styled notification stack, yours to edit.
 *
 * Ordering, dedupe by key, sticky errors and the dismiss timers all come from the
 * queue. Hovering pauses those timers, which is the whole reason `pause`/`resume` are
 * wired to the pointer here.
 *
 * Fire one from anywhere:
 *   import { defaultQueue } from "@enigmax/utils/react";
 *   defaultQueue.notify({ title: "Saved", tone: "success" });
 */
const TONE = {
    info: "border-l-neutral-500",
    success: "border-l-emerald-500",
    warning: "border-l-amber-500",
    error: "border-l-red-500"
} as const;

export function Notifications() {
    const { items, dismiss, pause, resume } = useNotifications();

    if (!items.length) return null;

    return (
        <div
            className="fixed bottom-4 right-4 z-50 grid w-[min(22rem,calc(100vw-2rem))] gap-2"
            role="region"
            aria-label="Notifications"
            onPointerEnter={pause}
            onPointerLeave={resume}
        >
            {items.map((item) => (
                <div
                    key={item.id}
                    role={item.tone === "error" ? "alert" : "status"}
                    className={`
                        flex items-start gap-3 rounded-xl border border-l-[3px] border-neutral-800
                        bg-neutral-900 px-3.5 py-3 shadow-lg ${TONE[item.tone]}
                    `}
                >
                    <div className="min-w-0 flex-1">
                        <p className="text-sm text-neutral-100">{item.title}</p>
                        {item.body && <p className="mt-0.5 text-xs text-neutral-400">{item.body}</p>}
                    </div>
                    <button
                        type="button"
                        onClick={() => dismiss(item.id)}
                        aria-label={`Dismiss ${item.title}`}
                        title="Dismiss"
                        className="rounded-md px-1 text-neutral-500 hover:text-neutral-100"
                    >
                        &times;
                    </button>
                </div>
            ))}
        </div>
    );
}
