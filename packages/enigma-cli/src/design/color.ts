/**
 * Color parsing shared by every extractor. Everything is normalized to a lowercase
 * 6-digit hex (`#rrggbb`) so tokens from CSS, config files and computed styles merge
 * on one key; alpha is dropped on purpose (a design palette is about the hue).
 */

export interface Rgb { r: number; g: number; b: number; }

const NAMED_COLORS: Record<string, string | null> = {
    black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
    blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
    gray: "#808080", grey: "#808080", pink: "#ffc0cb", brown: "#a52a2a",
    cyan: "#00ffff", magenta: "#ff00ff", transparent: null, none: null,
    currentcolor: null, inherit: null,
};

/** `#abc` -> `#aabbcc`; longer forms are lowercased and cut to `#rrggbb` (alpha dropped). */
export function normalizeHex(value: string): string {
    const short = value.match(/^#([0-9a-fA-F]{3})$/);
    if (short) {
        const [r, g, b] = short[1]!.split("");
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return value.toLowerCase().slice(0, 7);
}

export function isValidHex(hex: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(hex);
}

/** True for the literal color forms a config value can hold: hex, rgb(a), hsl(a). */
export function isColorLiteral(value: string): boolean {
    return /^#([0-9a-fA-F]{3,8})$/.test(value) || /^rgb/i.test(value) || /^hsl/i.test(value);
}

export function rgbToHex(r: number, g: number, b: number): string {
    return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

export function hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return rgbToHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}

export function hexToRgb(hex: string): Rgb | null {
    const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
    if (!match) return null;
    return { r: parseInt(match[1]!, 16), g: parseInt(match[2]!, 16), b: parseInt(match[3]!, 16) };
}

/**
 * A single color value (hex, rgb(), hsl(), or the bare `220 20% 10%` triple shadcn-style
 * variables hold) to `#rrggbb`, or null when the value is not one color.
 */
export function tryParseColor(value: string): string | null {
    if (/^#([0-9a-fA-F]{3,8})$/.test(value)) return normalizeHex(value);
    const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgb) return rgbToHex(parseInt(rgb[1]!), parseInt(rgb[2]!), parseInt(rgb[3]!));
    const hsl = value.match(/^hsla?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%/);
    if (hsl) return hslToHex(parseFloat(hsl[1]!), parseFloat(hsl[2]!), parseFloat(hsl[3]!));
    const bare = value.match(/^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/);
    if (bare) return hslToHex(parseFloat(bare[1]!), parseFloat(bare[2]!), parseFloat(bare[3]!));
    return null;
}

export function namedColorToHex(name: string): string | null {
    return NAMED_COLORS[name.toLowerCase()] ?? null;
}

/** Every hex and rgb() color inside a free-form value (a shorthand, a style attribute). */
export function colorsIn(value: string): string[] {
    const out: string[] = [];
    for (const m of value.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) out.push(normalizeHex(m[0]));
    for (const m of value.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
        out.push(rgbToHex(parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)));
    }
    return out;
}

/** Hue (degrees), saturation and lightness (0..1) of a hex color. */
export function hsl(hex: string): { hue: number; saturation: number; lightness: number; } {
    const rgb = hexToRgb(hex);
    if (!rgb) return { hue: 0, saturation: 0, lightness: 0 };
    const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (max === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
    }
    return { hue: h, saturation: s, lightness: l };
}

export function colorDistance(a: Rgb, b: Rgb): number {
    return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
