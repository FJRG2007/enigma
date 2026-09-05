"use client";

import { createPortal } from "react-dom";
import * as icons from "@/react/image/icons";
import * as viewer from "@/core/image-viewer";
import { IMAGE_STYLES } from "@/react/image/styles";
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

let injected = false;

function injectStyles(): void {
    if (injected || typeof document === "undefined") return;
    injected = true;
    if (document.querySelector("[data-enigma-image-styles]")) return;
    const element = document.createElement("style");
    element.setAttribute("data-enigma-image-styles", "");
    element.textContent = IMAGE_STYLES;
    document.head.prepend(element);
}

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
    styles,
    labels
}: ImageViewerProps): ReactNode {
    // Before paint: a sheet applied after the first frame shows the dialog undressed first.
    useLayoutEffect(() => { if (styles) injectStyles(); }, [styles]);

    const frameRef = useRef<HTMLDivElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);

    const [transform, setTransform] = useState<viewer.Transform>(viewer.IDENTITY);
    const [loading, setLoading] = useState(true);
    const [panning, setPanning] = useState(false);
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
        if (next === -1) onClose();
        else onIndex(next);
    }, [discardable, item, index, items.length, discarded, onDiscard, onIndex, onClose]);

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
        if (Math.abs(event.clientX - started.x) < 4 && Math.abs(event.clientY - started.y) < 4) onClose();
    }, [onClose]);

    /* -------- the keyboard, which is the same viewer by other means -------- */

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented) return;
            const key = event.key;

            if (key === "Escape") return void (event.preventDefault(), onClose());
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
    }, [onClose, navigation, zoom, zoomed, go, zoomBy, reset, bounded, discardable, discard]);

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

    const style = { transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` } satisfies CSSProperties;
    const counter = (labels.counter ?? "{index} of {total}").replace("{index}", String(position)).replace("{total}", String(remaining));

    return createPortal(
        <div
            data-enigma-image-viewer=""
            role="dialog"
            aria-modal="true"
            aria-label={labels.viewer ?? "Image viewer"}
            // A press on the backdrop closes; one that started on the picture does not, or a
            // drag that ends outside the image would shut the viewer mid-pan.
            onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
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

                <button type="button" data-enigma-image-button="" aria-label={labels.close ?? "Close"} title={labels.close ?? "Close"} onClick={onClose}>
                    <icons.Close />
                </button>
            </div>

            <div
                ref={frameRef}
                data-enigma-image-frame=""
                data-zoomed={zoomed ? "" : undefined}
                data-panning={panning ? "" : undefined}
                data-loading={loading ? "" : undefined}
                tabIndex={-1}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onDoubleClick={(event) => {
                    if (!zoom?.doubleClick) return;
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
