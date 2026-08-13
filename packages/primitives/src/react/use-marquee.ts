import { useRef, useState, useEffect, useLayoutEffect, type RefObject } from "react";
import { createMarquee, type MarqueeOptions, type MarqueeInstance } from "@/core/marquee";

/** useLayoutEffect warns on the server; the copy count still has to land before first paint. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface UseMarqueeResult {
    /** Attach to the clipping viewport. */
    laneRef: RefObject<HTMLElement | null>;
    /** Attach to the moved element. Render `copies` children into it. */
    trackRef: RefObject<HTMLElement | null>;
    /**
     * How many times to render the content. Starts at 2 so the server-rendered
     * HTML stays small, then grows to cover the lane plus one whole period.
     */
    copies: number;
    /** True while the row is being grabbed. Useful for a `cursor: grabbing`. */
    dragging: boolean;
    /** Measured distance between two copies, in px. 0 before the first measure. */
    period: number;
    /** Re-read the lap from the DOM. Call after changing the content yourself. */
    measure: () => void;
}

/**
 * Drive a draggable infinite marquee from React.
 *
 * `speed` is pixels per second and never a duration: a duration ties the speed
 * to the item count, so the row accelerates every time content is added.
 *
 * ```tsx
 * const { laneRef, trackRef, copies } = useMarquee({ speed: 80, hoverScale: 0.15 });
 * return (
 *     <div ref={laneRef}>
 *         <div ref={trackRef} style={{ display: "flex" }}>
 *             {Array.from({ length: copies }, (_, copy) => (
 *                 <div key={copy} aria-hidden={copy > 0} style={{ display: "flex", gap: 32 }}>
 *                     {items.map(item => <Logo key={item.id} {...item} />)}
 *                 </div>
 *             ))}
 *         </div>
 *     </div>
 * );
 * ```
 */
export function useMarquee(options: MarqueeOptions = {}): UseMarqueeResult {
    const laneRef = useRef<HTMLElement | null>(null);
    const trackRef = useRef<HTMLElement | null>(null);
    const instanceRef = useRef<MarqueeInstance | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const [copies, setCopies] = useState(2);
    const [dragging, setDragging] = useState(false);
    const [period, setPeriod] = useState(0);

    useIsomorphicLayoutEffect(() => {
        const lane = laneRef.current;
        const track = trackRef.current;
        if (!lane || !track) return;

        const instance = createMarquee(lane, track, {
            ...optionsRef.current,
            // React owns the DOM; cloning behind its back would be undone on render.
            copies: "external",
            onCopyCountChange: setCopies,
            onMeasure: measured => setPeriod(measured),
            onItemClick: event => optionsRef.current.onItemClick?.(event)
        });
        instanceRef.current = instance;

        const syncDragging = () => setDragging(instance.dragging);
        lane.addEventListener("pointerdown", syncDragging);
        window.addEventListener("pointerup", syncDragging);
        window.addEventListener("pointercancel", syncDragging);

        return () => {
            lane.removeEventListener("pointerdown", syncDragging);
            window.removeEventListener("pointerup", syncDragging);
            window.removeEventListener("pointercancel", syncDragging);
            instance.destroy();
            instanceRef.current = null;
        };
        // The instance is created once; option changes go through update() below,
        // because recreating it would restart the row on every render.
    }, []);

    useIsomorphicLayoutEffect(() => {
        instanceRef.current?.update(options);
    }, [options.speed, options.reverse, options.vertical, options.draggable, options.hoverScale, options.decay]);

    // A copy count change means new children; the lap has to be read again.
    useIsomorphicLayoutEffect(() => {
        instanceRef.current?.measure();
    }, [copies]);

    return {
        laneRef,
        trackRef,
        copies,
        dragging,
        period,
        measure: () => instanceRef.current?.measure()
    };
}
