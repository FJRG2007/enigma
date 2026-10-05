/**
 * DESIGN.md: the full design-system reference in ten sections (theme, palette,
 * typography, components, layout, elevation, motion, do's and don'ts, responsive
 * behavior, prompt recipes), rendered from a DesignProfile. Template-driven; no model.
 */

import type * as types from "../types";
import { isMonoFont } from "../font-names";
import { code, fenced, image, text } from "./md";

const ROLE_ORDER: types.ColorRole[] = ["background", "surface", "text-primary", "text-muted", "border", "accent", "danger", "success", "warning", "info", "unknown"];
const ROLE_USE: Record<types.ColorRole, string> = {
    "background": "Page background, darkest surface",
    "surface": "Card and panel backgrounds",
    "text-primary": "Headings and body text",
    "text-muted": "Captions, placeholders, secondary info",
    "accent": "CTAs, links, focus rings, active states",
    "border": "Dividers, card borders, outlines",
    "danger": "Error states, destructive actions",
    "success": "Success states, positive indicators",
    "warning": "Warning states, caution indicators",
    "info": "Informational highlights",
    "unknown": "Palette color",
};
const CATEGORY_NAMES: Record<types.ComponentCategory, string> = {
    "layout": "Layout", "navigation": "Navigation", "data-display": "Data Display", "data-input": "Data Input",
    "feedback": "Feedback", "overlay": "Overlay", "typography": "Typography", "media": "Media", "other": "Other",
};

