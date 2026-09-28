/**
 * Where a floating panel goes: below or above the thing that opened it, inside the window.
 *
 * One function for every popup here - the select's list, the colour picker, the context menu
 * - because they are the same question with different anchors. The select and the picker
 * hang from a trigger's box; the context menu hangs from the pointer, which is the same box
 * with no size. Pure arithmetic on rectangles, so it has no DOM and no framework: the React
 * half that measures and applies it is `react/floating.ts`.
 */

/** A box in viewport coordinates, the shape `getBoundingClientRect()` returns. */
export interface FloatingRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export type FloatingSide = "top" | "bottom";

export interface FloatingOptions {
    /** The area the panel has to stay inside - the window, or less when something clips it. */
    boundary: FloatingRect;
    /** Kept clear of the boundary's edge, so a panel never sits flush against it. */
    margin?: number;
    /** Between the anchor and the panel. */
    gap?: number;
    /** A side the caller insists on. `"auto"` (the default) measures. */
    side?: FloatingSide | "auto";
}

export interface FloatingPlacement {
    left: number;
    top: number;
    side: FloatingSide;
    /**
     * The tallest the panel can be on that side without leaving the boundary. Applied as a
     * `max-height`, so a list longer than the room scrolls inside the panel instead of
     * running off the screen where its last rows cannot be reached.
     */
    maxHeight: number;
}

/**
 * Below when it fits, above when it does not and there is more room there.
 *
 * Flipped only when the other side is genuinely roomier: near the bottom of the window an
 * unflipped panel hangs off the screen, but flipping a panel that fits neither way into the
 * SMALLER side just moves the problem. Whichever side wins, `maxHeight` is the room it has.
 *
 * Horizontally it starts at the anchor's left edge and flips to end at its right edge when
 * it would run past the window - flipped rather than dragged back, because a context menu
 * dragged back to fit sits under the pointer and the release chooses its first row. The
 * clamp after it only matters for a panel wider than the room on both sides.
 */
export function placeFloating(anchor: FloatingRect, size: { width: number; height: number; }, options: FloatingOptions): FloatingPlacement {
    const { boundary, margin = 8, gap = 0, side = "auto" } = options;
    const below = boundary.bottom - margin - anchor.bottom - gap;
    const above = anchor.top - gap - boundary.top - margin;
    const chosen: FloatingSide = side !== "auto" ? side : size.height <= below || below >= above ? "bottom" : "top";
    const maxHeight = Math.max(0, Math.floor(chosen === "bottom" ? below : above));
    const height = Math.min(size.height, maxHeight);
    const top = chosen === "bottom" ? anchor.bottom + gap : anchor.top - gap - height;

    const maxLeft = boundary.right - margin - size.width;
    let left = anchor.left;
    if (left > maxLeft) left = anchor.right - size.width;
    left = Math.max(boundary.left + margin, Math.min(left, maxLeft));

    return { left: Math.round(left), top: Math.round(top), side: chosen, maxHeight };
}
