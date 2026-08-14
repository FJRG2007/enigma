"use client";

import { Toaster, type ToastPosition } from "@enigmax/primitives/react";

/**
 * Ember, in Tailwind. Yours to edit.
 *
 * The stack, the gestures and the exit hold come from `<Toaster />`; everything below is a
 * class. The one thing Tailwind cannot express is the swipe offset - it is a live number
 * from the pointer, published as `--enigma-toast-swipe` - so the arbitrary translate below
 * reads that variable rather than trying to enumerate positions.
 */

const TONE = {
    info: "before:bg-blue-400",
    success: "before:bg-green-400",
    warning: "before:bg-amber-400",
    error: "before:bg-red-400",
    loading: "before:bg-neutral-500"
} as const;

export function AppToaster({ position = "bottom-right" }: { position?: ToastPosition; }) {
    return (
        <Toaster
            position={position}
            className="fixed z-[9999] flex w-[min(22rem,calc(100vw-2.5rem))] flex-col gap-2.5 data-[position^=top]:top-5 data-[position^=top]:flex-col-reverse data-[position^=bottom]:bottom-5 data-[position$=-left]:left-5 data-[position$=-right]:right-5 data-[position$=-center]:left-1/2 data-[position$=-center]:-translate-x-1/2 pointer-events-none"
        >
            {(notification, controls) => (
                <div
                    className={[
                        "pointer-events-auto relative grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-xl border p-4",
                        "border-neutral-800 bg-neutral-950 text-neutral-100 shadow-[0_8px_30px_rgb(0_0_0/45%)]",
                        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:rounded-l-xl",
                        // Tracks the finger exactly while a swipe is in progress.
                        "translate-x-[var(--enigma-toast-swipe,0)] transition-transform duration-200 ease-out data-[swiping]:transition-none",
                        TONE[notification.tone]
                    ].join(" ")}
                >
                    <p className="col-start-1 m-0 text-sm font-semibold leading-snug">{notification.title}</p>
                    {notification.body && <p className="col-start-1 m-0 text-[13px] leading-relaxed text-neutral-400">{notification.body}</p>}

                    {notification.action && (
                        <button
                            type="button"
                            className="col-start-2 row-span-full rounded-md bg-neutral-100 px-2.5 py-1.5 text-xs font-semibold text-neutral-950"
                            onClick={() => {
                                notification.action?.onSelect();
                                if (notification.action?.dismiss !== false) controls.dismiss();
                            }}
                        >{notification.action.label}</button>
                    )}

                    {/* Opacity rather than hidden: it must stay reachable by keyboard. */}
                    <button
                        type="button"
                        aria-label="Dismiss"
                        className="absolute right-2 top-1.5 px-1 text-sm leading-none text-neutral-400 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={controls.dismiss}
                    >&times;</button>
                </div>
            )}
        </Toaster>
    );
}
