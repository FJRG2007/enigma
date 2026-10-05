/**
 * Design signals in a page's HTML (and in JS modules a single-page app inlines as base64
 * data URLs): inline style colors, `light-dark()` pairs, theme meta colors, favicon and
 * title, Google Fonts links, page sections, and Tailwind classes used by rendered markup.
 */

import { addColor } from "../raw-tokens";
import type { RawTokens } from "../types";
import { isGenericFont } from "../font-names";
import { guessPropertyType, isColorVarName } from "./css-tokens";
import { colorsIn, isValidHex, namedColorToHex, normalizeHex, rgbToHex, tryParseColor } from "../color";

const TW_COLORS: Record<string, string> = {
    "black": "#000000", "white": "#ffffff",
    "gray-100": "#f3f4f6", "gray-200": "#e5e7eb", "gray-300": "#d1d5db", "gray-400": "#9ca3af", "gray-500": "#6b7280",
    "gray-600": "#4b5563", "gray-700": "#374151", "gray-800": "#1f2937", "gray-900": "#111827",
    "red-500": "#ef4444", "red-600": "#dc2626", "blue-500": "#3b82f6", "green-500": "#22c55e",
};
const TW_TEXT_SIZES: Record<string, string> = {
    "text-xs": "12px", "text-sm": "14px", "text-base": "16px", "text-lg": "18px", "text-xl": "20px",
    "text-2xl": "24px", "text-3xl": "30px", "text-4xl": "36px", "text-5xl": "48px",
};
const TW_RADII: Record<string, string> = {
    "rounded-none": "0px", "rounded-sm": "2px", "rounded": "4px", "rounded-md": "6px", "rounded-lg": "8px",
    "rounded-xl": "12px", "rounded-2xl": "16px", "rounded-3xl": "24px", "rounded-full": "9999px",
};
const FONT_UTILITY_KEYWORDS = new Set(["mono", "sans", "serif", "bold", "black", "medium", "semibold", "light", "thin", "extrabold"]);

/** Colors in `style="..."` attributes, plus `light-dark()` declarations anywhere in the page. */
export function extractInlineColors(html: string, tokens: RawTokens): void {
    for (const m of html.matchAll(/style\s*=\s*["']([^"']+)["']/gi)) for (const hex of colorsIn(m[1]!)) addColor(tokens, hex, "css");
    // `light-dark(a, b)`: the first argument is the light scheme's value.
    for (const m of html.matchAll(/(background|color|border-color)\s*:\s*light-dark\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/gi)) {
        const light = m[2]!.trim();
        const hex = tryParseColor(light) ?? namedColorToHex(light);
        if (!hex) continue;
        const prop = m[1]!.toLowerCase();
        addColor(tokens, hex, "css", prop === "background" ? "light-bg" : prop === "color" ? "light-text" : "light-default");
    }
    const scheme = html.match(/color-scheme\s*:\s*([^;}\n]+)/i);
    if (scheme && scheme[1]!.trim().toLowerCase().startsWith("light") && !tokens.cssVariables.some((v) => v.name === "--color-scheme-default")) {
        tokens.cssVariables.push({ name: "--color-scheme-default", value: "light", property: "color" });
    }
}

function metaContent(html: string, attr: string, value: string): string | null {
    const re = new RegExp(`<meta[^>]+${attr}\\s*=\\s*["']${value}["'][^>]+content\\s*=\\s*["']([^"']+)["']`, "i");
    const reversed = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]+${attr}\\s*=\\s*["']${value}["']`, "i");
    return html.match(re)?.[1] ?? html.match(reversed)?.[1] ?? null;
}

