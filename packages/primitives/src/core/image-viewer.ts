/**
 * The arithmetic behind the image viewer: zoom around a point, panning that cannot lose the
 * image, moving through a set, and getting a file onto the disk.
 *
 * Not a React module, and deliberately: none of this is rendering. A page drawing its own
 * viewer, or a test, gets the same maths - and the parts that are easy to get wrong (zoom
 * that drifts away from the cursor, a pan that strands the image off screen, a download that
 * silently opens a tab instead) are then testable without a browser.
 */

/** How far the image is scaled, and where its centre sits relative to the frame's, in px. */
export interface Transform {
    scale: number;
    x: number;
    y: number;
}

export interface ZoomLimits {
    min: number;
    max: number;
}

/** A box in viewport coordinates - the frame the image is being viewed in. */
export interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

export const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export const ZOOM_LIMITS: ZoomLimits = { min: 1, max: 8 };

/** What a keyboard `+`/`-` step multiplies by, and the ratio a double press toggles to. */
export const ZOOM_STEP = 1.35;
export const ZOOM_DOUBLE = 2.5;

export function clampScale(scale: number, limits: ZoomLimits = ZOOM_LIMITS): number {
    return Math.min(Math.max(scale, limits.min), limits.max);
}

/**
 * A wheel notch to a zoom factor.
 *
 * `deltaMode` matters: a mouse reports pixels, but Firefox reports LINES (mode 1) and a page
 * scroll reports pages (mode 2), so treating every delta as pixels makes the same gesture
 * zoom a hundred times harder in one browser than another. The exponential keeps a notch
 * proportional - zooming out from 8x and in from 1x take the same number of turns.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
    const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
    return Math.exp(-Math.min(Math.max(pixels, -240), 240) / 320);
}

/**
 * Zoom, keeping the point under the pointer under the pointer.
 *
 * The defect this exists for: scaling around the frame's centre slides whatever the visitor
 * was pointing at out from under them, so zooming into a face means zooming and then hunting
 * for it again. The offset is corrected by how much that point moved when the scale changed.
 */
export function zoomAt(current: Transform, factor: number, point: { x: number; y: number; }, box: Box, limits: ZoomLimits = ZOOM_LIMITS): Transform {
    const scale = clampScale(current.scale * factor, limits);
    if (scale === current.scale) return current;

    // Where the pointer is relative to the frame's centre, which is what the offsets are
    // measured from.
    const dx = point.x - (box.left + box.width / 2);
    const dy = point.y - (box.top + box.height / 2);
    const ratio = scale / current.scale;

    return { scale, x: dx - (dx - current.x) * ratio, y: dy - (dy - current.y) * ratio };
}

/**
 * Keep the image over the frame.
 *
 * At 1x it is centred and there is nothing to pan. Zoomed, the offset is bounded by the half
 * of the image that hangs outside the frame - without it a drag can throw the picture off the
 * screen entirely, and the only way back is to close the viewer.
 */
export function clampPan(transform: Transform, box: Box, natural: { width: number; height: number; }): Transform {
    const width = natural.width * transform.scale;
    const height = natural.height * transform.scale;
    const x = Math.max(0, (width - box.width) / 2);
    const y = Math.max(0, (height - box.height) / 2);

    return {
        scale: transform.scale,
        x: Math.min(Math.max(transform.x, -x), x),
        y: Math.min(Math.max(transform.y, -y), y)
    };
}

/** The size an image is DRAWN at inside a frame it is fitted to, which is what pan is bounded by. */
export function fittedSize(natural: { width: number; height: number; }, box: Box): { width: number; height: number; } {
    if (!natural.width || !natural.height) return { width: box.width, height: box.height };
    const ratio = Math.min(box.width / natural.width, box.height / natural.height, 1);
    return { width: natural.width * ratio, height: natural.height * ratio };
}

