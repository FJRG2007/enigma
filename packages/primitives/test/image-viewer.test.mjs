import test from "node:test";
import assert from "node:assert/strict";
import {
    zoomAt, clampPan, clampScale, wheelFactor, fittedSize, nextIndex, filenameFrom, IDENTITY, ZOOM_LIMITS
} from "../dist/index.js";

/**
 * The image viewer's arithmetic, without a browser.
 *
 * Every case here is a defect somebody has shipped: zoom that walks away from the cursor, a
 * pan that strands the picture off screen, a "next" that stops on a discarded image, and a
 * download that saves a file called `download`.
 */

const BOX = { left: 0, top: 0, width: 400, height: 300 };

test("zoom keeps the point under the pointer where it was", () => {
    // Zooming on the top-left corner has to pull the image DOWN and RIGHT, or what was under
    // the cursor slides away from it.
    const zoomed = zoomAt(IDENTITY, 2, { x: 0, y: 0 }, BOX);
    assert.equal(zoomed.scale, 2);
    assert.equal(zoomed.x, 200);
    assert.equal(zoomed.y, 150);

    // The frame's centre is the fixed point of a centred zoom: nothing moves.
    const middle = zoomAt(IDENTITY, 2, { x: 200, y: 150 }, BOX);
    assert.deepEqual(middle, { scale: 2, x: 0, y: 0 });
});

test("zoom respects the limits, and stops rather than creeping", () => {
    assert.equal(clampScale(0.2), ZOOM_LIMITS.min);
    assert.equal(clampScale(99), ZOOM_LIMITS.max);
    const capped = zoomAt({ scale: 8, x: 10, y: 10 }, 2, { x: 0, y: 0 }, BOX);
    assert.equal(capped.scale, 8);
    // The offsets are the ones it already had: a refused zoom must not move the picture.
    assert.deepEqual(capped, { scale: 8, x: 10, y: 10 });
});

test("a wheel notch is the same size whatever the browser reports it in", () => {
    const pixels = wheelFactor(-100, 0);
    const lines = wheelFactor(-100 / 16, 1);
    assert.ok(Math.abs(pixels - lines) < 0.001, `${pixels} vs ${lines}`);
    // Up zooms in, down zooms out, and a huge delta cannot jump the whole range at once.
    assert.ok(wheelFactor(-100) > 1);
    assert.ok(wheelFactor(100) < 1);
    assert.ok(wheelFactor(-100_000) < 2.2);
});

test("panning cannot push the picture out of its frame", () => {
    const fitted = fittedSize({ width: 800, height: 600 }, BOX);
    assert.deepEqual(fitted, { width: 400, height: 300 });

    // At 1x there is nothing hanging outside, so every offset clamps back to centred.
    assert.deepEqual(clampPan({ scale: 1, x: 300, y: 300 }, BOX, fitted), { scale: 1, x: 0, y: 0 });

    // The bound is measured on the DRAWN size, which is what `fittedSize` answers: at 2x half
    // of a 400x300 picture hangs outside, so 200px each way and no further.
    const panned = clampPan({ scale: 2, x: 5000, y: -5000 }, BOX, fitted);
    assert.deepEqual(panned, { scale: 2, x: 200, y: -150 });
});

test("a picture smaller than the frame is not blown up to fill it", () => {
    assert.deepEqual(fittedSize({ width: 100, height: 50 }, BOX), { width: 100, height: 50 });
});

test("next and previous walk the set, wrapping only when asked", () => {
    assert.equal(nextIndex(0, 3, 1), 1);
    assert.equal(nextIndex(2, 3, 1), 0);
    assert.equal(nextIndex(0, 3, -1), 2);
    assert.equal(nextIndex(2, 3, 1, { loop: false }), -1);
    assert.equal(nextIndex(0, 0, 1), -1);
});

test("discarded images are stepped over, and an empty set answers -1", () => {
    const skip = new Set([1, 2]);
    assert.equal(nextIndex(0, 4, 1, { skip }), 3);
    assert.equal(nextIndex(3, 4, -1, { skip }), 0);
    // Everything else discarded: the walk stops instead of circling forever.
    assert.equal(nextIndex(0, 3, 1, { skip: new Set([0, 1, 2]) }), -1);
});

test("the file name comes from the URL, and never from a query string", () => {
    assert.equal(filenameFrom("https://cdn.example.com/photos/holiday.jpg?w=800"), "holiday.jpg");
    assert.equal(filenameFrom("https://cdn.example.com/photos/a%20b.png"), "a b.png");
    // Nothing that looks like a file: the caller's fallback, not a name invented from the path.
    assert.equal(filenameFrom("https://example.com/photos/", "picture"), "picture");
    assert.equal(filenameFrom("not a url at all", "picture"), "picture");
});
