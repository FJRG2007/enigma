/**
 * RawTokens -> DesignProfile. Deterministic rules only: near-duplicate colors merge and
 * get roles from their names and lightness, font sizes become a type scale, spacing
 * values reveal the base grid, shadows sort into elevation levels, and the whole set is
 * summarized as design traits (dark or light, flat or layered, quiet or expressive).
 */

import type * as types from "./types";
import { isMonoFont } from "./font-names";
import { preferredName, roleFromName } from "./roles";
import { colorDistance, hexToRgb, hsl, isValidHex } from "./color";

/** Colors closer than this (RGB distance) are one palette entry. */
const COLOR_MERGE_DISTANCE = 15;
const MAX_COLORS = 20;

const TW_ROUNDED: Record<string, string> = {
    "rounded-none": "0px", "rounded-sm": "2px", "rounded": "4px", "rounded-md": "6px", "rounded-lg": "8px",
    "rounded-xl": "12px", "rounded-2xl": "16px", "rounded-3xl": "24px", "rounded-full": "9999px",
};

function lightnessOf(hex: string): number | null {
    const rgb = hexToRgb(hex);
    return rgb ? (Math.max(rgb.r, rgb.g, rgb.b) + Math.min(rgb.r, rgb.g, rgb.b)) / 2 / 255 : null;
}

/** With no declared color-scheme: the ten most frequent colors lean light. */
function looksLightScheme(colors: types.RawTokens["colors"]): boolean {
    let light = 0, dark = 0;
    for (const c of [...colors].sort((a, b) => b.frequency - a.frequency).slice(0, 10)) {
        const l = lightnessOf(c.value);
        if (l === null) continue;
        if (l > 0.6) light++;
        else if (l < 0.35) dark++;
    }
    return light > dark;
}

function dedupeColors(colors: types.RawTokens["colors"]): types.ColorToken[] {
    const groups: Array<{ hex: string; name?: string; frequency: number; source: types.ColorToken["source"]; }> = [];
    for (const color of colors) {
        if (!isValidHex(color.value)) continue;
        const rgb = hexToRgb(color.value)!;
        const group = groups.find((g) => colorDistance(rgb, hexToRgb(g.hex)!) < COLOR_MERGE_DISTANCE);
        if (group) {
            group.frequency += color.frequency;
            group.name = preferredName(group.name, color.name);
        } else {
            groups.push({ hex: color.value, name: color.name, frequency: color.frequency, source: color.source });
        }
    }
    return groups.map((g) => ({ ...g, role: "unknown" as types.ColorRole }));
}

