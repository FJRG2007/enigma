/**
 * Stylesheet -> design tokens. One implementation for every source of CSS: the files of
 * a local project, the stylesheets a crawled page links, its inline `<style>` blocks and
 * CSS strings decoded from bundled JS. Block-level facts (dark-mode variable pairs,
 * keyframes, font faces, breakpoints) are read from the raw text; per-declaration facts
 * (colors, fonts, spacing, shadows, radii, motion) come from the CSS walker.
 */

import { walkCss } from "../css-parse";
import { roleFromName } from "../roles";
import { addColor } from "../raw-tokens";
import type { RawTokens } from "../types";
import { colorsIn, tryParseColor } from "../color";
import { firstRealFont, isEmojiFont, isGenericFont, isIconFont, isSystemFont, isValidFontName } from "../font-names";

export interface CssTokenOptions {
    /** URL the stylesheet was fetched from, so relative `@font-face` sources resolve. */
    baseUrl?: string;
    /** The text is SCSS/LESS: `//` starts a comment. */
    lineComments?: boolean;
}

const COLOR_PROPERTY = /^(color|background-color|background|border-color|outline-color|fill|stroke|accent-color|caret-color|text-decoration-color|column-rule-color)$/i;
const SPACING_PROPERTY = /^(margin|padding|gap|row-gap|column-gap|margin-(top|right|bottom|left)|padding-(top|right|bottom|left)|top|right|bottom|left)$/i;
const VAR_DECLARATION = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;

export function guessPropertyType(varName: string): string {
    if (/color|bg|background|foreground/i.test(varName)) return "color";
    if (/font|family|typeface/i.test(varName)) return "font";
    if (/size|spacing|gap|padding|margin|radius/i.test(varName)) return "spacing";
    if (/shadow|elevation/i.test(varName)) return "shadow";
    return "unknown";
}

/** A custom-property name that holds a color (and not a size or duration about one). */
export function isColorVarName(name: string): boolean {
    if (roleFromName(name.replace(/^(--|[$@])/, ""))) return true;
    return /color|background|foreground|primary|secondary|accent|muted|destructive|border|card|popover|ring|input|chart|surface|text|brand|success|danger|warning|error|info/i.test(name)
        && !/font|size|spacing|radius|shadow|width|height|duration|delay|family|weight|line/i.test(name);
}

function resolveUrl(href: string, base: string): string {
    try { return new URL(href, base).href; } catch { return href; }
}

export function spacingValuesIn(value: string): number[] {
    const out: number[] = [];
    for (const m of value.matchAll(/([\d.]+)(px|rem|em)/g)) {
        let px = parseFloat(m[1]!);
        if (m[2] === "rem" || m[2] === "em") px *= 16;
        if (px > 0 && px <= 200) out.push(Math.round(px));
    }
    return out;
}

/** Durations (normalized to ms) and easing functions inside a `transition` shorthand. */
export function addTransitionParts(value: string, tokens: RawTokens): void {
    for (const m of value.matchAll(/([\d.]+)(ms|s)\b/g)) {
        const dur = m[2] === "s" ? `${parseFloat(m[1]!) * 1000}ms` : `${m[1]}ms`;
        if (!tokens.transitionDurations.includes(dur)) tokens.transitionDurations.push(dur);
    }
    for (const pattern of [/\b(ease-in-out|ease-in|ease-out|ease|linear)\b/g, /cubic-bezier\([^)]+\)/g]) {
        for (const m of value.matchAll(pattern)) {
            if (!tokens.transitionEasings.includes(m[0])) tokens.transitionEasings.push(m[0]);
        }
    }
}

/** Light/dark pairs: a variable in `:root` whose dark-mode block gives it another value. */
function extractDarkModeBlocks(css: string, tokens: RawTokens): void {
    const rootVars = new Map<string, string>();
    const darkVars = new Map<string, string>();
    for (const m of css.matchAll(/:root\s*\{([^}]+)\}/g)) {
        for (const v of m[1]!.matchAll(VAR_DECLARATION)) rootVars.set(v[1]!, v[2]!.trim());
    }
    const darkPatterns = [
        /\.dark\s*\{([^}]+)\}/g,
        /\[data-theme\s*=\s*["']dark["']\]\s*\{([^}]+)\}/g,
        /\.dark\s+:root\s*\{([^}]+)\}/g,
        /:root\.dark\s*\{([^}]+)\}/g,
        /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{[^{]*:root\s*\{([^}]+)\}/g,
        /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{([^}]+)\}/g,
    ];
    for (const pattern of darkPatterns) {
        for (const m of css.matchAll(pattern)) {
            for (const v of m[1]!.matchAll(VAR_DECLARATION)) darkVars.set(v[1]!, v[2]!.trim());
        }
    }
    for (const [variable, lightValue] of rootVars) {
        const darkValue = darkVars.get(variable);
        if (darkValue && darkValue !== lightValue && !tokens.darkModeVars.some((d) => d.variable === variable)) {
            tokens.darkModeVars.push({ variable, lightValue, darkValue });
        }
    }
}