/** theme-color / tile color, the favicon href and the page title. */
export function extractMeta(html: string, tokens: RawTokens): void {
    const theme = metaContent(html, "name", "theme-color");
    const themeHex = theme ? tryParseColor(theme) : null;
    if (themeHex) addColor(tokens, themeHex, "css", "theme-color");
    const tile = metaContent(html, "name", "msapplication-TileColor");
    const tileHex = tile ? tryParseColor(tile) : null;
    if (tileHex) addColor(tokens, tileHex, "css", "tile-color");

    if (!tokens.favicon) {
        const icon = html.match(/<link[^>]+rel\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]+href\s*=\s*["']([^"']+)["']/i)
            ?? html.match(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["'][^"']*\bicon\b[^"']*["']/i);
        tokens.favicon = icon?.[1]?.split("?")[0]?.trim() || "/favicon.ico";
    }
    if (!tokens.siteTitle) {
        const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? metaContent(html, "property", "og:title");
        if (title) tokens.siteTitle = decodeEntities(title.trim());
    }
}

function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Families requested from Google Fonts `<link>`s (css and css2 APIs). */
export function extractFontLinks(html: string, tokens: RawTokens): void {
    for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/gi)) {
        const query = m[1]!.replace(/&amp;/g, "&");
        for (const param of query.split("&")) {
            if (!param.startsWith("family=")) continue;
            let value: string;
            try { value = decodeURIComponent(param.slice(7)); } catch { value = param.slice(7); }
            for (const family of value.split("|")) {
                const name = family.split(":")[0]!.replace(/\+/g, " ").trim();
                if (name && !tokens.fonts.some((f) => f.family === name)) tokens.fonts.push({ family: name, source: "css" });
            }
        }
    }
}

function countChildLinks(html: string, tag: string): number {
    const inner = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
    return inner ? (inner.match(/<a\s/gi) ?? []).length : 0;
}

export function countClassUses(html: string, classPattern: string): number {
    return (html.match(new RegExp(`class\\s*=\\s*["'][^"']*\\b${classPattern}\\b`, "gi")) ?? []).length;
}

/** The sections a page is built from, by semantic tags and conventional class names. */
export function detectPageSections(html: string, tokens: RawTokens): void {
    const push = (section: RawTokens["pageSections"][number]): void => { tokens.pageSections.push(section); };
    const classMatch = (words: string): RegExpMatchArray | null => html.match(new RegExp(`class\\s*=\\s*["'][^"']*\\b(${words})\\b[^"']*["']`, "i"));

    const nav = html.match(/<nav[^>]*class\s*=\s*["']([^"']*)["'][^>]*>/i);
    if (nav || /<nav[\s>]/i.test(html)) {
        push({ type: "navigation", tag: "nav", classes: nav ? nav[1]!.split(/\s+/).filter(Boolean) : [], childCount: countChildLinks(html, "nav"), description: "Top navigation bar" });
    }
    const hero = classMatch("hero|banner|jumbotron|masthead");
    if (hero) push({ type: "hero", tag: "section", classes: [hero[1]!], childCount: 0, description: "Hero/banner section with headline and CTAs" });
    else if (/<(h1|h2)[^>]*>[\s\S]{5,}<\/(h1|h2)>/i.test(html)) {
        push({ type: "hero", tag: "section", classes: [], childCount: 0, description: "Hero section (detected from heading structure)" });
    }
    const features = classMatch("features?|benefits?|cards?-grid|card-container");
    if (features) push({ type: "features", tag: "section", classes: [features[1]!], childCount: countClassUses(html, "card"), description: "Feature/benefit cards grid" });
    const faq = classMatch("faq|accordion|questions");
    if (faq || /FAQ|Frequently Asked/i.test(html)) push({ type: "faq", tag: "section", classes: faq ? [faq[1]!] : ["faq"], childCount: 0, description: "FAQ/accordion section" });
    const footer = html.match(/<footer[^>]*class\s*=\s*["']([^"']*)["'][^>]*>/i);
    if (footer || /<footer[\s>]/i.test(html)) {
        push({ type: "footer", tag: "footer", classes: footer ? footer[1]!.split(/\s+/).filter(Boolean) : [], childCount: countChildLinks(html, "footer"), description: "Page footer with links and info" });
    }
    const cta = classMatch("cta|call-to-action|signup");
    if (cta) push({ type: "cta", tag: "section", classes: [cta[1]!], childCount: 0, description: "Call-to-action section" });
    const stats = classMatch("stats|metrics|numbers|counters");
    if (stats) push({ type: "stats", tag: "section", classes: [stats[1]!], childCount: 0, description: "Statistics/metrics display" });
    const testimonials = classMatch("testimonials?|reviews?|quotes?");
    if (testimonials) push({ type: "testimonials", tag: "section", classes: [testimonials[1]!], childCount: 0, description: "Testimonials/reviews section" });
    if (!tokens.pageSections.some((s) => s.type === "cards" || s.type === "features")) {
        const cards = countClassUses(html, "card");
        if (cards >= 3) push({ type: "cards", tag: "div", classes: ["card"], childCount: cards, description: `Grid of ${cards} card elements` });
    }
}

