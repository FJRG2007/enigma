/**
 * Draggable infinite marquee: the behaviour engine, with no styling of its own.
 *
 * The contract is a SPEED in pixels per second, never a duration. A lap of a
 * looping row is as long as its content, so a duration makes the row run faster
 * every time an item is added to it. See the package README.
 *
 * Every rule encoded here was measured in a browser, not reasoned about. The
 * comments marked "non-negotiable" name the bug that the obvious implementation
 * shipped with.
 */

/** Fraction of the remaining gap left after one second. 0.12 flicks, 0.35 drags. */
const DEFAULT_DECAY = 0.12;
/** Pointer travel past which a press stops being a click and becomes a drag. */
const DRAG_THRESHOLD = 6;
/** A pointer that has not moved for this long throws nothing on release. */
const STILL_MS = 90;
/** A backgrounded tab hands back one enormous delta; clamp it or the row teleports. */
const MAX_DT = 0.05;
/** One jittery frame must not decide the throw. */
const VELOCITY_SMOOTHING = 0.6;
/** Below this the row is idle and the frame loop can stop. */
const IDLE_EPSILON = 0.01;

export interface MarqueeOptions {
    /**
     * Pixels per second. NOT a duration: a duration ties the speed to the item
     * count and the row silently accelerates as content grows.
     */
    speed?: number;
    /** Scroll towards the start instead of the end. */
    reverse?: boolean;
    /** Scroll on the Y axis instead of the X axis. */
    vertical?: boolean;
    /** Allow grabbing and throwing the row. */
    draggable?: boolean;
    /** Speed multiplier while a MOUSE rests on the row. 0 pauses it. */
    hoverScale?: number;
    /** Fraction of the remaining velocity gap left after one second. */
    decay?: number;
    /**
     * Apply the styles the behaviour needs (overflow, touch-action, user-select,
     * will-change, transform). Never theme styles. Turn off to own them yourself.
     */
    manageStyles?: boolean;
    /**
     * How the repeated copies get into the DOM.
     * - "clone": the engine clones the first child of the track (vanilla, Astro).
     * - "external": the consumer renders them and is told the count (React, Vue).
     */
    copies?: "clone" | "external";
    /** Called when the required copy count changes. Required for "external". */
    onCopyCountChange?: (count: number) => void;
    /** Called on a click that was not the end of a drag. */
    onItemClick?: (event: MouseEvent) => void;
    /** Called whenever the measured lap period changes. */
    onMeasure?: (period: number, copyCount: number) => void;
}

export interface MarqueeInstance {
    /** Current offset in px, normalized to [0, period). */
    readonly offset: number;
    /** Measured distance between two copies of the content, in px. */
    readonly period: number;
    /** Copies currently required to cover the lane plus one whole period. */
    readonly copyCount: number;
    /** True between pointerdown and pointerup while the row is being grabbed. */
    readonly dragging: boolean;
    /** True while the OS asks for reduced motion. Autoplay stops, drag does not. */
    readonly reducedMotion: boolean;
    update(options: Partial<MarqueeOptions>): void;
    /** Re-read the lap from the DOM. Called for you on resize and on font load. */
    measure(): void;
    pause(): void;
    resume(): void;
    destroy(): void;
}

interface ResolvedOptions extends Required<Omit<MarqueeOptions, "onCopyCountChange" | "onItemClick" | "onMeasure">> {
    onCopyCountChange?: (count: number) => void;
    onItemClick?: (event: MouseEvent) => void;
    onMeasure?: (period: number, copyCount: number) => void;
}

const DEFAULTS: ResolvedOptions = {
    speed: 60,
    reverse: false,
    vertical: false,
    draggable: true,
    hoverScale: 1,
    decay: DEFAULT_DECAY,
    manageStyles: true,
    copies: "clone"
};

/**
 * Wire a lane and its track into a draggable infinite marquee.
 *
 * @param lane  The clipping viewport. Receives the pointer and the click guard.
 * @param track The moved element. Its children are the repeated copies; child 0
 *              is the source content and must already be rendered.
 */