function assignColorRoles(colors: types.ColorToken[], declaredLight: boolean): types.ColorToken[] {
    const assigned = new Set<number>();
    const taken = new Set<types.ColorRole>();
    // One color per role: the first (most reliable) claim wins.
    const assign = (index: number | undefined, role: types.ColorRole): void => {
        if (index === undefined || index < 0 || assigned.has(index) || taken.has(role)) return;
        colors[index]!.role = role;
        assigned.add(index);
        taken.add(role);
    };

    const names = new Set(colors.map((c) => c.name?.toLowerCase()).filter(Boolean));
    const claimedNames = new Set<string>();
    // Names are the most reliable signal; among same-role names the most frequent wins (colors are frequency-sorted).
    colors.forEach((c, i) => {
        const name = c.name?.toLowerCase() ?? "";
        if (!name) return;
        if (name === "light-bg" && declaredLight) assign(i, "background");
        else if (name === "light-text" && declaredLight) assign(i, "text-primary");
        else {
            // shadcn convention: beside `--muted-foreground` (the muted text), `--muted` is a surface.
            const role = name === "muted" && names.has("muted-foreground") ? "surface" : roleFromName(name);
            if (role) assign(i, role);
        }
        if (assigned.has(i)) claimedNames.add(name);
    });

    // A background named outright settles the scheme; otherwise the declared/heuristic one stands.
    const namedBg = colors.find((c) => c.role === "background");
    const isLight = namedBg ? hsl(namedBg.hex).lightness > 0.5 : declaredLight;

    const info = colors.map((c, index) => ({ ...c, index, ...hsl(c.hex) }));
    // A color whose name already holds a role is that token's value in the other scheme, not a new role.
    const free = (c: { index: number; name?: string; }): boolean => !assigned.has(c.index) && !claimedNames.has(c.name?.toLowerCase() ?? "");

    if (isLight) {
        if (!colors.some((c) => c.role === "background")) {
            assign(info.filter((c) => c.lightness > 0.7 && free(c)).sort((a, b) => b.lightness - a.lightness || b.frequency - a.frequency)[0]?.index, "background");
        }
        assign(info.filter((c) => c.lightness < 0.2 && free(c)).sort((a, b) => b.frequency - a.frequency)[0]?.index, "text-primary");
        assign(info.filter((c) => c.lightness > 0.5 && free(c)).sort((a, b) => b.lightness - a.lightness)[0]?.index, "surface");
    } else {
        const darks = info.filter((c) => c.lightness < 0.25 && free(c)).sort((a, b) => b.frequency - a.frequency);
        assign(darks[0]?.index, "background");
        assign(darks[1]?.index, "surface");
        assign(info.filter((c) => c.lightness > 0.7 && free(c)).sort((a, b) => b.frequency - a.frequency)[0]?.index, "text-primary");
    }

    assign(info.filter((c) => c.lightness > 0.25 && c.lightness < 0.75 && c.saturation < 0.35 && free(c)).sort((a, b) => b.frequency - a.frequency)[0]?.index, "text-muted");
    assign(info.find((c) => c.saturation > 0.3 && (c.hue < 30 || c.hue > 330) && free(c))?.index, "danger");
    assign(info.find((c) => c.saturation > 0.3 && c.hue > 90 && c.hue < 170 && free(c))?.index, "success");
    assign(info.find((c) => c.saturation > 0.3 && c.hue > 30 && c.hue < 60 && free(c))?.index, "warning");
    assign(info.find((c) => c.saturation > 0.3 && c.hue > 180 && c.hue < 260 && free(c))?.index, "info");
    assign(info.filter((c) => c.saturation > 0.15 && c.lightness > 0.3 && c.lightness < 0.85 && free(c))
        .sort((a, b) => b.saturation - a.saturation || b.frequency - a.frequency)[0]?.index, "accent");
    assign(info.filter((c) => c.saturation < 0.2 && c.lightness > 0.1 && c.lightness < 0.4 && free(c)).sort((a, b) => b.frequency - a.frequency)[0]?.index, "border");

    if (!colors.some((c) => c.role === "background")) {
        assign(info.filter((c) => c.lightness > 0.9 && free(c)).sort((a, b) => b.frequency - a.frequency)[0]?.index, "background");
        assign(info.filter((c) => c.lightness < 0.3 && free(c)).sort((a, b) => b.frequency - a.frequency)[0]?.index, "text-primary");
    }
    return colors.slice(0, MAX_COLORS);
}

function normalizeColors(raw: types.RawTokens["colors"], isLight: boolean): types.ColorToken[] {
    if (raw.length === 0) return [];
    const deduped = dedupeColors(raw).sort((a, b) => b.frequency - a.frequency);
    return assignColorRoles(deduped, isLight);
}

