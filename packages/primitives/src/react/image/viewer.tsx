"use client";

import { createPortal } from "react-dom";
import * as icons from "@/react/image/icons";
import * as viewer from "@/core/image-viewer";
import { injectImageStyles } from "@/react/image/styles";
import type { ImageItem, ImageLabels, ImageMenuOptions, ZoomOptions } from "@/react/image/types";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/**
 * The lightbox: the picture, what moves it, and what the toolbar offers.
 *
 * Its own chunk, fetched when a viewer is first opened, so a page of images that nobody
 * enlarges downloads none of it. What the page renders - the thumbnail and the press that
 * opens this - stays in the base module, because a control that arrives with its chunk is a
 * control that is missing for as long as the network takes.
 *
 * The panel is PORTALLED to the body, unlike the colour picker's, which hangs off its field.
 * A lightbox covers the window: left in place it would be clipped by the first ancestor with
 * `overflow: hidden`, and stacked under anything the page gave a `z-index` to.
 */

const ImageMenu = lazy(() => import("@/react/image/menu").then((module) => ({ default: module.ImageMenu })));

export interface ImageViewerProps {
    items: readonly ImageItem[];
    index: number;
    onIndex: (index: number) => void;
    onClose: () => void;
    zoom: Required<Pick<ZoomOptions, "min" | "max" | "wheel" | "doubleClick">> | null;
    navigation: boolean;
    thumbnails: boolean;
    menu: ImageMenuOptions | null;
    discardable: boolean;
    onDiscard?: (item: ImageItem, index: number) => void;
    loop: boolean;
    caption?: ReactNode;
    /**
     * Where the picture is in the PAGE, read at the moment it is needed.
     *
     * A getter rather than a rectangle: the flight back happens whenever the viewer is closed,
     * and by then the page may have scrolled, reflowed, or be showing a different image of the
     * set. A rectangle captured on open would fly the picture at where the thumbnail used to be.
     */
    origin?: () => DOMRect | null;
    /** Fly in and out of the thumbnail. Off leaves the dialog appearing outright. */
    animate: boolean;
    styles: boolean;
    labels: ImageLabels;
}