export function createMarquee(lane: HTMLElement, track: HTMLElement, options: MarqueeOptions = {}): MarqueeInstance {
    let opts: ResolvedOptions = { ...DEFAULTS, ...options };

    let period = 0;
    let copyCount = Math.max(2, track.children.length);
    let offset = 0;
    let velocity = 0;
    let running = false;
    let paused = false;
    let destroyed = false;
    let frame = 0;
    let lastTime = 0;

    let dragging = false;
    let pointerId: number | null = null;
    let lastPointer = 0;
    let startPointer = 0;
    let lastMoveTime = 0;
    let maxTravel = 0;
    let hovering = false;

    const motionQuery = typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    let reducedMotion = motionQuery?.matches ?? false;

    /** Read live every frame, never captured: cruise, hover and reduced motion all ease. */
    function target(): number {
        if (reducedMotion || paused) return 0;
        const cruise = opts.reverse ? -opts.speed : opts.speed;
        return hovering ? cruise * opts.hoverScale : cruise;
    }

    function axisSize(element: HTMLElement): number {
        return opts.vertical ? element.offsetHeight : element.offsetWidth;
    }

    function axisStart(element: HTMLElement): number {
        return opts.vertical ? element.offsetTop : element.offsetLeft;
    }

    function applyStyles(): void {
        if (!opts.manageStyles) return;
        lane.style.overflow = "hidden";
        // Non-negotiable 6: "none" would steal the page scroll on a phone, where
        // the row is most of the width of the screen.
        lane.style.touchAction = opts.vertical ? "pan-x" : "pan-y";
        // Non-negotiable 7: without this the browser starts its own text drag.
        lane.style.userSelect = "none";
        (lane.style as CSSStyleDeclaration & { webkitUserSelect: string; }).webkitUserSelect = "none";
        track.style.willChange = "transform";
    }

    function render(): void {
        const x = opts.vertical ? 0 : -offset;
        const y = opts.vertical ? -offset : 0;
        track.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }

    /**
     * Non-negotiable 1: measure the lap, never compute it. The step between two
     * copies already contains the gap, the padding, the font metrics and whatever
     * a justify-* did. `itemCount * (itemWidth + gap)` is right by coincidence.
     */
    function readPeriod(): number {
        const first = track.children[0] as HTMLElement | undefined;
        const second = track.children[1] as HTMLElement | undefined;
        if (!first) return 0;
        if (second) {
            const step = axisStart(second) - axisStart(first);
            if (step > 0) return step;
        }
        // Only reachable with a single copy in the DOM, which the engine avoids.
        return axisSize(first);
    }

    /** Non-negotiable 2: the lane plus one whole period, so there is always one to wrap into. */
    function requiredCopies(measured: number): number {
        if (measured <= 0) return 2;
        return Math.max(2, Math.ceil(axisSize(lane) / measured) + 1);
    }

    function syncClones(count: number): void {
        const source = track.children[0] as HTMLElement | undefined;
        if (!source) return;
        while (track.children.length > count) track.removeChild(track.lastElementChild!);
        while (track.children.length < count) {
            const clone = source.cloneNode(true) as HTMLElement;
            // The repeat is decoration; a screen reader must hear the content once.
            clone.setAttribute("aria-hidden", "true");
            clone.dataset.enigmaMarqueeCopy = String(track.children.length);
            track.appendChild(clone);
        }
    }

    function measure(): void {
        if (destroyed) return;
        const measured = readPeriod();
        const needed = requiredCopies(measured);
        const changed = measured !== period || needed !== copyCount;
        period = measured;
        if (needed !== copyCount) {
            copyCount = needed;
            if (opts.copies === "clone") syncClones(needed);
            opts.onCopyCountChange?.(needed);
        }
        if (period > 0) offset = wrap(offset);
        render();
        if (changed) opts.onMeasure?.(period, copyCount);
        start();
    }

    /** Non-negotiable 12: wrap every frame or the number grows without bound. */
    function wrap(value: number): number {
        if (period <= 0) return value;
        return ((value % period) + period) % period;
    }

    function tick(now: number): void {
        frame = 0;
        if (destroyed) return;
        const dt = Math.min((now - lastTime) / 1000, MAX_DT);
        lastTime = now;

        if (!dragging) {
            // One integrator for cruise, hover and momentum. Math.pow(decay, dt)
            // is what keeps it identical on a 60Hz and a 120Hz display.
            velocity += (target() - velocity) * (1 - Math.pow(opts.decay, dt));
            offset = wrap(offset + velocity * dt);
        }
        render();

        const idle = !dragging && Math.abs(velocity) < IDLE_EPSILON && Math.abs(target()) < IDLE_EPSILON;
        if (idle) {
            velocity = 0;
            running = false;
            return;
        }
        frame = requestAnimationFrame(tick);
    }

    function start(): void {
        if (destroyed || running) return;
        running = true;
        lastTime = performance.now();
        frame = requestAnimationFrame(tick);
    }

    function pointerDelta(event: PointerEvent): number {
        return opts.vertical ? event.clientY : event.clientX;
    }

    function onPointerDown(event: PointerEvent): void {
        // Non-negotiable 9: a right click must leave the context menu alone.
        if (!opts.draggable || event.button > 0 || pointerId !== null) return;
        pointerId = event.pointerId;
        dragging = true;
        lastPointer = pointerDelta(event);
        startPointer = lastPointer;
        lastMoveTime = event.timeStamp;
        // Reset here so the next plain click is not cancelled by the last drag.
        maxTravel = 0;
        lane.dataset.dragging = "true";
        // Non-negotiable 5: NO setPointerCapture. It retargets the compatibility
        // mouse events too, so the click of a plain press lands on the lane and
        // the item's link never opens. Window listeners are all the capture was for.
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
        start();
    }

    function onPointerMove(event: PointerEvent): void {
        if (event.pointerId !== pointerId) return;
        const position = pointerDelta(event);
        const delta = position - lastPointer;
        lastPointer = position;

        const dt = Math.max((event.timeStamp - lastMoveTime) / 1000, 0.001);
        lastMoveTime = event.timeStamp;
        // The largest displacement since the press, not the distance walked: a
        // slow wobble back to where it started is still a click.
        maxTravel = Math.max(maxTravel, Math.abs(position - startPointer));

        // The pointer drives the offset directly; the integrator takes over on release.
        offset = wrap(offset - delta);
        const instant = -delta / dt;
        velocity = velocity * VELOCITY_SMOOTHING + instant * (1 - VELOCITY_SMOOTHING);
    }

    function onPointerUp(event: PointerEvent): void {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        dragging = false;
        delete lane.dataset.dragging;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        // Non-negotiable 10: a slow reposition must not end in a fling.
        if (event.timeStamp - lastMoveTime > STILL_MS) velocity = 0;
        start();
    }

    /** Non-negotiable 7: a drag must not open what it ends on. */
    function onClickCapture(event: MouseEvent): void {
        if (maxTravel <= DRAG_THRESHOLD) return;
        event.preventDefault();
        event.stopPropagation();
    }

    function onClick(event: MouseEvent): void {
        if (maxTravel > DRAG_THRESHOLD) return;
        opts.onItemClick?.(event);
    }

    /** Non-negotiable 8: a tap fires pointerenter and never the pointerleave that undoes it. */
    function onPointerEnter(event: PointerEvent): void {
        if (event.pointerType !== "mouse") return;
        hovering = true;
        lane.dataset.hovering = "true";
        start();
    }

    function onPointerLeave(event: PointerEvent): void {
        if (event.pointerType !== "mouse") return;
        hovering = false;
        delete lane.dataset.hovering;
        start();
    }

    function onMotionChange(event: MediaQueryListEvent): void {
        reducedMotion = event.matches;
        lane.dataset.reducedMotion = String(reducedMotion);
        start();
    }

    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;

    function init(): void {
        applyStyles();
        lane.dataset.enigmaMarquee = "";
        lane.dataset.reducedMotion = String(reducedMotion);
        track.dataset.enigmaMarqueeTrack = "";
        for (const child of Array.from(track.children)) {
            (child as HTMLElement).dataset.enigmaMarqueeCopy ??= "0";
        }

        lane.addEventListener("pointerdown", onPointerDown);
        lane.addEventListener("pointerenter", onPointerEnter);
        lane.addEventListener("pointerleave", onPointerLeave);
        lane.addEventListener("click", onClickCapture, true);
        lane.addEventListener("click", onClick);
        motionQuery?.addEventListener("change", onMotionChange);

        // A lane can change width without the window doing so, so observe the lane.
        resizeObserver?.observe(lane);
        const first = track.children[0];
        if (first) resizeObserver?.observe(first);

        measure();
        // A late font changes every width the lap was measured from.
        void document.fonts?.ready.then(() => measure());
    }

    init();

    return {
        get offset() { return offset; },
        get period() { return period; },
        get copyCount() { return copyCount; },
        get dragging() { return dragging; },
        get reducedMotion() { return reducedMotion; },
        update(next: Partial<MarqueeOptions>) {
            const styleKeys = next.vertical !== undefined || next.manageStyles !== undefined;
            opts = { ...opts, ...next };
            if (styleKeys) applyStyles();
            measure();
        },
        measure,
        pause() { paused = true; start(); },
        resume() { paused = false; start(); },
        destroy() {
            destroyed = true;
            if (frame) cancelAnimationFrame(frame);
            resizeObserver?.disconnect();
            motionQuery?.removeEventListener("change", onMotionChange);
            lane.removeEventListener("pointerdown", onPointerDown);
            lane.removeEventListener("pointerenter", onPointerEnter);
            lane.removeEventListener("pointerleave", onPointerLeave);
            lane.removeEventListener("click", onClickCapture, true);
            lane.removeEventListener("click", onClick);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerUp);
        }
    };
}
