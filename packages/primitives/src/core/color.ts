/**
 * Reading a colour, writing one, and converting between the two models a picker needs.
 *
 * Arithmetic only, like every other core here: no DOM, no framework. The picker drags a
 * saturation/value square and a hue rail, which are HSV; a form field holds `#3b82f6`,
 * `rgb(59, 130, 246)` or an `hsl()`, which is what a stylesheet and a database take. This
 * module is the translation between them.
 *
 * Two things it does NOT do, both on purpose:
 *
 * - **Named colours.** `red`, `rebeccapurple` and the other 146 are a table nobody needs in
 *   a bundle to drag a square, and the DOM already resolves them for free (assign the name
 *   to `style.color` and read it back). The picker's canonical value is a hex string.
 * - **Colour spaces past sRGB.** `oklch()` and `color()` describe colours a hex cannot, so
 *   accepting one here and handing back `#rrggbb` would silently clip it. Parsing returns
 *   null instead, which the field reports as unparseable rather than as a different colour.
 */

/** sRGB, 0-255 per channel, with alpha 0-1. The transport shape everything converts through. */
export interface Rgb {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** Hue 0-360, saturation and value 0-1, alpha 0-1. What the picker's two controls move. */
export interface Hsv {
    h: number;
    s: number;
    v: number;
    a: number;
}

/** Hue 0-360, saturation and lightness 0-1, alpha 0-1. Only used by `hsl()` in and out. */
export interface Hsl {
    h: number;
    s: number;
    l: number;
    a: number;
}

/** How a colour is written back into the field. */
export type ColorFormat = "hex" | "rgb" | "hsl";

export interface FormatColorOptions {
    /** Write the alpha channel. Off drops it, so a half-transparent colour becomes opaque. */
    alpha?: boolean;
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

/** 0-1, and never NaN: an unparsed alpha must not travel as one and poison every later sum. */
function clampAlpha(value: number): number {
    return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
}

function channel(value: number): number {
    return Math.round(clamp(value, 0, 255));
}

/** `"50%"` -> 0.5, `"0.5"` -> 0.5. Both spellings are legal for every CSS component. */
function ratio(token: string, scale: number): number {
    const text = token.trim();
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return Number.NaN;
    return text.endsWith("%") ? (value / 100) * scale : value;
}

/**
 * The components inside `rgb(...)` / `hsl(...)`, however they are punctuated.
 *
 * CSS Color 4 allows `rgb(0 0 0 / 50%)` beside the legacy `rgba(0, 0, 0, 0.5)`, and both
 * turn up in real stylesheets - a value pasted out of devtools is usually the space form.
 * Splitting on the separators rather than matching one syntax accepts them both without a
 * second regular expression to keep in step with the first.
 */
function components(body: string): string[] {
    return body.split(/[\s,/]+/).map((part) => part.trim()).filter(Boolean);
}

/**
 * A colour string to sRGB, or null when it is not one.
 *
 * Null is the whole point of the return type: a field is unparseable for as long as someone
 * is halfway through typing `#3b8`, and a picker that guesses at that moment fights the
 * caret. Everything here is tolerant of what a person types - a missing `#`, upper case,
 * stray spaces - and intolerant of what would be a guess.
 */
export function parseColor(input: string): Rgb | null {
    const text = input.trim().toLowerCase();
    if (!text) return null;

    // The one keyword worth a line: it is what an empty colour is called everywhere in CSS,
    // and a picker that cannot read back what it wrote for alpha 0 is broken.
    if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

    const hex = /^#?([0-9a-f]+)$/.exec(text);
    if (hex) return fromHex(hex[1]);

    const functional = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
    if (!functional) return null;

    const parts = components(functional[2]);
    if (parts.length < 3 || parts.length > 4) return null;
    const alpha = parts.length === 4 ? clampAlpha(ratio(parts[3], 1)) : 1;

    if (functional[1].startsWith("rgb")) {
        const values = parts.slice(0, 3).map((part) => ratio(part, 255));
        if (values.some((value) => !Number.isFinite(value))) return null;
        return { r: channel(values[0]), g: channel(values[1]), b: channel(values[2]), a: alpha };
    }

    // `hsl(210deg 40% 96%)`. The angle units past degrees are rare enough in hand-written CSS
    // that supporting them would be speculative; a plain number is degrees, which is the rule
    // CSS itself uses.
    const hue = Number.parseFloat(parts[0]);
    const saturation = ratio(parts[1], 1);
    const lightness = ratio(parts[2], 1);
    if (!Number.isFinite(hue) || !Number.isFinite(saturation) || !Number.isFinite(lightness)) return null;
    return hslToRgb({ h: hue, s: clamp(saturation, 0, 1), l: clamp(lightness, 0, 1), a: alpha });
}

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` - and nothing else.
 *
 * Five and seven digits are REFUSED rather than padded. A truncated paste is the common way
 * to arrive at one, and inventing the missing digit produces a colour nobody chose.
 */
function fromHex(digits: string): Rgb | null {
    const size = digits.length;
    if (size !== 3 && size !== 4 && size !== 6 && size !== 8) return null;

    const short = size <= 4;
    const at = (index: number): number => {
        const slice = short ? digits[index].repeat(2) : digits.slice(index * 2, index * 2 + 2);
        return Number.parseInt(slice, 16);
    };
    const alpha = size === 4 || size === 8 ? at(3) / 255 : 1;
    return { r: at(0), g: at(1), b: at(2), a: clampAlpha(alpha) };
}

/** `#rrggbb`, or `#rrggbbaa` when alpha is asked for and the colour is not opaque. */
export function toHex(color: Rgb, options: FormatColorOptions = {}): string {
    const pair = (value: number): string => channel(value).toString(16).padStart(2, "0");
    const alpha = clampAlpha(color.a);
    const suffix = options.alpha && alpha < 1 ? pair(Math.round(alpha * 255)) : "";
    return `#${pair(color.r)}${pair(color.g)}${pair(color.b)}${suffix}`;
}

/**
 * A colour back to a string.
 *
 * The legacy comma syntax for `rgb()` and `hsl()`, deliberately: this string is going into a
 * field someone will paste into a stylesheet, a spreadsheet or an older toolchain, and the
 * space-and-slash form is the one those still refuse.
 */
export function formatColor(color: Rgb, format: ColorFormat = "hex", options: FormatColorOptions = {}): string {
    const alpha = clampAlpha(color.a);
    const opaque = !options.alpha || alpha >= 1;
    // Three decimals: enough to survive a round trip through a hex byte (1/255), short enough
    // that the field does not fill up with digits nobody chose.
    const printed = Number.parseFloat(alpha.toFixed(3));

    if (format === "hex") return toHex(color, options);
    if (format === "rgb") {
        const body = `${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}`;
        return opaque ? `rgb(${body})` : `rgba(${body}, ${printed})`;
    }

    const hsl = rgbToHsl(color);
    const body = `${Math.round(hsl.h)}, ${Math.round(hsl.s * 100)}%, ${Math.round(hsl.l * 100)}%`;
    return opaque ? `hsl(${body})` : `hsla(${body}, ${printed})`;
}

/**
 * sRGB to HSV, keeping a hue the arithmetic cannot see.
 *
 * THE colour picker bug, and it is in almost every hand-rolled one: hue is undefined at
 * black, at white and at every grey, because those have no dominant channel. Recomputing it
 * from the RGB therefore returns 0 - red - so dragging the square into its bottom-left
 * corner and back out again resets a hue the visitor picked, and the rail jumps under their
 * finger. `fallbackHue` is the hue they last chose, and it is what the picker keeps its own
 * state for.
 */
export function rgbToHsv(color: Rgb, fallbackHue = 0): Hsv {
    const r = clamp(color.r, 0, 255) / 255;
    const g = clamp(color.g, 0, 255) / 255;
    const b = clamp(color.b, 0, 255) / 255;
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);

