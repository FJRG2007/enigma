"use client";

import { toItem } from "@/react/image/types";
import type { ImageItem, ImageProps, ZoomOptions } from "@/react/image/types";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * `<Image>` - the picture in the page, and the viewer a press on it opens.
 *
 * ```tsx
 * <Image src="/shot.png" alt="The dashboard" />
 * <Image src={shot} alt="..." images={gallery} navigation thumbnails menu discardable />
 * ```
 *
 * WHAT IS ON BY DEFAULT is the API: click to enlarge, and zoom with the wheel. The arrows,
 * the strip of previews, the menu and the discard action are each a decision about the page
 * this sits in - a product gallery wants all four, an avatar wants none - so each is a prop
 * you turn on rather than one you have to remember to turn off.
 *
 * WHAT LOADS. This module is the `<img>` and the press. The lightbox is its own chunk, and
 * its menu another under that, so a page of images nobody enlarges downloads neither. The
 * chunk is fetched on INTENT - a pointer over the image, or focus reaching it - so by the
 * time the press lands it is usually already here; a press that beats it opens the viewer as
 * soon as it arrives, rather than being dropped.
 */

const ImageViewer = lazy(() => import("@/react/image/viewer").then((module) => ({ default: module.ImageViewer })));

/** Kept out of the render so the hover prefetch fires once per session rather than per event. */
let prefetched = false;

function prefetchViewer(): void {
    if (prefetched) return;
    prefetched = true;
    void import("@/react/image/viewer");
}

const ZOOM_DEFAULTS = { min: 1, max: 8, wheel: true, doubleClick: true } as const;

export function Image(props: ImageProps): ReactNode {
    const {
        src,
        alt,
        images,
        index,
        lightbox = true,
        zoom = true,
        navigation = false,
        thumbnails = false,
        menu = false,
        discardable = false,
        onDiscard,
        loop = true,
        caption,
        onOpenChange,
        onIndexChange,
        styles = true,
        labels = {},
        wrapperProps,
        ...rest
    } = props;

    const [open, setOpen] = useState(false);

    const items = useMemo<ImageItem[]>(() => {
        const set = (images ?? [src]).map(toItem);
        // A set that does not contain this image would open the viewer on somebody else's
        // picture, so the one that was pressed is always in it.
        return set.some((entry) => entry.src === src) ? set : [{ src, alt }, ...set];
    }, [images, src, alt]);

    const initial = useMemo(() => {
        if (typeof index === "number" && index >= 0 && index < items.length) return index;
        const found = items.findIndex((entry) => entry.src === src);
        return found === -1 ? 0 : found;
    }, [index, items, src]);

    const [current, setCurrent] = useState(initial);
    useEffect(() => setCurrent(initial), [initial]);

    const triggerRef = useRef<HTMLButtonElement | null>(null);

    const zoomOptions = useMemo(() => {
        if (zoom === false) return null;
        const given: ZoomOptions = zoom === true ? {} : zoom;
        return { ...ZOOM_DEFAULTS, ...given, doubleClick: given.doubleClick !== false, wheel: given.wheel !== false };
    }, [zoom]);

    const menuOptions = useMemo(() => (menu === false ? null : menu === true ? {} : menu), [menu]);

    const show = useCallback(() => {
        if (!lightbox) return;
        // A press before the chunk lands is not lost: this is state, and the viewer mounts
        // with it the moment its code is here.
        setOpen(true);
        onOpenChange?.(true);
    }, [lightbox, onOpenChange]);

    const close = useCallback(() => {
        setOpen(false);
        onOpenChange?.(false);
        // Back where the press came from: closing a dialog that leaves focus on the body
        // sends the next Tab to the top of the page.
        triggerRef.current?.focus();
    }, [onOpenChange]);

    const goTo = useCallback((next: number) => {
        setCurrent(next);
        const item = items[next];
        if (item) onIndexChange?.(next, item);
    }, [items, onIndexChange]);

    const image = <img src={src} alt={alt} {...rest} />;

    return (
        <span {...wrapperProps} data-enigma-image="" data-clickable={lightbox ? "" : undefined}>
            {lightbox ? (
                <button
                    ref={triggerRef}
                    type="button"
                    data-enigma-image-trigger=""
                    // The image IS the label: a second name here would have a screen reader
                    // read the picture twice, once for the button and once for the alt.
                    aria-label={labels.open ? `${labels.open}: ${alt}` : alt}
                    aria-haspopup="dialog"
                    onClick={show}
                    onPointerEnter={prefetchViewer}
                    onFocus={prefetchViewer}
                >
                    {image}
                </button>
            ) : image}

            {open && (
                <Suspense fallback={null}>
                    <ImageViewer
                        items={items}
                        index={current}
                        onIndex={goTo}
                        onClose={close}
                        zoom={zoomOptions}
                        navigation={navigation}
                        thumbnails={thumbnails}
                        menu={menuOptions}
                        discardable={discardable}
                        onDiscard={onDiscard}
                        loop={loop}
                        caption={caption}
                        styles={styles}
                        labels={labels}
                    />
                </Suspense>
            )}
        </span>
    );
}

export type { ImageProps, ImageItem, ImageSource, ImageLabels, ImageMenuOptions, ZoomOptions } from "@/react/image/types";