export function ImageViewer({
    items,
    index,
    onIndex,
    onClose,
    zoom,
    navigation,
    thumbnails,
    menu,
    discardable,
    onDiscard,
    loop,
    caption,
    origin,
    animate,
    styles,
    labels
}: ImageViewerProps): ReactNode {
    // Before paint: a sheet applied after the first frame shows the dialog undressed first.
    useLayoutEffect(() => { if (styles) injectImageStyles(); }, [styles]);

    const frameRef = useRef<HTMLDivElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);

    const [transform, setTransform] = useState<viewer.Transform>(viewer.IDENTITY);
    const [loading, setLoading] = useState(true);
    const [panning, setPanning] = useState(false);
    /**
     * Where the dialog is in its own life.
     *
     * "measuring" is the beat before the picture can be drawn at all: the dialog is up, and
     * where the picture is going to land is not known until it has been laid out. Then it
     * flies, then it sits there, then it flies home.
     *
     * It starts at "open" whenever there is nothing to fly from - no origin, no animation
     * asked for, or a reader who has asked for less movement - so every path below has a
     * viewer that simply exists, and the flight is the decoration on top of it.
     *
     * The phases are four rather than three because "no flight yet" and "the flight has been
     * released" are not the same state and cannot share one: written as `flight === null` they
     * did, and the picture was hidden for the whole animation.
     */
    const [phase, setPhase] = useState<"measuring" | "flying" | "open" | "closing">(() => (
        animate && origin && !viewer.prefersReducedMotion() ? "measuring" : "open"
    ));
    /** The transform that holds the picture ON the thumbnail, for the frame before it is let go. */
    const [flight, setFlight] = useState<viewer.Transform | null>(null);
    /**
     * What has been discarded, for as long as this viewer is open.
     *
     * The list belongs to the CALLER: `onDiscard` is how they drop it from their own state,
     * and a set that lived past the dialog would fight whatever they did with it. So the
     * skipping is a session, and reopening starts from whatever they now pass in.
     */
    const [discarded, setDiscarded] = useState<ReadonlySet<number>>(() => new Set());

    const limits = useMemo(() => ({ min: zoom?.min ?? viewer.ZOOM_LIMITS.min, max: zoom?.max ?? viewer.ZOOM_LIMITS.max }), [zoom]);
    const item = items[index];
    const zoomed = transform.scale > limits.min;

    const remaining = items.length - discarded.size;
    const position = useMemo(() => {
        let seen = 0;
        for (let at = 0; at <= index && at < items.length; at += 1) if (!discarded.has(at)) seen += 1;
        return seen;
    }, [index, items.length, discarded]);

    /* -------- the flight between the thumbnail and the frame -------- */

    /**
     * Where the picture SITS, ignoring whatever transform it is carrying.
     *
     * `getBoundingClientRect` would report the zoomed, panned box, which is useless for
     * computing the transform that lands it somewhere. `offsetLeft`/`offsetWidth` are layout,
     * so they are the same number mid-zoom as they are at rest, and the frame - which carries
     * no transform of its own - anchors them to the viewport.
     */
    const layoutBox = useCallback((): viewer.Box | null => {
        const frame = frameRef.current;
        const element = imageRef.current;
        if (!frame || !element?.offsetWidth) return null;
        const box = frame.getBoundingClientRect();
        return { left: box.left + element.offsetLeft, top: box.top + element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
    }, []);

    /**
     * Close, flying the picture back onto the thumbnail it came from.
     *
     * Every dismissal goes through here - Escape, the button, a press on the backdrop, the
     * last image being discarded - so there is one place where the dialog can be leaving, and
     * `onClose` is called once, at the end of it.
     */
    const requestClose = useCallback(() => {
        if (phase === "closing" || phase === "measuring") return onClose();
        const from = origin?.();
        const to = layoutBox();
        const back = animate && !viewer.prefersReducedMotion() && from && to ? viewer.flightFrom(from, to) : null;
        if (!back) return onClose();
        setPhase("closing");
        setFlight(back);
    }, [phase, origin, layoutBox, animate, onClose]);

    /* -------- moving through the set -------- */

    const go = useCallback((step: number) => {
        const next = viewer.nextIndex(index, items.length, step, { loop, skip: discarded });
        if (next === -1 || next === index) return;
        onIndex(next);
    }, [index, items.length, loop, discarded, onIndex]);

    const showAt = useCallback((next: number) => {
        if (next === index || discarded.has(next)) return;
        onIndex(next);
    }, [index, discarded, onIndex]);

    const discard = useCallback(() => {
        if (!discardable || !item) return;
        const next = viewer.nextIndex(index, items.length, 1, { loop: true, skip: new Set([...discarded, index]) });
        setDiscarded((current) => new Set(current).add(index));
        onDiscard?.(item, index);
        // Nothing left to show: an empty frame is not a viewer, so it closes rather than
        // sitting there with the toolbar over a black rectangle.
        if (next === -1) requestClose();
        else onIndex(next);
    }, [discardable, item, index, items.length, discarded, onDiscard, onIndex, requestClose]);

    /* -------- zoom and pan -------- */

    const reset = useCallback(() => setTransform(viewer.IDENTITY), []);

    // A different picture is a different frame: keeping the last one's zoom would open the
    // next image already halfway into a corner of it.
    useEffect(() => {
        setTransform(viewer.IDENTITY);
        setLoading(true);
    }, [item?.src]);

    const frameBox = useCallback((): viewer.Box | null => {
        const box = frameRef.current?.getBoundingClientRect();
        return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
    }, []);

    const bounded = useCallback((next: viewer.Transform): viewer.Transform => {
        const box = frameBox();
        const element = imageRef.current;
        if (!box || !element) return next;
        const fitted = viewer.fittedSize({ width: element.naturalWidth, height: element.naturalHeight }, box);
        return viewer.clampPan(next, box, fitted);
    }, [frameBox]);

    const zoomBy = useCallback((factor: number, point?: { x: number; y: number; }) => {
        const box = frameBox();
        if (!box) return;
        const at = point ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        setTransform((current) => bounded(viewer.zoomAt(current, factor, at, box, limits)));
    }, [frameBox, bounded, limits]);

    /**
     * The wheel, bound by hand because React's `onWheel` is passive.
     *
     * A passive listener cannot call `preventDefault`, so every notch would zoom the image AND
     * scroll the page behind the dialog.
     */
    useEffect(() => {
        const element = frameRef.current;
        if (!element || !zoom?.wheel) return;
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            zoomBy(viewer.wheelFactor(event.deltaY, event.deltaMode), { x: event.clientX, y: event.clientY });
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
    }, [zoom?.wheel, zoomBy]);

    /**
     * One press, and everything until the last finger comes up.
     *
     * Two pointers are a pinch and one is a drag, tracked in the same place because the
     * gestures interrupt each other: a second finger has to stop the pan rather than fight it.
     */
    const pointers = useRef(new Map<number, { x: number; y: number; }>());
    const pinch = useRef<{ distance: number; scale: number; } | null>(null);

    /** Where a press on the empty part of the frame started, so a drag is not read as a click. */
    const backdropPress = useRef<{ x: number; y: number; } | null>(null);

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        const element = event.currentTarget;
        // The dark area beside the picture IS the backdrop, whatever element it belongs to:
        // pressing it is how every lightbox is closed, and a viewer that only answers the few
        // pixels outside the frame is one people press twice and then hunt for the X.
        backdropPress.current = event.target === element && !zoomed ? { x: event.clientX, y: event.clientY } : null;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinch.current = { distance: viewer.pinchDistance(a, b), scale: transform.scale };
            setPanning(false);
            return;
        }
        if (!zoomed) return;
        event.preventDefault();
        setPanning(true);
        try { element.setPointerCapture(event.pointerId); } catch { /* a pointer already gone */ }
    }, [zoomed, transform.scale]);

    const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const previous = pointers.current.get(event.pointerId);
        if (!previous) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointers.current.size === 2 && pinch.current) {
            const [a, b] = [...pointers.current.values()];
            const distance = viewer.pinchDistance(a, b);
            if (!pinch.current.distance) return;
            const box = frameBox();
            if (!box) return;
            const factor = (distance / pinch.current.distance) * (pinch.current.scale / transform.scale);
            setTransform((current) => bounded(viewer.zoomAt(current, factor, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, box, limits)));
            return;
        }

        if (!panning) return;
        setTransform((current) => bounded({ ...current, x: current.x + (event.clientX - previous.x), y: current.y + (event.clientY - previous.y) }));
    }, [panning, bounded, frameBox, limits, transform.scale]);

    const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
        if (pointers.current.size === 0) setPanning(false);

        const started = backdropPress.current;
        backdropPress.current = null;
        if (!started || event.target !== event.currentTarget) return;
        // A drag that happens to end on the backdrop is not a press on it: 4px of slop, which
        // is what a hand resting on a trackpad moves.
        if (Math.abs(event.clientX - started.x) < 4 && Math.abs(event.clientY - started.y) < 4) requestClose();
    }, [requestClose]);

    /**
     * The flight in.
     *
     * FLIP, and in that order: the full-size picture is laid out where it belongs, measured,
     * then drawn back ON the thumbnail and released. Reversing it - animating a small image up
     * - would need the destination size before layout has produced it.
     *
     * It waits for the picture to have a size. A flight measured before the image decodes flies
     * from the thumbnail into a box of nothing, and the usual case is not slow: the viewer
     * opens on an image the page has already loaded, so `complete` is true on the first pass.
     */
    useLayoutEffect(() => {
        if (phase !== "measuring") return;
        const element = imageRef.current;
        const from = origin?.();
        if (!element || !from) {
            setPhase("open");
            return;
        }
        // Not ready: this effect runs again when `loading` turns over, which is the load event
        // the picture is waiting on.
        if (!element.complete) return;

        const to = layoutBox();
        const start = to ? viewer.flightFrom(from, to) : null;
        if (!start) {
            setPhase("open");
            return;
        }

        setFlight(start);
        /**
         * Released two frames later, and it has to be two.
         *
         * A layout effect commits its own state change before the browser paints, and a
         * callback booked from there runs at the START of the next frame - still before that
         * paint. Releasing there means the picture is never once drawn on the thumbnail, the
         * browser sees identity to identity, and there is no transition at all: the viewer
         * simply appears. The second frame is what guarantees the first position was painted.
         *
         * Both go in one update: the frame that lets the transform go is the frame the picture
         * becomes visible in, or the flight happens behind a hidden element.
         */
        let second = 0;
        const first = requestAnimationFrame(() => {
            second = requestAnimationFrame(() => {
                setFlight(null);
                setPhase("flying");
            });
        });
        return () => {
            cancelAnimationFrame(first);
            cancelAnimationFrame(second);
        };
    }, [phase, origin, layoutBox, loading]);

    /**
     * The end of either flight.
     *
     * The timer is not belt and braces: a transform that happens to equal the one already on
     * the element fires no `transitionend` at all, and a dialog left in "closing" would be a
     * lightbox that never goes away.
     */
    useEffect(() => {
        if (phase !== "flying" && phase !== "closing") return;
        const element = imageRef.current;
        const done = (event?: TransitionEvent): void => {
            if (event && event.propertyName !== "transform") return;
            if (phase === "closing") onClose();
            else setPhase("open");
        };
        element?.addEventListener("transitionend", done);
        const timer = window.setTimeout(() => done(), viewer.flightMs(element) + 80);
        return () => {
            element?.removeEventListener("transitionend", done);
            window.clearTimeout(timer);
        };
    }, [phase, onClose]);

    /* -------- the keyboard, which is the same viewer by other means -------- */

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented) return;
            const key = event.key;

            if (key === "Escape") return void (event.preventDefault(), requestClose());
            if (navigation && (key === "ArrowRight" || key === "ArrowLeft") && !zoomed) {
                event.preventDefault();
                return go(key === "ArrowRight" ? 1 : -1);
            }
            if (zoom && (key === "+" || key === "=")) return void (event.preventDefault(), zoomBy(viewer.ZOOM_STEP));
            if (zoom && key === "-") return void (event.preventDefault(), zoomBy(1 / viewer.ZOOM_STEP));
            if (zoom && key === "0") return void (event.preventDefault(), reset());
            // Panning with the arrows, once there is somewhere to pan to.
            if (zoomed && key.startsWith("Arrow")) {
                event.preventDefault();
                const step = event.shiftKey ? 120 : 40;
                const by = key === "ArrowLeft" ? [step, 0] : key === "ArrowRight" ? [-step, 0] : key === "ArrowUp" ? [0, step] : [0, -step];
                return setTransform((current) => bounded({ ...current, x: current.x + by[0], y: current.y + by[1] }));
            }
            if (discardable && (key === "Delete" || key === "Backspace")) return void (event.preventDefault(), discard());
        };

        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [requestClose, navigation, zoom, zoomed, go, zoomBy, reset, bounded, discardable, discard]);

    /* -------- what a dialog owes the page it covers -------- */

    useEffect(() => {
        frameRef.current?.focus();
        const { body } = document;
        const overflow = body.style.overflow;
        // The page behind must not scroll under the backdrop: a wheel over the dialog's own
        // margins would otherwise move the article nobody can see.
        body.style.overflow = "hidden";
        return () => { body.style.overflow = overflow; };
    }, []);

    // The strip follows the picture, or the current thumbnail walks off the end of a long
    // gallery and the only way back is to drag the row.
    useEffect(() => {
        if (!thumbnails) return;
        stripRef.current?.querySelector<HTMLElement>("[aria-current=true]")?.scrollIntoView({ block: "nearest", inline: "center" });
    }, [thumbnails, index]);

    if (!item) return null;

    // The flight wins while there is one: it is the same transform channel, and the pan the
    // reader left behind is where the picture flies back FROM.
    const drawn = flight ?? transform;
    const style = { transform: `translate(${drawn.x}px, ${drawn.y}px) scale(${drawn.scale})` } satisfies CSSProperties;
    const counter = (labels.counter ?? "{index} of {total}").replace("{index}", String(position)).replace("{total}", String(remaining));

    return createPortal(
        <div
            data-enigma-image-viewer=""
            // Three states outside, four inside: "measuring" and "flying" are one thing to a
            // stylesheet - the dialog is arriving - and splitting them in the theme would make
            // an internal beat part of the API.
            data-state={phase === "measuring" || phase === "flying" ? "opening" : phase}
            role="dialog"
            aria-modal="true"
            aria-label={labels.viewer ?? "Image viewer"}
            // A press on the backdrop closes; one that started on the picture does not, or a
            // drag that ends outside the image would shut the viewer mid-pan.
            onPointerDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}
        >
            <div data-enigma-image-bar="">
                {navigation && <span data-enigma-image-counter="">{counter}</span>}
                {!navigation && <span data-enigma-image-counter="" />}

                {zoom && (
                    <>
                        <button type="button" data-enigma-image-button="" aria-label={labels.zoomOut ?? "Zoom out"} title={labels.zoomOut ?? "Zoom out"} disabled={transform.scale <= limits.min} onClick={() => zoomBy(1 / viewer.ZOOM_STEP)}>
                            <icons.Minus />
                        </button>
                        <button type="button" data-enigma-image-button="" aria-label={labels.zoomIn ?? "Zoom in"} title={labels.zoomIn ?? "Zoom in"} disabled={transform.scale >= limits.max} onClick={() => zoomBy(viewer.ZOOM_STEP)}>
                            <icons.Plus />
                        </button>
                    </>
                )}

                {discardable && (
                    <button type="button" data-enigma-image-button="" aria-label={labels.discard ?? "Discard this image"} title={labels.discard ?? "Discard this image"} onClick={discard}>
                        <icons.Trash />
                    </button>
                )}

                {menu && (
                    <Suspense fallback={<MenuButton label={labels.menu ?? "More"} onPress={undefined} />}>
                        <ImageMenu item={item} index={index} options={menu} labels={labels} />
                    </Suspense>
                )}

                <button type="button" data-enigma-image-button="" aria-label={labels.close ?? "Close"} title={labels.close ?? "Close"} onClick={requestClose}>
                    <icons.Close />
                </button>
            </div>

            <div
                ref={frameRef}
                data-enigma-image-frame=""
                data-zoom={zoom ? "" : undefined}
                // "pending" is the beat before the picture can be drawn anywhere sensible.
                // Drawing during it would put one frame of the full-size image where it is
                // going to LAND, and the flight would then start by jumping back to the
                // thumbnail.
                data-flying={phase === "open" ? undefined : phase === "measuring" ? "pending" : "moving"}
                data-zoomed={zoomed ? "" : undefined}
                data-panning={panning ? "" : undefined}
                data-loading={loading ? "" : undefined}
                tabIndex={-1}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onDoubleClick={(event) => {
                    if (!zoom?.doubleClick || phase !== "open") return;
                    if (zoomed) return reset();
                    zoomBy(viewer.ZOOM_DOUBLE / transform.scale, { x: event.clientX, y: event.clientY });
                }}
            >
                <img
                    ref={imageRef}
                    // Keyed on the source: without it React keeps the previous <img> element,
                    // which means the next picture arrives with the last one's `complete` and
                    // the spinner never shows.
                    key={item.src}
                    src={item.src}
                    alt={item.alt ?? ""}
                    style={style}
                    draggable={false}
                    onLoad={() => setLoading(false)}
                    onError={() => setLoading(false)}
                />
                {loading && <span data-enigma-image-spinner="" role="progressbar" aria-label={labels.viewer ?? "Image viewer"} />}

                {navigation && remaining > 1 && (
                    <>
                        <button type="button" data-enigma-image-button="" data-enigma-image-nav="previous" aria-label={labels.previous ?? "Previous image"} title={labels.previous ?? "Previous image"} onClick={() => go(-1)}>
                            <icons.ChevronLeft />
                        </button>
                        <button type="button" data-enigma-image-button="" data-enigma-image-nav="next" aria-label={labels.next ?? "Next image"} title={labels.next ?? "Next image"} onClick={() => go(1)}>
                            <icons.ChevronRight />
                        </button>
                    </>
                )}
            </div>

            <div data-enigma-image-foot="">
                {(item.caption ?? caption) && <p data-enigma-image-caption="">{item.caption ?? caption}</p>}

                {thumbnails && remaining > 1 && (
                    <div ref={stripRef} data-enigma-image-strip="" role="tablist" aria-label={labels.thumbnails ?? "Images"}>
                        {items.map((entry, at) => discarded.has(at) ? null : (
                            <button
                                key={entry.src}
                                type="button"
                                role="tab"
                                data-enigma-image-thumb=""
                                aria-current={at === index}
                                aria-selected={at === index}
                                aria-label={entry.alt ?? `${at + 1}`}
                                onClick={() => showAt(at)}
                            >
                                <img src={entry.thumbnail ?? entry.src} alt="" loading="lazy" draggable={false} />
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
}

/**
 * The three dots, on its own so the fallback and the loaded menu draw the same button.
 *
 * `onPress` is absent while the menu's code is in flight: the button is there, and pressing
 * it does nothing rather than moving under the pointer once the chunk lands.
 */
export function MenuButton({ label, onPress, expanded }: { label: string; onPress?: () => void; expanded?: boolean; }): ReactNode {
    return (
        <button
            type="button"
            data-enigma-image-button=""
            data-enigma-image-menu=""
            aria-haspopup="menu"
            aria-expanded={expanded ?? false}
            aria-label={label}
            title={label}
            onClick={onPress}
        >
            <icons.Dots />
        </button>
    );
}