    let h = fallbackHue;
    if (span > 0) {
        if (max === r) h = ((g - b) / span) % 6;
        else if (max === g) h = (b - r) / span + 2;
        else h = (r - g) / span + 4;
        h *= 60;
        if (h < 0) h += 360;
    }

    return { h, s: max === 0 ? 0 : span / max, v: max, a: clampAlpha(color.a) };
}

export function hsvToRgb(color: Hsv): Rgb {
    const h = ((color.h % 360) + 360) % 360;
    const s = clamp(color.s, 0, 1);
    const v = clamp(color.v, 0, 1);

    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0]
        : h < 120 ? [x, c, 0]
            : h < 180 ? [0, c, x]
                : h < 240 ? [0, x, c]
                    : h < 300 ? [x, 0, c]
                        : [c, 0, x];

    return { r: channel((r + m) * 255), g: channel((g + m) * 255), b: channel((b + m) * 255), a: clampAlpha(color.a) };
}

/** sRGB to HSL. Same undefined hue at the greys, same reason to pass the one being kept. */
export function rgbToHsl(color: Rgb, fallbackHue = 0): Hsl {
    const hsv = rgbToHsv(color, fallbackHue);
    const l = hsv.v * (1 - hsv.s / 2);
    // Saturation is not shared between the two models: at the same hue, HSL's denominator is
    // how far the lightness is from black OR white, which is why a "vivid" HSV colour flattens
    // if its saturation is copied across instead of converted.
    const s = l === 0 || l === 1 ? 0 : (hsv.v - l) / Math.min(l, 1 - l);
    return { h: hsv.h, s: clamp(s, 0, 1), l, a: hsv.a };
}

export function hslToRgb(color: Hsl): Rgb {
    const s = clamp(color.s, 0, 1);
    const l = clamp(color.l, 0, 1);
    const v = l + s * Math.min(l, 1 - l);
    return hsvToRgb({ h: color.h, s: v === 0 ? 0 : 2 * (1 - l / v), v, a: color.a });
}

/** Same colour, to the byte. Used to tell a value the picker wrote from one someone typed. */
export function colorEquals(a: Rgb | null, b: Rgb | null): boolean {
    if (!a || !b) return a === b;
    return channel(a.r) === channel(b.r) && channel(a.g) === channel(b.g) && channel(a.b) === channel(b.b)
        && Math.round(clampAlpha(a.a) * 255) === Math.round(clampAlpha(b.a) * 255);
}