function resolveFontFamily(family: string, varMap: Record<string, string>): string {
    if (!family) return family;
    if (family.startsWith("var(")) {
        const direct = varMap[family];
        if (direct) return direct;
        const name = family.replace(/^var\(/, "").replace(/\)$/, "").trim();
        if (varMap[name]) return varMap[name]!;
    }
    return varMap[family] ?? family.replace(/["']/g, "").trim();
}

/** Not a family worth naming: generic keywords, unresolved vars, debris, icon/system/emoji/fallback faces. */
function isNoiseFamily(f: string): boolean {
    if (/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace)$/i.test(f)) return true;
    if (/^var\(/.test(f) || f.length < 2 || f.length > 50 || /[{};()\n\r<>]/.test(f)) return true;
    if (/^(apple\s*(icons?|legacy|sf\s*symbols?)|material\s*(icons?|symbols?)|font\s*awesome|fontawesome|glyphicons?|ionicons?)/i.test(f)) return true;
    if (/^apple\s*icons?\s*\d+/i.test(f) || /^(-apple-system|blinkmacsystemfont|\.sf\s*(pro|compact))/i.test(f)) return true;
    if (/^(apple\s*color\s*emoji|noto\s*color\s*emoji|segoe\s*ui\s*emoji|android\s*emoji|twemoji)/i.test(f)) return true;
    return /\bfallback\b/i.test(f);
}

function sizeToPx(size: string): number {
    const px = size.match(/([\d.]+)\s*px/);
    if (px) return parseFloat(px[1]!);
    const rem = size.match(/([\d.]+)\s*rem/);
    return rem ? parseFloat(rem[1]!) * 16 : 0;
}

const RENDERED_ROLES: Record<string, types.TypographyRole> = { h1: "heading-1", h2: "heading-2", h3: "heading-3", h4: "heading-4", p: "body", small: "caption", figcaption: "caption" };

/**
 * The type scale as the browser rendered it, when it measured headings and body text:
 * real family, size, weight and line height per role beat any frequency inference.
 */
function renderedTypography(rendered: types.RenderedType[], mono: string | undefined): types.TypographyToken[] | null {
    const byRole = new Map<types.TypographyRole, types.RenderedType>();
    for (const r of rendered) {
        const role = RENDERED_ROLES[r.tag];
        if (role && !byRole.has(role) && r.family && !isNoiseFamily(r.family)) byRole.set(role, r);
    }
    if (!byRole.has("heading-1") || !byRole.has("body")) return null;
    const tokens: types.TypographyToken[] = [...byRole.entries()].map(([role, r]) => ({
        role, fontFamily: r.family, fontSize: r.size, fontWeight: r.weight, source: "computed" as const,
        ...(r.lineHeight && r.lineHeight !== "normal" ? { lineHeight: r.lineHeight } : {}),
    }));
    const order: types.TypographyRole[] = ["heading-1", "heading-2", "heading-3", "heading-4", "body", "caption"];
    tokens.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
    if (mono) tokens.push({ role: "code", fontFamily: mono, fontSize: "14px", fontWeight: "400", source: "computed" });
    return tokens;
}

function normalizeTypography(raw: types.RawTokens["fonts"], varMap: Record<string, string>, rendered?: types.RenderedType[]): types.TypographyToken[] {
    if (raw.length === 0) return [];
    const fonts = raw.map((f) => ({ ...f, family: resolveFontFamily(f.family, varMap) }));
    const source = raw[0]?.source ?? "css";

    const freq = new Map<string, number>();
    for (const f of fonts) {
        const family = f.family?.replace(/["']/g, "").trim();
        if (family && !isNoiseFamily(family)) freq.set(family, (freq.get(family) ?? 0) + 1);
    }
    // Browsers name a metric-matched stand-in "X Fallback"; it counts toward X.
    const merged = new Map<string, number>();
    for (const [family, count] of freq) {
        const base = family.replace(/\s+Fallback$/i, "");
        merged.set(base, (merged.get(base) ?? 0) + count);
    }
    const families = [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
    const primary = families[0] ?? "sans-serif";
    const secondary = families.find((f) => f !== primary && !isMonoFont(f));
    const mono = families.find(isMonoFont);
    const measured = rendered?.length ? renderedTypography(rendered, mono) : null;
    if (measured) return measured;

    const sizes = new Map<string, number>();
    for (const f of fonts) if (f.size) sizes.set(f.size, (sizes.get(f.size) ?? 0) + 1);
    const bySize = [...sizes.entries()].sort((a, b) => sizeToPx(b[0]) - sizeToPx(a[0]));
    const headings = bySize.filter(([s]) => sizeToPx(s) >= 24);
    const bodies = bySize.filter(([s]) => sizeToPx(s) >= 10 && sizeToPx(s) < 24);

    const tokens: types.TypographyToken[] = [];
    if (headings.length >= 2 && bodies.length >= 1) {
        (["heading-1", "heading-2", "heading-3"] as types.TypographyRole[]).slice(0, headings.length).forEach((role, i) => {
            tokens.push({ role, fontFamily: secondary ?? primary, fontSize: headings[i]![0], fontWeight: "700", source });
        });
        const bodyByFreq = [...bodies].sort((a, b) => b[1] - a[1]);
        (["body", "caption"] as types.TypographyRole[]).slice(0, bodyByFreq.length).forEach((role, i) => {
            tokens.push({ role, fontFamily: primary, fontSize: bodyByFreq[i]![0], fontWeight: "400", source });
        });
    } else if (bySize.length >= 4) {
        (["heading-1", "heading-2", "heading-3", "body", "caption"] as types.TypographyRole[]).slice(0, bySize.length).forEach((role, i) => {
            const heading = role.startsWith("heading");
            tokens.push({ role, fontFamily: heading && secondary ? secondary : primary, fontSize: bySize[i]![0], fontWeight: heading ? "700" : "400", source });
        });
    } else {
        const scale: Array<[types.TypographyRole, string, string]> = [
            ["heading-1", "48px / 3rem", "700"], ["heading-2", "32px / 2rem", "600"], ["heading-3", "24px / 1.5rem", "600"],
            ["body", "16px / 1rem", "400"], ["caption", "12px / 0.75rem", "400"],
        ];
        for (const [role, fontSize, fontWeight] of scale) {
            tokens.push({ role, fontFamily: role.startsWith("heading") && secondary ? secondary : primary, fontSize, fontWeight, source });
        }
    }
    if (mono) tokens.push({ role: "code", fontFamily: mono, fontSize: "14px", fontWeight: "400", source });
    return tokens;
}

function detectBase(values: number[]): number {
    if (values.length < 2) return values[0] ?? 4;
    let best = 4, bestScore = 0;
    for (const base of [8, 4, 6, 5, 10]) {
        const score = values.filter((v) => v % base === 0).length / values.length + (base >= 8 ? 0.05 : 0);
        if (score > bestScore) { bestScore = score; best = base; }
    }
    return best;
}

function normalizeSpacing(values: number[]): types.SpacingScale {
    if (values.length === 0) return { base: 4, values: [4, 8, 12, 16, 20, 24, 32, 40, 48, 64], unit: "px" };
    const unique = [...new Set(values)].filter((v) => v > 0 && v <= 200).sort((a, b) => a - b);
    const base = detectBase(unique);
    const aligned = unique.filter((v) => v % base === 0);
    const half = unique.filter((v) => v % (base / 2) === 0 && !aligned.includes(v));
    const combined = [...new Set([...aligned, ...half])].sort((a, b) => a - b);
    let scale: number[];
    if (combined.length >= 6) scale = combined;
    else if (aligned.length >= 4) scale = aligned;
    else scale = Array.from({ length: 24 }, (_, i) => base * (i + 1)).filter((v) => v <= 200);
    return { base, values: scale.slice(0, 15), unit: "px" };
}

function classifyShadow(value: string): types.ShadowLevel {
    const px = (value.match(/(\d+(?:\.\d+)?)\s*px/g) ?? []).map((n) => parseFloat(n));
    if (px.length === 0) return "raised";
    const max = Math.max(...px);
    if (max <= 2) return "flat";
    if (max <= 8) return "raised";
    if (max <= 20) return "floating";
    return "overlay";
}

const LEVEL_ORDER: Record<types.ShadowLevel, number> = { flat: 0, raised: 1, floating: 2, overlay: 3 };

function normalizeShadows(raw: types.RawTokens["shadows"]): types.ShadowToken[] {
    const seen = new Set<string>();
    const unique: types.RawTokens["shadows"] = [];
    for (const s of raw) {
        const key = s.value.trim().toLowerCase();
        if (!key || key === "none") continue;
        // A bare chain of Tailwind's internal variables resolves to nothing outside Tailwind.
        if (/^var\(--tw-/.test(key) && !/\d+px/.test(key)) continue;
        if (!seen.has(key)) { seen.add(key); unique.push(s); }
    }
    return unique.map((s) => ({ value: s.value, level: classifyShadow(s.value), name: s.name }))
        .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

function normalizeBorderRadius(radii: string[], components: types.ComponentInfo[]): string[] {
    const all = [...radii];
    for (const comp of components) {
        for (const cls of comp.cssClasses) {
            const value = cls.startsWith("rounded") ? TW_ROUNDED[cls.replace(/-(t|b|l|r|tl|tr|bl|br)-/, "-")] : undefined;
            if (value) all.push(value);
        }
    }
    const zeros = all.filter((r) => r === "0" || r === "0px").length;
    // Square corners are a deliberate style only when they dominate.
    const sharp = zeros > 0 && zeros >= all.length * 0.5;
    const unique = [...new Set(all)].filter((r) => {
        if (r.includes("var(") || r.includes("9999") || r === "50%") return false;
        const n = parseFloat(r);
        if (!isNaN(n) && n > 1000) return false;
        return sharp || (r !== "0" && r !== "0px");
    }).sort((a, b) => parseFloat(a) - parseFloat(b));
    return unique.length > 0 ? unique : ["8px"];
}

function normalizeAnimations(raw: types.AnimationToken[]): types.AnimationToken[] {
    const seen = new Set<string>();
    return raw.filter((a) => {
        const key = `${a.type}:${a.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const EASING_KEYWORD = /^(ease|ease-in|ease-out|ease-in-out|linear)$/;

function normalizeMotion(raw: types.RawTokens, animations: types.AnimationToken[]): types.MotionTokens {
    const durations = new Set<string>();
    const easings = new Set<string>();
    const properties = new Set<string>();
    for (const d of raw.transitionDurations) if (!d.includes("var(") && /^[\d.]+m?s$/.test(d.trim())) durations.add(d.trim());
    for (const e of raw.transitionEasings) if (!e.includes("var(") && (EASING_KEYWORD.test(e.trim()) || /^cubic-bezier\(/.test(e.trim()))) easings.add(e.trim());
    for (const anim of animations) {
        if (anim.type !== "css-transition") continue;
        for (const m of anim.value.matchAll(/([\d.]+)(ms|s)\b/g)) durations.add(m[2] === "s" ? `${parseFloat(m[1]!) * 1000}ms` : `${m[1]}ms`);
        for (const pattern of [/\b(ease-in-out|ease-in|ease-out|ease|linear)\b/g, /cubic-bezier\([^)]+\)/g]) {
            for (const m of anim.value.matchAll(pattern)) easings.add(m[0]);
        }
        for (const part of anim.value.split(",")) {
            const prop = part.trim().match(/^([\w-]+)\s/)?.[1];
            if (prop && prop !== "all") properties.add(prop);
        }
    }
    return { durations: [...durations].sort((a, b) => parseFloat(a) - parseFloat(b)), easings: [...easings], properties: [...properties] };
}

function categoriesOf(components: types.ComponentInfo[]): Record<types.ComponentCategory, string[]> {
    const cats: Record<types.ComponentCategory, string[]> = {
        "layout": [], "navigation": [], "data-display": [], "data-input": [], "feedback": [], "overlay": [], "typography": [], "media": [], "other": [],
    };
    for (const comp of components) cats[comp.category].push(comp.name);
    return cats;
}

function detectAntiPatterns(raw: types.RawTokens, components: types.ComponentInfo[], shadows: types.ShadowToken[]): string[] {
    const patterns: string[] = [];
    if (shadows.length === 0) patterns.push("no-shadows");
    if (raw.gradients.length === 0) patterns.push("no-gradients");
    let blur = false, skeleton = false, parallax = false, toasts = false, zebra = false;
    for (const comp of components) {
        for (const cls of comp.cssClasses) {
            if (cls.includes("blur")) blur = true;
            if (cls.includes("skeleton") || cls.includes("animate-pulse")) skeleton = true;
            if (cls.includes("parallax")) parallax = true;
        }
        if (/skeleton|shimmer|pulse/i.test(comp.jsxSnippet)) skeleton = true;
        if (/toast|Toaster|sonner/i.test(comp.jsxSnippet)) toasts = true;
        if (/even:|odd:|striped|zebra/i.test(comp.cssClasses.join(" "))) zebra = true;
    }
    if (toasts) patterns.push("has-toasts");
    if (!blur) patterns.push("no-blur");
    if (skeleton) patterns.push("has-skeleton-loaders");
    if (parallax) patterns.push("has-parallax");
    if (!zebra) patterns.push("no-zebra-striping");
    return patterns;
}

function isDarkColor(hex: string): boolean {
    const rgb = hexToRgb(hex);
    return !!rgb && (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 < 0.5;
}

function computeTraits(colors: types.ColorToken[], typography: types.TypographyToken[], spacing: types.SpacingScale, shadows: types.ShadowToken[], raw: types.RawTokens, animations: types.AnimationToken[]): types.DesignTraits {
    const bg = colors.find((c) => c.role === "background");
    const accent = colors.find((c) => c.role === "accent");
    const bodyFont = typography.find((t) => t.role === "body")?.fontFamily ?? "sans-serif";
    const temp = hexToRgb(accent?.hex ?? bg?.hex ?? "#333333");
    let primaryColorTemp: types.DesignTraits["primaryColorTemp"] = "neutral";
    if (temp && temp.r > temp.b + 30) primaryColorTemp = "warm";
    else if (temp && temp.b > temp.r + 30) primaryColorTemp = "cool";

    let fontStyle: types.DesignTraits["fontStyle"] = "sans-serif";
    if (isMonoFont(bodyFont)) fontStyle = "monospace";
    else if (/serif|georgia|times|garamond|merriweather|playfair/i.test(bodyFont) && !/sans/i.test(bodyFont)) fontStyle = "serif";

    const radii = raw.borderRadii.map((r) => parseFloat(r)).filter((n) => !isNaN(n) && n < 9999);
    let motionStyle: types.DesignTraits["motionStyle"] = "none";
    if (animations.length > 0 || raw.transitionDurations.length > 0) {
        const physics = animations.some((a) => a.type === "framer-motion" || a.type === "spring" || a.value.includes("layout-animation"));
        motionStyle = physics || animations.length > 5 ? "expressive" : "subtle";
    }
    return {
        isDark: bg ? isDarkColor(bg.hex) : false,
        hasShadows: shadows.length > 0,
        hasGradients: raw.gradients.length > 0,
        hasRoundedFull: raw.borderRadii.some((r) => r.includes("9999") || r === "50%"),
        maxBorderRadius: radii.length > 0 ? Math.max(...radii) : 8,
        primaryColorTemp,
        fontStyle,
        density: spacing.base <= 4 ? "compact" : spacing.base >= 12 ? "spacious" : "standard",
        hasAnimations: animations.length > 0,
        // A toggleable light/dark pair, not merely a dark site.
        hasDarkMode: raw.darkModeVars.length > 0,
        motionStyle,
    };
}

function dedupeBreakpoints(bps: types.RawTokens["breakpoints"]): types.RawTokens["breakpoints"] {
    const seen = new Set<string>();
    return bps.filter((bp) => !seen.has(bp.value) && !!seen.add(bp.value)).sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
}

function dedupeSections(sections: types.PageSection[]): types.PageSection[] {
    const seen = new Map<string, types.PageSection>();
    for (const s of sections) if (!seen.has(`${s.type}:${s.description}`)) seen.set(`${s.type}:${s.description}`, s);
    return [...seen.values()];
}

export function normalize(projectName: string, frameworks: types.Framework[], raw: types.RawTokens, components: types.ComponentInfo[], libraries?: types.ProjectLibraries): types.DesignProfile {
    const isLight = raw.cssVariables.some((v) => v.name === "--color-scheme-default" && v.value === "light") || looksLightScheme(raw.colors);
    const colors = normalizeColors(raw.colors, isLight);
    const typography = normalizeTypography(raw.fonts, raw.fontVarMap, raw.renderedType);
    const spacing = normalizeSpacing(raw.spacingValues);
    const shadows = normalizeShadows(raw.shadows);
    const animations = normalizeAnimations(raw.animations);
    return {
        projectName,
        favicon: raw.favicon,
        frameworks,
        colors,
        typography,
        spacing,
        shadows,
        components,
        breakpoints: dedupeBreakpoints(raw.breakpoints),
        cssVariables: raw.cssVariables,
        borderRadius: normalizeBorderRadius(raw.borderRadii, components),
        fontVarMap: raw.fontVarMap,
        antiPatterns: detectAntiPatterns(raw, components, shadows),
        designTraits: computeTraits(colors, typography, spacing, shadows, raw, animations),
        animations,
        darkModeVars: raw.darkModeVars,
        iconLibrary: libraries?.iconLibrary ?? null,
        stateLibrary: libraries?.stateLibrary ?? null,
        componentCategories: categoriesOf(components),
        zIndexScale: [...new Set(raw.zIndexValues)].sort((a, b) => a - b),
        containerMaxWidth: raw.containerMaxWidth,
        fontSources: raw.fontSources,
        pageSections: dedupeSections(raw.pageSections),
        motionTokens: normalizeMotion(raw, animations),
    };
}