/** Colors, CSS variables and SVG paints inside a bundled JS module. */
function extractJsColors(js: string, tokens: RawTokens): void {
    for (const m of js.matchAll(/["'`](#[0-9a-fA-F]{3,8})["'`]/g)) {
        const hex = normalizeHex(m[1]!);
        if (isValidHex(hex)) addColor(tokens, hex, "css");
    }
    for (const m of js.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) addColor(tokens, rgbToHex(parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)), "css");
    for (const m of js.matchAll(/(--[\w-]+)\s*:\s*([^;}\n"'`]+)/g)) {
        const name = m[1]!, value = m[2]!.trim();
        if (!tokens.cssVariables.some((v) => v.name === name)) tokens.cssVariables.push({ name, value, property: guessPropertyType(name) });
        if (isColorVarName(name)) {
            const hex = tryParseColor(value);
            if (hex) addColor(tokens, hex, "css", name.replace(/^--/, ""));
        }
    }
    for (const m of js.matchAll(/(?:fill|stroke)\s*[:=]\s*["']([^"']+)["']/g)) {
        const value = m[1]!.trim();
        const hex = tryParseColor(value) ?? namedColorToHex(value);
        if (hex) addColor(tokens, hex, "css");
    }
}

/** Tokens implied by the Tailwind classes and inline style objects rendered markup uses. */
export function extractClassTokens(js: string, tokens: RawTokens): void {
    const classes: string[] = [];
    for (const m of js.matchAll(/className\s*[:=]\s*["'`]([^"'`]+)["'`]/g)) classes.push(...m[1]!.split(/\s+/).filter(Boolean));
    for (const m of js.matchAll(/className\s*[:=]\s*`([^`]+)`/g)) classes.push(...m[1]!.replace(/\$\{[^}]+\}/g, " ").split(/\s+/).filter(Boolean));
    const freq = new Map<string, number>();
    for (const cls of classes) freq.set(cls, (freq.get(cls) ?? 0) + 1);

    for (const cls of classes) {
        const arbColor = cls.match(/^(?:bg|text|border|fill|stroke)-\[#([0-9a-fA-F]{3,8})\]/);
        if (arbColor) addColor(tokens, normalizeHex(`#${arbColor[1]}`), "css");
        const named = cls.match(/^(?:bg|text|border)-(black|white|gray-\d+|red-\d+|blue-\d+|green-\d+)(?:\/\d+)?$/);
        if (named && TW_COLORS[named[1]!]) addColor(tokens, TW_COLORS[named[1]!]!, "css");

        const arbFont = cls.match(/^font-\[\s*'([^']+)'\s*\]/);
        if (arbFont && !tokens.fonts.some((f) => f.family === arbFont[1])) tokens.fonts.push({ family: arbFont[1]!, source: "css" });
        const fontUtility = cls.match(/^font-(mono|sans|serif|doto|bold|black|medium|semibold|light|thin|extrabold)$/);
        if (fontUtility) {
            const kind = fontUtility[1]!;
            if (kind === "mono" && !tokens.fonts.some((f) => f.family === "monospace")) tokens.fonts.push({ family: "monospace", source: "css" });
            if (!FONT_UTILITY_KEYWORDS.has(kind) && !tokens.fonts.some((f) => f.family.toLowerCase() === kind)) {
                tokens.fonts.push({ family: kind.charAt(0).toUpperCase() + kind.slice(1), source: "css" });
            }
        }

        const arbSize = cls.match(/^text-\[(\d+(?:px|rem))\]$/);
        if (arbSize) tokens.fonts.push({ family: "", size: arbSize[1], source: "css" });
        if (TW_TEXT_SIZES[cls]) tokens.fonts.push({ family: "", size: TW_TEXT_SIZES[cls], source: "css" });
        if (TW_RADII[cls] && !tokens.borderRadii.includes(TW_RADII[cls]!)) tokens.borderRadii.push(TW_RADII[cls]!);

        const shadow = cls.match(/^shadow-\[(.+)\]$/);
        if (shadow) {
            const value = shadow[1]!.replace(/_/g, " ");
            if (!tokens.shadows.some((s) => s.value === value)) tokens.shadows.push({ value });
        }
        const spacing = cls.match(/^(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-[xy])-(\d+(?:\.\d+)?)$/);
        if (spacing) {
            const px = parseFloat(spacing[1]!) * 4;
            if (px > 0 && px <= 200) tokens.spacingValues.push(Math.round(px));
        }
        const arbSpacing = cls.match(/^(?:p|px|py|m|mx|my|gap)-\[(\d+)px\]$/);
        if (arbSpacing) {
            const px = parseInt(arbSpacing[1]!);
            if (px > 0 && px <= 200) tokens.spacingValues.push(px);
        }
    }

    // A UI that leans on `font-mono` more than `font-sans` is set in a monospace face.
    const mono = freq.get("font-mono") ?? 0;
    if (mono > (freq.get("font-sans") ?? 0) && mono >= 3) {
        for (let i = 0; i <= mono; i++) tokens.fonts.push({ family: "monospace", source: "css" });
    }

    for (const m of js.matchAll(/fontFamily\s*:\s*["'`]([^"'`]+)["'`]/g)) {
        const family = m[1]!.split(",")[0]!.replace(/["']/g, "").trim();
        if (family.length > 1 && family.length < 50 && !isGenericFont(family) && !tokens.fonts.some((f) => f.family === family)) {
            tokens.fonts.push({ family, source: "css" });
        }
    }
    for (const m of js.matchAll(/borderRadius\s*:\s*["'`]?(\d+(?:px|rem|%)?)/g)) {
        const value = /px|rem|%/.test(m[1]!) ? m[1]! : `${m[1]}px`;
        if (!tokens.borderRadii.includes(value)) tokens.borderRadii.push(value);
    }
    for (const prop of ["padding", "margin", "gap", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "marginTop", "marginBottom"]) {
        for (const m of js.matchAll(new RegExp(`${prop}\\s*:\\s*["'\`]?(\\d+(?:px)?)`, "g"))) {
            const px = parseInt(m[1]!);
            if (px > 0 && px <= 200) tokens.spacingValues.push(px);
        }
    }
}

/** JS modules inlined as `data:application/javascript;base64,...`, decoded. */
export function decodeInlineModules(html: string): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(/data:application\/javascript;base64,([A-Za-z0-9+/=]+)/g)) {
        try { out.push(Buffer.from(m[1]!, "base64").toString("utf8")); } catch { /* not base64 */ }
    }
    return out;
}

/**
 * Tokens from a single-page app's inlined modules; CSS-looking template strings are
 * returned so the caller can parse them as stylesheets.
 */
export function extractInlineModules(html: string, tokens: RawTokens): string[] {
    const css: string[] = [];
    for (const js of decodeInlineModules(html)) {
        extractJsColors(js, tokens);
        extractClassTokens(js, tokens);
        for (const m of js.matchAll(/`([^`]*(?:background|color|font|padding|margin|border|display|flex)[^`]*)`/g)) css.push(m[1]!);
    }
    return css;
}