/** The distance between two pointers, for a pinch. */
export function pinchDistance(a: { x: number; y: number; }, b: { x: number; y: number; }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The next index in a set, skipping what has been discarded.
 *
 * Returns -1 when there is nothing left to show, which is the viewer's cue to close rather
 * than to sit on an empty frame.
 */
export function nextIndex(index: number, length: number, step: number, options: { loop?: boolean; skip?: ReadonlySet<number>; } = {}): number {
    const { loop = true, skip } = options;
    if (length <= 0) return -1;

    let next = index;
    // At most one full pass: with everything else discarded the walk would never stop.
    for (let moved = 0; moved < length; moved += 1) {
        next += step;
        if (next < 0 || next >= length) {
            if (!loop) return -1;
            next = (next % length + length) % length;
        }
        if (!skip?.has(next)) return next;
    }
    return -1;
}

/** The file name to save as: whatever the caller asked for, else the one in the URL. */
export function filenameFrom(url: string, fallback = "image"): string {
    try {
        const { pathname } = new URL(url, typeof location === "undefined" ? "https://localhost" : location.href);
        const name = pathname.split("/").filter(Boolean).pop();
        return name && name.includes(".") ? decodeURIComponent(name) : fallback;
    } catch {
        return fallback;
    }
}

/**
 * Save the file, rather than navigate to it.
 *
 * `<a download>` is honoured only for a same-origin URL; on a CDN the browser ignores the
 * attribute and opens the image in a tab instead, which is not what the row said it would do.
 * So the bytes are fetched and handed over as a blob, and the plain anchor is the fallback for
 * when that is refused (no CORS header) - a tab is still better than nothing happening.
 */
export async function downloadFile(url: string, filename?: string): Promise<void> {
    const name = filename ?? filenameFrom(url);
    try {
        const response = await fetch(url, { mode: "cors", credentials: "omit" });
        if (!response.ok) throw new Error(`the file answered ${response.status}`);
        const blob = await response.blob();
        const href = URL.createObjectURL(blob);
        saveAs(href, name);
        // Revoked on the next task, not immediately: Safari has not started reading yet.
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
        saveAs(url, name, true);
    }
}

function saveAs(href: string, name: string, external = false): void {
    if (typeof document === "undefined") return;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    anchor.rel = "noopener";
    if (external) anchor.target = "_blank";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
}

/**
 * A `data:` URL as the bytes it stands for.
 *
 * Synchronous on purpose: it is used to open a tab, and a window opened after an `await` is a
 * popup with no gesture behind it, which the browser blocks.
 */
export function dataUrlToBlob(url: string): Blob {
    const comma = url.indexOf(",");
    if (!url.startsWith("data:") || comma === -1) throw new Error("not a data URL");
    const head = url.slice("data:".length, comma);
    const body = url.slice(comma + 1);
    const base64 = head.endsWith(";base64");
    const type = (base64 ? head.slice(0, -";base64".length) : head) || "text/plain";
    if (!base64) return new Blob([decodeURIComponent(body)], { type });

    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return new Blob([bytes], { type });
}

/**
 * The picture on its own, in another tab.
 *
 * Chromium refuses a top-level navigation to a `data:` URL - it was a phishing vector - so a
 * row that just called `window.open` on one did nothing at all, silently, which is how it
 * shipped. Those are handed over as a blob instead; everything else opens as it is.
 *
 * `noopener` on both: the new tab must not get a handle on the page that opened it.
 */
export function openInNewTab(url: string): void {
    if (typeof window === "undefined") return;
    if (!url.startsWith("data:")) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
    }
    try {
        const href = URL.createObjectURL(dataUrlToBlob(url));
        window.open(href, "_blank", "noopener,noreferrer");
        // Revoked later, not now: the tab has not finished reading it yet.
        setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch {
        // Undecodable, or a blocked popup. Better the browser's own refusal than a throw.
        window.open(url, "_blank", "noopener,noreferrer");
    }
}

/* -------- the flight from the thumbnail into the viewer -------- */

/** How long the picture takes to fly, when the stylesheet does not say otherwise. */
export const FLIGHT_MS = 300;

/**
 * How long the flight ACTUALLY lasts, read off the element.
 *
 * The duration lives in the stylesheet (`--enigma-image-flight`), so a project that slows it
 * down would otherwise have the viewer give up waiting halfway through and close mid-flight.
 * The constant above is only the answer for an element with no transition on it at all.
 */
export function flightMs(element: Element | null): number {
    if (!element || typeof getComputedStyle === "undefined") return FLIGHT_MS;
    const seconds = Number.parseFloat(getComputedStyle(element).transitionDuration);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : FLIGHT_MS;
}

/**
 * The transform that puts a picture exactly over another box.
 *
 * This is the FLIP the lightbox opens with: the full-size image is laid out where it belongs,
 * measured, and then drawn back ON the thumbnail with this transform - so releasing it to the
 * identity transform is the picture growing out of the one in the page rather than a dialog
 * appearing over it. Closing is the same transform applied in the other direction.
 *
 * Both boxes are the same picture, so one scale is enough; the width is used because a
 * thumbnail is nearly always constrained by it. Null when either box has not been laid out
 * yet, which is the caller's cue to skip the animation rather than to divide by zero.
 */
export function flightFrom(from: Box, to: Box): Transform | null {
    if (!from.width || !from.height || !to.width || !to.height) return null;
    return {
        scale: from.width / to.width,
        // Centre to centre: `translate(x, y) scale(s)` scales about the element's own centre
        // first, so the offset that lands it on the thumbnail is the distance between them.
        x: (from.left + from.width / 2) - (to.left + to.width / 2),
        y: (from.top + from.height / 2) - (to.top + to.height / 2)
    };
}

/** Whether the reader has asked for less movement. Every animation here is skipped when they have. */
export function prefersReducedMotion(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