/**
 * Records a light primary scheme from `color-scheme: light ...`, ignoring declarations
 * inside a `prefers-color-scheme: dark` block (those describe the alternate scheme).
 */
function detectColorScheme(css: string, tokens: RawTokens): void {
    if (tokens.cssVariables.some((v) => v.name === "--color-scheme-default")) return;
    const withoutDark = css.replace(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{[\s\S]*?\}\s*\}/g, "");
    const m = withoutDark.match(/color-scheme\s*:\s*([^;}\n]+)/i);
    if (m && m[1]!.trim().toLowerCase().startsWith("light")) {
        tokens.cssVariables.push({ name: "--color-scheme-default", value: "light", property: "color" });
    }
}

function extractKeyframes(css: string, tokens: RawTokens): void {
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)) {
        if (!tokens.animations.some((a) => a.name === m[1])) {
            tokens.animations.push({ name: m[1]!, type: "css-keyframe", value: m[2]!.trim().slice(0, 200), source: "css" });
        }
    }
}

function guessFormatFromUrl(url: string): string | undefined {
    const path = url.split(/[?#]/)[0]!;
    if (path.endsWith(".woff2")) return "woff2";
    if (path.endsWith(".woff")) return "woff";
    if (path.endsWith(".ttf")) return "truetype";
    if (path.endsWith(".otf")) return "opentype";
    if (path.endsWith(".eot")) return "embedded-opentype";
    return undefined;
}

function extractFontFaces(css: string, tokens: RawTokens, baseUrl?: string): void {
    for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
        const body = m[1]!;
        const familyMatch = body.match(/font-family\s*:\s*["']?([^"';,]+)["']?/);
        if (!familyMatch) continue;
        const family = familyMatch[1]!.trim();
        if (!isValidFontName(family) || isIconFont(family) || isSystemFont(family)) continue;
        const weightMatch = body.match(/font-weight\s*:\s*(\d+)(?:\s+(\d+))?/);
        // A range (`100 900`) is a variable face.
        const weight = weightMatch ? (weightMatch[2] ? "variable" : weightMatch[1]) : undefined;
        if (!tokens.fonts.some((f) => f.family === family)) tokens.fonts.push({ family, weight, source: "css" });
        // Each `url(...)` with the `format(...)` that follows it, when one does.
        for (const src of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/g)) {
            let url = src[1]!.trim();
            if (url.startsWith("data:")) continue;
            if (baseUrl && !/^https?:/i.test(url)) url = resolveUrl(url, baseUrl);
            if (!tokens.fontSources.some((f) => f.family === family && f.src === url)) {
                tokens.fontSources.push({ family, src: url, format: src[2] ?? guessFormatFromUrl(url), weight });
            }
        }
    }
}

function nameBreakpoint(px: number, unit: string): string {
    if (unit === "em" || unit === "rem") px *= 16;
    if (px <= 480) return "xs";
    if (px <= 640) return "sm";
    if (px <= 768) return "md";
    if (px <= 1024) return "lg";
    if (px <= 1280) return "xl";
    return "2xl";
}

function extractBreakpoints(css: string, tokens: RawTokens): void {
    for (const m of css.matchAll(/@media[^{]*\(\s*(?:min|max)-width\s*:\s*([\d.]+)(px|em|rem)\s*\)/g)) {
        const value = `${m[1]}${m[2]}`;
        if (!tokens.breakpoints.some((b) => b.value === value)) {
            tokens.breakpoints.push({ name: nameBreakpoint(parseFloat(m[1]!), m[2]!), value, source: "css" });
        }
    }
}

function extractZIndex(css: string, tokens: RawTokens): void {
    for (const m of css.matchAll(/z-index\s*:\s*(\d+)/g)) {
        const value = parseInt(m[1]!);
        if (!tokens.zIndexValues.includes(value)) tokens.zIndexValues.push(value);
    }
}

/** The page container: a container-sized max-width, or a `--container*`-style variable. */
function extractContainerWidth(css: string, tokens: RawTokens): void {
    for (const m of css.matchAll(/max-width\s*:\s*([\d.]+)(px|rem|em|%)/g)) {
        let px = parseFloat(m[1]!);
        if (m[2] === "rem" || m[2] === "em") px *= 16;
        if (px >= 960 && px <= 1600) tokens.containerMaxWidth = `${m[1]}${m[2]}`;
    }
    const containerVar = css.match(/--(container|content|max-width|page-width)[\w-]*\s*:\s*([^;}\n]+)/);
    if (containerVar && /^[\d.]+(px|rem|em|%)$/.test(containerVar[2]!.trim())) tokens.containerMaxWidth = containerVar[2]!.trim();
}

