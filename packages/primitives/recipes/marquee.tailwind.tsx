import type { ReactNode, Ref } from "react";
import { useMarquee } from "@enigmax/primitives/react";

/**
 * A styled marquee, yours to edit.
 *
 * The behaviour comes from the primitive, which ships no styles at all; every class
 * below is a suggestion you are meant to change.
 *
 * TAILWIND v4 WARNING: never put a `translate-*` utility on the track. v4 writes those
 * to the CSS `translate` property, which COMPOSES with `transform` rather than replacing
 * it, so the class and the engine's transform add up and the row drifts. Anything you
 * need to offset goes on the lane or on an inner element, never on the moved one.
 */
export interface MarqueeProps<T> {
    items: T[];
    /** Pixels per second. Never a duration - the row would speed up as items are added. */
    speed?: number;
    /** Speed multiplier while a mouse rests on the row. 0 pauses it. */
    hoverScale?: number;
    reverse?: boolean;
    /** Fade both ends so items enter and leave instead of being cut. */
    fade?: boolean;
    className?: string;
    children: (item: T, index: number) => ReactNode;
}

export function Marquee<T>({
    items,
    speed = 70,
    hoverScale = 1,
    reverse = false,
    fade = true,
    className = "",
    children
}: MarqueeProps<T>) {
    const { laneRef, trackRef, copies, dragging } = useMarquee({ speed, hoverScale, reverse });

    return (
        <div
            ref={laneRef as Ref<HTMLDivElement>}
            className={[
                "relative w-full",
                dragging ? "cursor-grabbing" : "cursor-grab",
                fade ? "[mask-image:linear-gradient(90deg,transparent,#000_6%,#000_94%,transparent)]" : "",
                className
            ].filter(Boolean).join(" ")}
        >
            {/* No translate-* utility here. See the note at the top of this file. */}
            <div ref={trackRef as Ref<HTMLDivElement>} className="flex">
                {Array.from({ length: copies }, (_, copy) => (
                    <div key={copy} aria-hidden={copy > 0} className="flex shrink-0 items-center gap-10 pr-10">
                        {items.map((item, index) => (
                            <div key={index} className="shrink-0">{children(item, index)}</div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
