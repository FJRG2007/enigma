import test from "node:test";
import assert from "node:assert/strict";
import { parseColor, formatColor, toHex, rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb, colorEquals } from "../dist/index.js";

/**
 * The colour arithmetic behind `<Input type="color">`.
 *
 * Every case here is one the picker walks into: a half-typed hex, a value pasted out of
 * devtools in the space syntax, and the grey where the hue stops existing.
 */

const BLUE = { r: 59, g: 130, b: 246, a: 1 };

test("hex is read in every length HTML allows, and in none it does not", () => {
    assert.deepEqual(parseColor("#3b82f6"), BLUE);
    // No `#`, upper case, padding: what people actually type into a field.
    assert.deepEqual(parseColor("  3B82F6 "), BLUE);
    assert.deepEqual(parseColor("#39f"), { r: 51, g: 153, b: 255, a: 1 });
    assert.deepEqual(parseColor("#39f8"), { r: 51, g: 153, b: 255, a: 136 / 255 });
    assert.deepEqual(parseColor("#3b82f680"), { r: 59, g: 130, b: 246, a: 128 / 255 });

    // Five and seven digits are REFUSED rather than padded: a truncated paste is the usual
    // way to arrive at one, and inventing the missing digit invents a colour.
    assert.equal(parseColor("#3b82f"), null);
    assert.equal(parseColor("#3b82f6a"), null);
    assert.equal(parseColor("#3b"), null);
    assert.equal(parseColor("#zzzzzz"), null);
});

test("rgb() and hsl() are read in both the legacy and the modern syntax", () => {
    assert.deepEqual(parseColor("rgb(59, 130, 246)"), BLUE);
    // The space-and-slash form, which is what devtools puts on the clipboard.
    assert.deepEqual(parseColor("rgb(59 130 246 / 50%)"), { ...BLUE, a: 0.5 });
    assert.deepEqual(parseColor("rgba(59, 130, 246, 0.5)"), { ...BLUE, a: 0.5 });
    assert.deepEqual(parseColor("rgb(100%, 0%, 0%)"), { r: 255, g: 0, b: 0, a: 1 });

    const hsl = parseColor("hsl(217, 91%, 60%)");
    assert.ok(hsl && Math.abs(hsl.r - 59) <= 1 && Math.abs(hsl.g - 130) <= 1 && Math.abs(hsl.b - 246) <= 1);
    assert.deepEqual(parseColor("hsl(0, 0%, 0%)"), { r: 0, g: 0, b: 0, a: 1 });
});

test("transparent is a colour; a space this cannot represent is not", () => {
    assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
    // Refused rather than clipped into sRGB: handing back a hex for a colour a hex cannot
    // hold would change the value silently, which is worse than reporting it unparseable.
    assert.equal(parseColor("oklch(70% 0.1 200)"), null);
    assert.equal(parseColor("color(display-p3 1 0 0)"), null);
    assert.equal(parseColor("rebeccapurple"), null);
    assert.equal(parseColor(""), null);
    assert.equal(parseColor("#"), null);
});

test("a colour is written in the format asked for, with alpha only when it is wanted", () => {
    assert.equal(formatColor(BLUE), "#3b82f6");
    assert.equal(formatColor(BLUE, "rgb"), "rgb(59, 130, 246)");
    assert.equal(formatColor(BLUE, "hsl"), "hsl(217, 91%, 60%)");

    const half = { ...BLUE, a: 0.5 };
    // Off by default: alpha turns `#3b82f6` into eight digits, which is not what a column
    // typed as a seven-character hex takes.
    assert.equal(formatColor(half), "#3b82f6");
    assert.equal(formatColor(half, "hex", { alpha: true }), "#3b82f680");
    assert.equal(formatColor(half, "rgb", { alpha: true }), "rgba(59, 130, 246, 0.5)");
    assert.equal(toHex({ r: 0, g: 0, b: 0, a: 0 }, { alpha: true }), "#00000000");
});

test("the hue survives black, white and every grey", () => {
    // THE colour picker bug: hue is undefined with no dominant channel, so recomputing it
    // from the bytes answers 0 - red - and the rail jumps to red the moment the square is
    // dragged into a corner. The hue in hand is what the fallback carries through.
    assert.equal(rgbToHsv({ r: 0, g: 0, b: 0, a: 1 }, 217).h, 217);
    assert.equal(rgbToHsv({ r: 255, g: 255, b: 255, a: 1 }, 217).h, 217);
    assert.equal(rgbToHsv({ r: 128, g: 128, b: 128, a: 1 }, 217).h, 217);
    // And it is still MEASURED wherever it can be.
    assert.ok(Math.abs(rgbToHsv(BLUE, 0).h - 217) < 1);
});

test("HSV and HSL round-trip through sRGB without drifting", () => {
    for (const colour of [BLUE, { r: 255, g: 0, b: 0, a: 1 }, { r: 12, g: 200, b: 90, a: 0.25 }, { r: 7, g: 7, b: 7, a: 1 }]) {
        assert.ok(colorEquals(hsvToRgb(rgbToHsv(colour)), colour), `hsv ${JSON.stringify(colour)}`);
        assert.ok(colorEquals(hslToRgb(rgbToHsl(colour)), colour), `hsl ${JSON.stringify(colour)}`);
    }

    // Saturation is not shared between the two models: copying it across instead of
    // converting flattens a vivid colour, so the two numbers must differ here.
    const hsv = rgbToHsv({ r: 191, g: 219, b: 254, a: 1 });
    const hsl = rgbToHsl({ r: 191, g: 219, b: 254, a: 1 });
    assert.ok(hsl.s > hsv.s);
});

test("two colours are the same when their bytes are, whatever they were written as", () => {
    assert.ok(colorEquals(parseColor("#39f"), parseColor("rgb(51, 153, 255)")));
    assert.ok(colorEquals(null, null));
    assert.ok(!colorEquals(null, BLUE));
    assert.ok(!colorEquals(BLUE, { ...BLUE, a: 0.5 }));
});