export function formatRole(role: string): string {
    return role.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function fontFamilies(profile: types.DesignProfile): string[] {
    return [...new Set(profile.typography.map((t) => t.fontFamily))].filter(Boolean);
}

/** The body and heading faces as the type scale assigns them; a mono heading face falls back to the body face. */
export function typePair(profile: types.DesignProfile): { body: string; heading: string; } {
    const body = profile.typography.find((t) => t.role === "body")?.fontFamily ?? fontFamilies(profile).find((f) => !isMonoFont(f)) ?? "sans-serif";
    const heading = profile.typography.find((t) => t.role === "heading-1")?.fontFamily ?? body;
    return { body, heading: isMonoFont(heading) ? body : heading };
}

/** The spacing-scale value nearest `base * multiplier` (capped at 32px). */
/** The weight the scale gives headings, as written in the type tokens. */
export function headingWeight(profile: types.DesignProfile): string {
    return String(profile.typography.find((t) => t.role === "heading-1")?.fontWeight ?? "700");
}

export function bodyWeight(profile: types.DesignProfile): string {
    return String(profile.typography.find((t) => t.role === "body")?.fontWeight ?? "400");
}

/** Line heights as measured in the browser, else the conventional 1.5 / 1.2. */
export function lineHeightRule(profile: types.DesignProfile): string {
    const body = profile.typography.find((t) => t.role === "body")?.lineHeight;
    const heading = profile.typography.find((t) => t.role === "heading-1")?.lineHeight;
    return `Line height: ${body ?? "1.5"} for body text, ${heading ?? "1.2"} for headings`;
}

export function pickSpacing(spacing: types.SpacingScale, multiplier: number): number {
    const target = Math.min(spacing.base * multiplier, 32);
    if (spacing.values.length === 0) return target;
    return spacing.values.reduce((prev, curr) => (Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev));
}

/** The middle of the radius scale: the default corner. */
export function commonRadius(profile: types.DesignProfile): string {
    const radii = profile.borderRadius.filter((r) => !r.includes("9999"));
    if (radii.length > 0) return radii[Math.floor(radii.length / 2)]!;
    return profile.cssVariables.find((v) => /radius/i.test(v.name))?.value ?? "8px";
}

export function roleColor(profile: types.DesignProfile, role: types.ColorRole): types.ColorToken | undefined {
    return profile.colors.find((c) => c.role === role);
}

/** `@font-face` rules for the bundled or discovered sources, one per weight the scale uses. */
export function fontFaceCss(profile: types.DesignProfile): string {
    let css = "";
    const used = new Set(profile.typography.map((t) => String(t.fontWeight ?? "400")));
    used.add("400");
    used.add("700");
    for (const family of [...new Set(profile.fontSources.map((s) => s.family))]) {
        const sources = profile.fontSources.filter((s) => s.family === family);
        const face = (src: types.FontSource, weight: string): string =>
            `@font-face {\n  font-family: ${JSON.stringify(family)};\n  src: url(${JSON.stringify(src.src)})${src.format ? ` format(${JSON.stringify(src.format)})` : ""};\n  font-weight: ${weight};\n}\n`;
        const variable = sources.find((s) => s.weight === "variable");
        if (variable) { css += face(variable, "100 900"); continue; }
        const byWeight = new Map<string, types.FontSource>();
        for (const src of sources) {
            const w = src.weight ?? "400";
            if (!used.has(w)) continue;
            const existing = byWeight.get(w);
            if (!existing || (src.format === "woff2" && existing.format !== "woff2")) byWeight.set(w, src);
        }
        if (byWeight.size === 0 && sources.length > 0) byWeight.set(sources[0]!.weight ?? "400", sources[0]!);
        for (const [weight, src] of byWeight) css += face(src, weight);
    }
    return css;
}

function header(profile: types.DesignProfile, screenshotPath: string | null): string {
    const frameworks = profile.frameworks.map((f) => (f.version ? `${f.name} ${f.version}` : f.name)).join(" + ");
    const t = profile.designTraits;
    const lines = [
        `# ${text(profile.projectName)} DESIGN.md`,
        "",
        "> Design system reverse-engineered by static analysis (enigma design).",
        `> Frameworks: ${text(frameworks) || "None detected"}`,
        `> Colors: ${profile.colors.length} - Fonts: ${fontFamilies(profile).length} - Components: ${profile.components.length}`,
        `> Icon library: ${profile.iconLibrary ?? "not detected"} - State: ${profile.stateLibrary ?? "not detected"}`,
        `> Primary theme: ${t.isDark ? "dark" : "light"} - Dark mode toggle: ${t.hasDarkMode ? "yes" : "no"} - Motion: ${t.motionStyle}`,
    ];
    if (screenshotPath) {
        lines.push("", "## Visual Reference", "", "**Match this design exactly**: study colors, fonts, spacing and component shapes before writing any UI code.", "",
            image(`${profile.projectName} homepage`, `../${screenshotPath}`));
    }
    return lines.join("\n");
}

function visualTheme(profile: types.DesignProfile): string {
    const t = profile.designTraits;
    const accent = roleColor(profile, "accent");
    const { body: primary, heading } = typePair(profile);
    const theme = t.isDark ? "dark" : "light";
    const lines: string[] = [];
    if (t.isDark && !t.hasShadows) lines.push(`This is a **${theme}-themed** interface with a flat, ${t.primaryColorTemp} visual language. Elevation comes from color and border shifts rather than shadows.`);
    else if (t.isDark) lines.push(`This is a **${theme}-themed** interface with a ${t.primaryColorTemp} tone. Depth is expressed through layered shadows and subtle surface color variation.`);
    else lines.push(`This is a **${theme}-themed** interface with a ${t.primaryColorTemp}, approachable feel. The light background puts the content first.`);
    if (heading !== primary) {
        lines.push(`Typography pairs **${text(heading)}** for display and headings with **${text(primary)}** for body text.`);
    } else {
        const kind = t.fontStyle === "monospace" ? "technical, developer-focused" : t.fontStyle === "serif" ? "editorial, refined" : "clean, modern";
        lines.push(`Typography uses **${text(primary)}** throughout, a ${kind} choice.`);
    }
    lines.push(`Spacing follows a **${profile.spacing.base}px base grid** (${t.density} density), with scale: ${profile.spacing.values.slice(0, 8).join(", ")}px.`);
    if (accent) {
        const roled = profile.colors.filter((c) => c.role !== "unknown").length;
        const neutral = profile.colors.filter((c) => ["background", "surface", "text-primary", "text-muted", "border"].includes(c.role)).length;
        lines.push(neutral >= 3 && roled - neutral <= 3
            ? `The palette is predominantly neutral with **${accent.hex}** as the single accent, used sparingly for interactive elements and emphasis.`
            : `The accent color **${accent.hex}** anchors interactive elements (buttons, links, focus rings).`);
    }
    if (t.motionStyle === "expressive") lines.push("Motion is expressive: spring physics, layout animations and staggered reveals are part of the visual language.");
    else if (t.motionStyle === "subtle") lines.push("Motion is subtle: short transitions (150-300ms) ease state changes without drawing attention.");
    return `## 1. Visual Theme & Atmosphere\n\n${lines.join(" ")}`;
}

/** CSS variables that name a palette role, without framework internals. */
export function paletteVariables(profile: types.DesignProfile): types.CSSVariable[] {
    return profile.cssVariables.filter((v) =>
        /foreground|background|primary|secondary|muted|accent|destructive|border|card|popover/i.test(v.name)
        && v.value.length < 40 && !/^--(tw|vt|un)-/i.test(v.name));
}

function colorPalette(profile: types.DesignProfile): string {
    if (profile.colors.length === 0) return "## 2. Color Palette & Roles\n\nNo colors detected.";
    const sorted = [...profile.colors].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    let out = "## 2. Color Palette & Roles\n\n| Token | Hex | Role | Use |\n|---|---|---|---|\n";
    for (const c of sorted) out += `| ${c.name ? text(c.name, 60) : "-"} | ${code(c.hex)} | ${c.role} | ${ROLE_USE[c.role]} |\n`;
    if (profile.darkModeVars.length > 0) {
        out += "\n### Dark Mode Token Mapping\n\n| Variable | Light | Dark |\n|---|---|---|\n";
        for (const v of profile.darkModeVars.slice(0, 20)) out += `| ${code(v.variable)} | ${code(v.lightValue)} | ${code(v.darkValue)} |\n`;
    }
    const vars = paletteVariables(profile);
    if (vars.length > 0) out += `\n### CSS Variable Tokens\n\n${fenced("css", vars.slice(0, 20).map((v) => `${v.name}: ${v.value};`).join("\n"))}`;
    return out;
}

function typography(profile: types.DesignProfile): string {
    if (profile.typography.length === 0) return "## 3. Typography Rules\n\nNo typography tokens detected.";
    const fonts = fontFamilies(profile);
    let out = "## 3. Typography Rules\n\n**Font Stack:**\n";
    for (const font of fonts) out += `- **${text(font)}**: ${profile.typography.filter((t) => t.fontFamily === font).map((t) => formatRole(t.role)).join(", ")}\n`;
    out += "\n";
    const faces = fontFaceCss(profile);
    if (faces) out += `**Font Sources:**\n\n${fenced("css", faces)}\n`;
    out += "| Role | Font | Size | Weight |\n|---|---|---|---|\n";
    for (const t of profile.typography) out += `| ${formatRole(t.role)} | ${text(t.fontFamily, 60)} | ${text(t.fontSize ?? "inherit", 30)} | ${text(String(t.fontWeight ?? "inherit"), 20)} |\n`;
    const pair = typePair(profile);
    out += "\n**Typographic Rules:**\n";
    if (pair.heading === pair.body) out += `- Use **${text(pair.body)}** for all text; do not mix font families\n`;
    else out += `- Limit to ${fonts.length} font families per screen\n- Use **${text(pair.body)}** for body/UI text, **${text(pair.heading)}** for display/headings\n`;
    out += `- Keep hierarchy tight: no more than 3-4 font sizes per screen\n- Headings use weight ${headingWeight(profile)}, body text ${bodyWeight(profile)}\n- ${lineHeightRule(profile)}\n- Use color and opacity for secondary hierarchy, not more font sizes\n`;
    return out;
}

function visualClasses(comp: types.ComponentInfo): string[] {
    const tp = comp.tailwindPatterns;
    const picks = [
        tp.borders.find((c) => c.startsWith("rounded")),
        tp.borders.find((c) => c.startsWith("border-") && !c.startsWith("border-t") && !c.startsWith("border-b")),
        tp.backgrounds[0], tp.spacing[0],
        tp.typography.find((c) => /text-(xs|sm|base|lg|xl|2xl|3xl|4xl)/.test(c)),
        tp.typography.find((c) => c.startsWith("font-")),
        tp.effects[0], tp.interactive[0],
    ];
    return picks.filter((c): c is string => !!c).map((c) => code(c));
}

function components(profile: types.DesignProfile): string {
    if (profile.components.length === 0) return "## 4. Component Stylings\n\nNo components detected. Components are read from `src/components/`, `components/` and similar folders.";
    let out = "## 4. Component Stylings\n\n";
    for (const cat of Object.keys(CATEGORY_NAMES) as types.ComponentCategory[]) {
        const comps = profile.components.filter((c) => c.category === cat);
        if (comps.length === 0) continue;
        out += `### ${CATEGORY_NAMES[cat]} (${comps.length})\n\n`;
        for (const comp of comps.slice(0, 8)) {
            out += `**${text(comp.name, 60)}**: ${code(comp.filePath)}\n`;
            if (comp.variants.length > 0) out += `- Variants: ${comp.variants.map((v) => code(v)).join(", ")}\n`;
            if (comp.props.length > 0) out += `- Props: ${comp.props.slice(0, 8).map((p) => code(p)).join(", ")}${comp.props.length > 8 ? ` (+${comp.props.length - 8} more)` : ""}\n`;
            const styles = visualClasses(comp);
            if (styles.length > 0) out += `- Key Styles: ${styles.join(", ")}\n`;
            if (comp.hasAnimation) out += `- Animation: ${comp.animationDetails.slice(0, 3).map((d) => code(d, 120)).join(", ")}\n`;
            if (comp.statePatterns.length > 0) out += `- State: ${comp.statePatterns.join(", ")}\n`;
            const snippet = comp.jsxSnippet.split("\n").slice(0, 12).join("\n").trim();
            if (snippet) out += `\n${fenced("tsx", snippet)}`;
            out += "\n";
        }
        if (comps.length > 8) out += `*...and ${comps.length - 8} more ${CATEGORY_NAMES[cat].toLowerCase()} components.*\n\n`;
    }
    return out;
}

export function spacingMeaningRows(base: number): string {
    if (base <= 4) {
        return `| ${base}-${base * 2}px | Tight: related items within a group |\n| ${base * 3}-${base * 4}px | Medium: between groups |\n| ${base * 6}-${base * 8}px | Wide: between sections |\n| ${base * 12}px+ | Vast: major section breaks |\n`;
    }
    return `| ${base / 2}-${base}px | Tight: related items within a group |\n| ${base * 2}px | Medium: between groups |\n| ${base * 3}-${base * 4}px | Wide: between sections |\n| ${base * 6}px+ | Vast: major section breaks |\n`;
}

function layout(profile: types.DesignProfile): string {
    const sp = profile.spacing;
    let out = `## 5. Layout Principles\n\n- **Base spacing unit:** ${sp.base}px\n- **Spacing scale:** ${sp.values.slice(0, 12).join(", ")}\n`;
    const radii = profile.borderRadius.filter((r) => !r.includes("9999"));
    if (radii.length > 0) out += `- **Border radius:** ${radii.map((r) => text(r, 20)).join(", ")}\n`;
    if (profile.containerMaxWidth) out += `- **Max content width:** ${text(profile.containerMaxWidth, 30)}\n`;
    const grid = new Set<string>();
    for (const comp of profile.components) for (const cls of comp.tailwindPatterns.layout) if (/grid-cols-\d+|col-span|columns-\d+/.test(cls)) grid.add(cls);
    if (grid.size > 0) out += `- **Grid usage:** ${[...grid].slice(0, 5).map((c) => code(c)).join(", ")}\n`;
    if (profile.frameworks.some((f) => f.id === "tailwind")) out += "- **Container:** Tailwind `container` class with responsive padding\n";
    out += `\n**Spacing as Meaning:**\n| Spacing | Use |\n|---|---|\n${spacingMeaningRows(sp.base)}`;
    return out;
}

const ELEVATION_TABLE = "| Level | Technique | Use |\n|---|---|---|\n| 0 - Base | Background color | Page background |\n| 1 - Raised | Lighter surface + subtle border | Cards, panels |\n| 2 - Floating | Even lighter surface + stronger border | Dropdowns, popovers |\n| 3 - Overlay | Backdrop + modal surface | Modals, dialogs |\n";

function elevation(profile: types.DesignProfile): string {
    const zIndex = profile.zIndexScale.length > 0 ? `\n**Z-Index Scale:** ${code(profile.zIndexScale.join(", "))}\n` : "";
    if (profile.shadows.length === 0) {
        const body = profile.designTraits.isDark
            ? `No box-shadow values detected. The design uses a **flat visual style**: elevation is conveyed through background shifts and borders.\n\n**Elevation Strategy:**\n${ELEVATION_TABLE}`
            : "No box-shadow values detected. The design appears to use a flat visual style.\n";
        return `## 6. Depth & Elevation\n\n${body}${zIndex}`;
    }
    const names: Record<types.ShadowLevel, string> = {
        flat: "Flat - subtle depth hints", raised: "Raised - cards, buttons, interactive elements",
        floating: "Floating - dropdowns, popovers, modals", overlay: "Overlay - full-screen overlays, top-level dialogs",
    };
    let out = "## 6. Depth & Elevation\n\n";
    for (const level of ["flat", "raised", "floating", "overlay"] as types.ShadowLevel[]) {
        const shadows = profile.shadows.filter((s) => s.level === level);
        if (shadows.length === 0) continue;
        out += `### ${names[level]}\n\n`;
        for (const s of shadows.slice(0, 3)) out += `- ${s.name ? `**${text(s.name, 40)}:** ` : ""}${code(s.value)}\n`;
        out += "\n";
    }
    return out + zIndex;
}

export const FRAMER_SNIPPET = "// Standard enter animation\n<motion.div\n  initial={{ opacity: 0, y: 8 }}\n  animate={{ opacity: 1, y: 0 }}\n  transition={{ duration: 0.3, ease: \"easeOut\" }}\n/>\n\n// List stagger\nconst container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }\nconst item = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }";

function motion(profile: types.DesignProfile): string {
    const t = profile.designTraits;
    if (!t.hasAnimations && t.motionStyle === "none") return "";
    let out = "## 7. Animation & Motion\n\n";
    out += t.motionStyle === "expressive"
        ? "This project uses **expressive motion**. Animations are an integral part of the experience.\n\n"
        : "This project uses **subtle motion**. Transitions smooth state changes without demanding attention.\n\n";
    if (profile.animations.some((a) => a.type === "framer-motion")) out += `### Framer Motion Patterns\n\n${fenced("tsx", FRAMER_SNIPPET)}\n`;
    const keyframes = profile.animations.filter((a) => a.type === "css-keyframe");
    if (keyframes.length > 0) out += `### CSS Animations\n\n${keyframes.slice(0, 8).map((k) => `- ${code(`@keyframes ${k.name}`)}`).join("\n")}\n\n`;
    const animated = profile.components.filter((c) => c.hasAnimation).slice(0, 5);
    if (animated.length > 0) out += `### Animated Components\n\n${animated.map((c) => `- **${text(c.name, 60)}**: ${c.animationDetails.slice(0, 3).map((d) => code(d, 120)).join(", ")}`).join("\n")}\n\n`;
    out += "### Motion Guidelines\n\n- Duration: 150-300ms for micro-interactions, 300-500ms for page transitions\n- Easing: `ease-out` for enters, `ease-in` for exits\n- Always respect `prefers-reduced-motion`\n";
    return out;
}

function dosAndDonts(profile: types.DesignProfile): string {
    const dos: string[] = [];
    const donts: string[] = [];
    const t = profile.designTraits;
    const accent = roleColor(profile, "accent");
    const bg = roleColor(profile, "background");
    const fonts = fontFamilies(profile);
    const pair = typePair(profile);
    if (accent) dos.push(`Use ${code(accent.hex)} for interactive elements (buttons, links, focus rings)`);
    if (bg) dos.push(`Use ${code(bg.hex)} as the primary page background`);
    donts.push("Don't introduce colors outside this palette; extend the design tokens first");
    if (fonts.length > 0 && pair.heading === pair.body) {
        dos.push(`Use **${text(pair.body)}** for all UI text`);
        donts.push(`Don't mix font families; use ${text(pair.body)} consistently`);
    } else if (fonts.length > 0) {
        dos.push(`Pair **${text(pair.body)}** (body) with **${text(pair.heading)}** (display); these are the only allowed fonts`);
        donts.push(`Don't introduce font families beyond ${fonts.map((f) => text(f)).join(" and ")}`);
    }
    dos.push(`Follow the **${profile.spacing.base}px** spacing grid for all margins, padding and gaps`);
    donts.push(`Don't use arbitrary spacing values; stick to multiples of ${profile.spacing.base}px`);
    if (!t.hasShadows) {
        dos.push("Use border and background shifts for elevation, not shadows");
        donts.push("Don't add box-shadow; this design system uses flat elevation");
    } else {
        dos.push("Use the defined shadow tokens for elevation (Section 6)");
        donts.push("Don't create box-shadow values outside the system tokens");
    }
    if (!t.hasGradients) donts.push("Don't use gradients; the design uses solid colors only");
    if (profile.borderRadius.length > 0) {
        dos.push(`Use border-radius from the scale: ${profile.borderRadius.filter((r) => !r.includes("9999")).slice(0, 5).map((r) => text(r, 20)).join(", ")}`);
        donts.push("Don't use arbitrary border-radius values; pick from the defined scale");
    }
    if (profile.components.length > 0) {
        dos.push("Reuse existing components from Section 4 before creating new ones");
        donts.push("Don't duplicate component patterns; check Section 4 first");
    }
    if (profile.iconLibrary) {
        dos.push(`Use **${profile.iconLibrary}** for all icons`);
        donts.push("Don't mix icon libraries");
    }
    if (profile.antiPatterns.includes("no-blur")) donts.push("Don't use backdrop-blur or blur effects");
    if (t.hasDarkMode) {
        dos.push("Always use CSS variables for colors; never hardcode hex");
        dos.push("Test both light and dark modes for contrast");
    }
    let out = `## 8. Do's and Don'ts\n\n### Do's\n\n${dos.map((d) => `- ${d}`).join("\n")}\n\n### Don'ts\n\n${donts.map((d) => `- ${d}`).join("\n")}\n`;
    const detected = [
        profile.antiPatterns.includes("no-shadows") && "No box-shadow on any element",
        profile.antiPatterns.includes("no-gradients") && "No gradient backgrounds",
        profile.antiPatterns.includes("no-blur") && "No blur or backdrop-blur effects",
        profile.antiPatterns.includes("no-zebra-striping") && "No zebra striping on tables/lists",
    ].filter((x): x is string => !!x);
    if (detected.length >= 2) out += `\n### Anti-Patterns (detected)\n\n${detected.map((d) => `- ${d}`).join("\n")}\n`;
    return out;
}

function responsive(profile: types.DesignProfile): string {
    if (profile.breakpoints.length === 0) return "## 9. Responsive Behavior\n\nNo breakpoints detected.";
    let out = "## 9. Responsive Behavior\n\n| Name | Value | Source |\n|---|---|---|\n";
    for (const bp of profile.breakpoints) out += `| ${text(bp.name, 30)} | ${text(bp.value, 30)} | ${bp.source} |\n`;
    out += profile.frameworks.some((f) => f.id === "tailwind")
        ? "\n**Approach:** Mobile-first using Tailwind responsive prefixes (`sm:`, `md:`, `lg:`, `xl:`, `2xl:`).\nDesign for mobile first, then layer on responsive overrides.\n"
        : "\n**Approach:** Use `@media (min-width: ...)` queries matching the breakpoints above.\n";
    return out;
}

function promptGuide(profile: types.DesignProfile): string {
    const col = (role: types.ColorRole, fallback: string): string => roleColor(profile, role)?.hex ?? `var(--${fallback})`;
    const surface = roleColor(profile, "surface")?.hex ?? col("background", "surface");
    const primaryFont = typePair(profile).body;
    const radius = commonRadius(profile);
    const sp = profile.spacing;
    const shadowNote = profile.designTraits.hasShadows ? "Use shadow tokens from Section 6." : "No shadows; use borders and surface colors for depth.";
    const block = (title: string, lines: string[]): string => `### ${title}\n\n${fenced("", lines.join("\n"))}\n`;
    return ["## 10. Agent Prompt Guide\n\nUse these as starting points when building new UI:\n\n",
        block("Build a Card", [`Background: ${surface}`, `Border: 1px solid ${col("border", "border")}`, `Radius: ${radius}`, `Padding: ${pickSpacing(sp, 4)}px`, `Font: ${primaryFont}`, shadowNote]),
        block("Build a Button", [`Primary: bg ${col("accent", "accent")}, text white`, `Ghost: bg transparent, border ${col("border", "border")}`,
            `Padding: ${pickSpacing(sp, 2)}px ${pickSpacing(sp, 4)}px`, `Radius: ${radius}`, "Hover: opacity 0.9 or lighter shade", `Focus: ring with ${col("accent", "accent")}`]),
        block("Build a Page Layout", [`Background: ${col("background", "background")}`, `Max-width: ${profile.containerMaxWidth ?? "1280px"}, centered`, `Grid: ${sp.base}px base`, "Responsive: mobile-first, breakpoints from Section 9"]),
        block("Build a Stats Card", [`Surface: ${surface}`, `Label: ${col("text-muted", "text-muted")} (muted, 12px, uppercase)`, `Value: ${col("text-primary", "text-primary")} (primary, 24-32px, bold)`, "Status: use success/warning/danger from Section 2"]),
        block("Build a Form", [`Input bg: ${col("background", "background")}`, `Input border: 1px solid ${col("border", "border")}`, `Focus: border-color ${col("accent", "accent")}`,
            `Label: ${col("text-muted", "text-muted")} 12px`, `Spacing: ${pickSpacing(sp, 4)}px between fields`, `Radius: ${radius}`]),
        block("General Component", ["1. Read DESIGN.md Sections 2-6 for tokens", "2. Colors: only from palette", `3. Font: ${primaryFont}, type scale from Section 3`,
            `4. Spacing: ${sp.base}px grid`, "5. Components: match patterns from Section 4", `6. Elevation: ${profile.designTraits.hasShadows ? "shadow tokens" : "flat, surface shifts"}`]),
    ].join("");
}

export function generateDesignMd(profile: types.DesignProfile, screenshotPath: string | null): string {
    const sections = [
        header(profile, screenshotPath), visualTheme(profile), colorPalette(profile), typography(profile), components(profile),
        layout(profile), elevation(profile), motion(profile), dosAndDonts(profile), responsive(profile), promptGuide(profile),
    ];
    return `${sections.filter(Boolean).map((s) => s.trimEnd()).join("\n\n---\n\n")}\n`;
}
