/**
 * URL mode with a browser: the styles the page actually renders with. Samples up to 500
 * meaningful elements per page for computed colors, fonts, spacing, shadows and radii,
 * and reads custom properties from same-origin stylesheets. Complements the HTTP pass,
 * which cannot see client-rendered markup or values computed at runtime.
 */

import { rgbToHex } from "../color";
import type { Browser } from "../browser/page";
import type { RawTokens, RenderedType } from "../types";
import { addColor, emptyRawTokens } from "../raw-tokens";

interface PageSample {
    colors: Array<{ value: string; frequency: number; }>;
    fonts: Array<{ family: string; size: string; weight: string; }>;
    spacing: number[];
    shadows: string[];
    cssVars: Array<{ name: string; value: string; }>;
    radii: string[];
    /** What the page actually paints: the canvas background and the body text color. */
    page: { background: string; text: string; };
    /** Rendered type of the first visible element per text role. */
    type: RenderedType[];
}

/** Runs in the page. */
const SAMPLE_SCRIPT = String.raw`() => {
    const cssVars = [];
    for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const rule of Array.from(rules)) {
            if (!(rule instanceof CSSStyleRule) || !/^(:root|html|body|\.dark)/.test(rule.selectorText)) continue;
            for (let k = 0; k < rule.style.length; k++) {
                const prop = rule.style[k];
                if (prop.startsWith("--")) cssVars.push({ name: prop, value: rule.style.getPropertyValue(prop).trim() });
            }
        }
    }
    const selectors = ["body", "header", "nav", "main", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "span",
        "button", "input", "select", "textarea", "table", "th", "td", "img", "svg",
        "[class*=card]", "[class*=modal]", "[class*=dialog]", "[class*=badge]", "[class*=chip]", "[class*=tag]",
        "[class*=btn]", "[class*=button]", "[class*=nav]", "[class*=menu]", "[class*=hero]", "[class*=banner]",
        "[class*=container]", "[class*=wrapper]", "section", "article", "div"];
    const elements = new Set();
    for (const sel of selectors) { try { document.querySelectorAll(sel).forEach((el) => elements.add(el)); } catch (e) {} }
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // The canvas color: the first opaque background up the chain, else the UA default (white).
    const pageBackground = () => {
        for (const el of [document.body, document.documentElement]) {
            const bg = getComputedStyle(el).backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        }
        return "rgb(255, 255, 255)";
    };
    const typeSamples = () => {
        const out = [];
        for (const sel of ["h1", "h2", "h3", "h4", "p", "li", "small", "figcaption"]) {
            const els = Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, 200);
            if (!els.length) continue;
            // Headings: the first one is the scale. Running text: the most common size, so a
            // hero subtitle set in a paragraph does not pass for the body size.
            let el = els[0];
            if (!/^h\d$/.test(sel)) {
                const bySize = new Map();
                for (const e of els) { const k = getComputedStyle(e).fontSize; bySize.set(k, (bySize.get(k) || []).concat(e)); }
                el = Array.from(bySize.values()).sort((a, b) => b.length - a.length)[0][0];
            }
            const s = getComputedStyle(el);
            out.push({ tag: sel, family: s.fontFamily.split(",")[0].replace(/["']/g, "").trim(), size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight });
        }
        return out;
    };
    const colorMap = new Map();
    const fontMap = new Map();
    const spacing = [], shadows = [], radii = [];
    let count = 0;
    for (const el of elements) {
        if (count++ >= 500) break;
        const s = getComputedStyle(el);
        for (const prop of ["color", "backgroundColor", "borderColor", "outlineColor"]) {
            const v = s[prop];
            if (v && v !== "rgba(0, 0, 0, 0)" && v !== "transparent" && v !== "inherit") colorMap.set(v, (colorMap.get(v) || 0) + 1);
        }
        const family = s.fontFamily.split(",")[0].replace(/["']/g, "").trim();
        if (family && family !== "inherit" && !fontMap.has(family)) fontMap.set(family, { size: s.fontSize, weight: s.fontWeight });
        for (const prop of ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "marginTop", "marginBottom", "marginLeft", "marginRight", "gap", "rowGap", "columnGap"]) {
            const v = parseFloat(s[prop]);
            if (v > 0 && v <= 200) spacing.push(Math.round(v));
        }
        if (s.boxShadow && s.boxShadow !== "none") shadows.push(s.boxShadow);
        if (s.borderRadius && s.borderRadius !== "0px") radii.push(s.borderRadius);
    }
    return {
        colors: Array.from(colorMap.entries()).map(([value, frequency]) => ({ value, frequency })),
        fonts: Array.from(fontMap.entries()).map(([family, info]) => ({ family, size: info.size, weight: info.weight })),
        spacing, shadows, cssVars, radii,
        page: { background: pageBackground(), text: getComputedStyle(document.body).color },
        type: typeSamples(),
    };
}`;