function handleDeclaration(property: string, value: string, tokens: RawTokens): void {
    // Custom properties and SCSS/LESS variables are the named tokens of a design system.
    if (/^(--|[$@])/.test(property)) {
        tokens.cssVariables.push({ name: property, value, property: guessPropertyType(property) });
        if (isColorVarName(property)) {
            const hex = tryParseColor(value);
            if (hex) addColor(tokens, hex, "css", property.replace(/^(--|[$@])/, ""));
        }
        if (/^--(font|default[-_]font)/i.test(property)) {
            const font = firstRealFont(value);
            if (font) tokens.fontVarMap[property] = font;
        }
    }
    if (COLOR_PROPERTY.test(property)) for (const hex of colorsIn(value)) addColor(tokens, hex, "css");

    if (property === "font-family") {
        // The first real face in the stack, resolving `var(--font-x)` through the map.
        for (const raw of value.split(",")) {
            let family = raw.replace(/["']/g, "").trim();
            if (!family) continue;
            if (family.startsWith("var(")) {
                const varName = family.replace(/^var\(\s*/, "").replace(/\s*(?:,[^)]+)?\)$/, "").trim();
                const resolved = tokens.fontVarMap[varName] ?? tokens.fontVarMap[family];
                if (!resolved) continue;
                family = resolved;
            }
            if (isGenericFont(family) || isSystemFont(family) || isIconFont(family) || isEmojiFont(family) || !isValidFontName(family)) continue;
            if (!tokens.fonts.some((f) => f.family === family)) tokens.fonts.push({ family, source: "css" });
            break;
        }
    }
    if (property === "font-size") {
        const pending = tokens.fonts.find((f) => !f.size);
        if (pending) pending.size = value;
        else tokens.fonts.push({ family: "", size: value, source: "css" });
    }
    if (property === "font-weight") {
        const pending = tokens.fonts.find((f) => !f.weight);
        if (pending) pending.weight = value;
    }
    if (SPACING_PROPERTY.test(property)) tokens.spacingValues.push(...spacingValuesIn(value));
    if (property === "box-shadow" && value !== "none" && !tokens.shadows.some((s) => s.value === value)) tokens.shadows.push({ value });
    // Single-value radii only: a four-corner shorthand is not a scale step.
    if ((property === "border-radius" || (property.startsWith("border-") && property.endsWith("-radius"))) && !value.includes(" ") && !value.includes("/")) {
        if (!tokens.borderRadii.includes(value)) tokens.borderRadii.push(value);
    }
    if (value.includes("gradient(")) tokens.gradients.push(value);
    if (property === "transition") {
        tokens.animations.push({ name: "css-transition", type: "css-transition", value, source: "css" });
        addTransitionParts(value, tokens);
    }
    if ((property === "transition-duration" || property === "animation-duration") && /^[\d.]+m?s$/.test(value)) {
        if (!tokens.transitionDurations.includes(value)) tokens.transitionDurations.push(value);
    }
    if ((property === "transition-timing-function" || property === "animation-timing-function") && value && !value.includes("var(")) {
        if (!tokens.transitionEasings.includes(value)) tokens.transitionEasings.push(value);
    }
}

/** Fold one stylesheet's tokens into `tokens`. */
export function extractCssTokens(css: string, tokens: RawTokens, options: CssTokenOptions = {}): void {
    extractDarkModeBlocks(css, tokens);
    detectColorScheme(css, tokens);
    extractKeyframes(css, tokens);
    extractFontFaces(css, tokens, options.baseUrl);
    extractBreakpoints(css, tokens);
    extractZIndex(css, tokens);
    extractContainerWidth(css, tokens);
    walkCss(css, { declaration: (property, value) => handleDeclaration(property, value, tokens) }, { lineComments: options.lineComments });
}

/** `@import` targets of a stylesheet, resolved against the URL it came from. */
export function importUrls(css: string, baseUrl: string): string[] {
    const urls: string[] = [];
    for (const m of css.matchAll(/@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/gi)) {
        const href = m[1] ?? m[2];
        if (href) urls.push(resolveUrl(href, baseUrl));
    }
    return urls;
}
