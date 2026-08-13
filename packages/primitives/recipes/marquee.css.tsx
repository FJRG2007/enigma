import "./marquee.css";
import type { ReactNode, Ref } from "react";
import { useMarquee, type MarqueeHover } from "@enigmax/primitives/react";

/**
 * A styled marquee, yours to edit.
 *
 * The behaviour comes from the primitive, which ships no styles at all; marquee.css
 * beside this file is a starting point you are meant to change.
 */
export interface MarqueeProps<T> {
    items: T[];
    /** Pixels per second. Never a duration - the row would speed up as items are added. */
    speed?: number;
    /**
     * What a mouse resting on the row does to its speed:
     * "off" ignores hover, "pause" stops, a number multiplies the cruise speed
     * (0.15 crawls, 2 doubles), { speed } sets an absolute px/s.
     */
    hover?: MarqueeHover;
    reverse?: boolean;
    /** Fade both ends so items enter and leave instead of being cut. */
    fade?: boolean;
    className?: string;
    children: (item: T, index: number) => ReactNode;
}

export function Marquee<T>({
    items,
    speed = 70,
    hover = "off",
    reverse = false,
    fade = true,
    className = "",
    children
}: MarqueeProps<T>) {
    const { laneRef, trackRef, copies, dragging } = useMarquee({ speed, hover, reverse });

    return (
        <div
            ref={laneRef as Ref<HTMLDivElement>}
            className={["enigma-marquee", fade ? "is-faded" : "", className].filter(Boolean).join(" ")}
            data-grabbing={dragging ? "" : undefined}
        >
            <div ref={trackRef as Ref<HTMLDivElement>} className="enigma-marquee__track">
                {Array.from({ length: copies }, (_, copy) => (
                    <div key={copy} aria-hidden={copy > 0} className="enigma-marquee__copy">
                        {items.map((item, index) => (
                            <div key={index} className="enigma-marquee__item">{children(item, index)}</div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