/** Same-origin links of the current page, without fragments. */
export const LINKS_SCRIPT = String.raw`(base) => {
    const origin = new URL(base).origin;
    const out = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        try {
            const u = new URL(a.href, base);
            if (u.origin === origin && !u.hash && !/\.(pdf|zip|png|jpe?g|gif|svg|ico|css|js|xml|json|txt|mp4|webm)$/i.test(u.pathname)) out.push(u.href);
        } catch (e) {}
    }
    return out;
}`;

function rgbStringToHex(value: string): string | null {
    const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? rgbToHex(parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)) : null;
}

function fold(sample: PageSample, tokens: RawTokens): void {
    // Named so the normalizer gives them their roles outright: nothing beats what is painted.
    const bg = rgbStringToHex(sample.page.background);
    const fg = rgbStringToHex(sample.page.text);
    if (bg) addColor(tokens, bg, "computed", "page-background");
    if (fg) addColor(tokens, fg, "computed", "page-text");
    for (const t of sample.type) if (t.family) tokens.fonts.push({ family: t.family, size: t.size, weight: t.weight, source: "computed" });
    if (!tokens.renderedType?.length && sample.type.length) tokens.renderedType = sample.type;
    for (const color of sample.colors) {
        const hex = rgbStringToHex(color.value);
        if (!hex) continue;
        const existing = tokens.colors.find((c) => c.value === hex);
        if (existing) existing.frequency += color.frequency;
        else tokens.colors.push({ value: hex, frequency: color.frequency, source: "computed" });
    }
    for (const font of sample.fonts) if (font.family && !tokens.fonts.some((f) => f.family === font.family)) tokens.fonts.push({ ...font, source: "computed" });
    tokens.spacingValues.push(...sample.spacing);
    for (const value of sample.shadows) if (!tokens.shadows.some((s) => s.value === value)) tokens.shadows.push({ value });
    for (const v of sample.cssVars) if (!tokens.cssVariables.some((c) => c.name === v.name)) tokens.cssVariables.push(v);
    for (const r of sample.radii) if (!tokens.borderRadii.includes(r)) tokens.borderRadii.push(r);
}

export async function extractComputedTokens(browser: Browser, url: string, maxPages: number): Promise<RawTokens> {
    const tokens = emptyRawTokens();
    const visited = new Set<string>();
    const queue = [url];
    while (queue.length > 0 && visited.size < maxPages) {
        const pageUrl = queue.shift()!;
        if (visited.has(pageUrl)) continue;
        visited.add(pageUrl);
        const page = await browser.newPage();
        try {
            await page.goto(pageUrl);
            await page.wait(1500);
            fold(await page.evaluate<PageSample>(SAMPLE_SCRIPT), tokens);
            const links = await page.evaluate<string[]>(LINKS_SCRIPT, pageUrl);
            for (const link of links.slice(0, 10)) if (!visited.has(link)) queue.push(link);
        } catch { /* a page that fails to load is skipped */ }
        finally { await page.close(); }
    }
    return tokens;
}
