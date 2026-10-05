/**
 * The browser-only reference files: LAYOUT.md (containers and spacing), INTERACTIONS.md
 * (hover/focus diffs), COMPONENTS.md (repeated DOM patterns), VISUAL_GUIDE.md (every
 * screenshot in reading order) and screens/INDEX.md.
 */

import { basename } from "node:path";
import type * as types from "../types";
import { code, fenced, image, text } from "./md";
import { commonRadius, roleColor } from "./design-md";

function simplify(value: string): string {
    if (!value || value === "normal") return "-";
    return value === "flex-start" ? "start" : value === "flex-end" ? "end" : value;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
    return out;
}

export function generateLayoutMd(layouts: types.LayoutRecord[], profile: types.DesignProfile): string {
    let md = "# Layout Reference\n\n> Extracted from the live DOM: how the site is structured spatially.\n\n";
    if (layouts.length === 0) return `${md}No layout containers were found on the page.\n`;
    const base = profile.spacing.base;
    md += `## Spacing System\n\n**Base grid:** ${base}px\n\n`;
    if (profile.spacing.values.length > 0) md += `**Scale:** \`${profile.spacing.values.slice(0, 16).join(", ")}\` px\n\n`;
    md += `| Spacing | Semantic Use |\n|---------|-------------|\n| ${base}px | Tight: within a component |\n| ${base * 2}px | Medium: between sibling items |\n| ${base * 4}px | Wide: between sections |\n| ${base * 8}px | Vast: major section breaks |\n\n`;
    const gap = (l: types.LayoutRecord): string => (l.gap && l.gap !== "normal" ? text(l.gap, 30) : "-");

    const flex = layouts.filter((l) => l.display === "flex" || l.display === "inline-flex");
    if (flex.length > 0) {
        md += "## Flex Layouts\n\n| Element | Direction | Justify | Align | Gap | Children |\n|---------|-----------|---------|-------|-----|----------|\n";
        for (const l of flex.slice(0, 15)) md += `| ${code(l.selector)} | ${l.flexDirection || "row"} | ${simplify(l.justifyContent)} | ${simplify(l.alignItems)} | ${gap(l)} | ${l.childCount} |\n`;
        md += "\n";
    }
    const grid = layouts.filter((l) => l.display === "grid" || l.display === "inline-grid");
    if (grid.length > 0) {
        md += "## Grid Layouts\n\n| Element | Template Columns | Gap | Children |\n|---------|-----------------|-----|----------|\n";
        for (const l of grid.slice(0, 10)) {
            const cols = l.gridTemplateColumns && l.gridTemplateColumns !== "none" ? code(l.gridTemplateColumns.slice(0, 50)) : "-";
            md += `| ${code(l.selector)} | ${cols} | ${gap(l)} | ${l.childCount} |\n`;
        }
        md += "\n";
    }
    const structural = layouts.filter((l) => ["header", "nav", "main", "footer", "section", "article"].includes(l.tag));
    if (structural.length > 0) {
        md += "## Structural Containers\n\n";
        for (const l of structural.slice(0, 12)) {
            const lines = [`display:          ${l.display}`];
            if (l.display.includes("flex")) lines.push(`flex-direction:   ${l.flexDirection || "row"}`, `justify-content:  ${simplify(l.justifyContent)}`, `align-items:      ${simplify(l.alignItems)}`);
            if (l.display.includes("grid") && l.gridTemplateColumns && l.gridTemplateColumns !== "none") lines.push(`grid-template-columns: ${l.gridTemplateColumns.slice(0, 60)}`);
            if (l.gap && l.gap !== "normal") lines.push(`gap:              ${l.gap}`);
            if (l.padding && l.padding !== "0px") lines.push(`padding:          ${l.padding}`);
            if (l.maxWidth && l.maxWidth !== "none") lines.push(`max-width:        ${l.maxWidth}`);
            lines.push(`children:         ${l.childCount}`);
            md += `### \`<${l.tag}>\`${l.selector !== l.tag ? ` (${code(l.selector)})` : ""}\n\n${fenced("", lines.join("\n"))}\n`;
        }
    }
    md += "## Layout Rules\n\n";
    const container = layouts.find((l) => l.maxWidth && l.maxWidth !== "none");
    if (container) md += `- **Container max-width:** ${code(container.maxWidth)}; center it with \`margin: auto\`\n`;
    if (flex.length > 0) md += "- Primary layout system: **Flexbox**\n";
    if (grid.length > 0) md += "- Secondary layout system: **CSS Grid** (card grids and multi-column layouts)\n";
    return `${md}- Every spacing value is a multiple of **${base}px**\n- Never use margin/padding values outside the spacing scale\n`;
}

const TYPE_LABELS: Record<string, string> = { "button": "Button", "link": "Link", "input": "Input", "role-button": "Role Button" };

function cssProperty(camel: string): string {
    return camel.replace(/([A-Z])/g, "-$1").toLowerCase();
}

function isIdleTransition(t: string): boolean {
    return !t || t === "none" || t.startsWith("all 0s");
}

export function generateInteractionsMd(interactions: types.InteractionRecord[], profile: types.DesignProfile): string {
    let md = "# Interaction Reference\n\n> Micro-interactions captured on the live page. Recreate these for an authentic feel.\n\n";
    if (interactions.length === 0) return `${md}No interactive elements were found on the page.\n`;
    const byType = groupBy(interactions, (i) => i.componentType);
    md += "## Coverage\n\n| Component Type | Count | States Captured |\n|----------------|-------|----------------|\n";
    for (const [type, records] of byType) {
        const states = new Set<string>();
        for (const r of records) for (const s of ["default", "hover", "focus"] as const) if (r.screenshots[s]) states.add(s);
        md += `| ${TYPE_LABELS[type] ?? type} | ${records.length} | ${[...states].join(", ")} |\n`;
    }
    md += "\n";
    const transitions = [...new Set(interactions.map((i) => i.transitionValue).filter((t) => !isIdleTransition(t)))];
    if (transitions.length > 0) {
        md += `## Transition System\n\nTransitions declared on interactive elements:\n\n${fenced("css", transitions.slice(0, 8).map((t) => `transition: ${t};`).join("\n"))}\nApply these to interactive elements; never invent new durations or easings.\n\n`;
    }
    const diffBlock = (title: string, diffs: types.StyleDiff[]): string => (diffs.length === 0 ? "" :
        `**${title}:**\n\n${fenced("css", diffs.map((d) => `/* ${cssProperty(d.property)}: ${d.from} -> */ ${cssProperty(d.property)}: ${d.to};`).join("\n"))}\n`);
    for (const [type, records] of byType) {
        md += `## ${TYPE_LABELS[type] ?? type} Interactions\n\n`;
        for (const rec of records) {
            md += `### ${TYPE_LABELS[type] ?? type} ${rec.index}: ${code(rec.label, 40)}\n\n`;
            const shots = (["default", "hover", "focus"] as const).filter((s) => rec.screenshots[s]);
            if (shots.length > 0) md += `**States:**\n\n${shots.map((s) => `- ${s.charAt(0).toUpperCase()}${s.slice(1)}: \`../${rec.screenshots[s]}\``).join("\n")}\n\n`;
            md += diffBlock("On hover", rec.hoverChanges) + diffBlock("On focus", rec.focusChanges);
            if (!isIdleTransition(rec.transitionValue)) md += `**Transition:** ${code(rec.transitionValue)}\n\n`;
            if (rec.hoverChanges.length === 0 && rec.focusChanges.length === 0) md += "_No visible style change on hover or focus._\n\n";
        }
    }
    md += "## Interaction Rules\n\n";
    const accent = roleColor(profile, "accent");
    if (accent) md += `- Accent ${code(accent.hex)} marks focus rings, active states and hover highlights\n`;
    const hoverProps = new Set(interactions.flatMap((i) => i.hoverChanges.map((d) => d.property)));
    if (hoverProps.has("opacity")) md += "- Hover effects use **opacity** changes\n";
    if (hoverProps.has("color") || hoverProps.has("backgroundColor")) md += "- Hover effects include **color transitions**; use the extracted values, not approximations\n";
    if (interactions.some((i) => i.focusChanges.some((d) => d.property === "outline" || d.property === "outlineColor"))) md += "- Focus states use an **outline** (not a box-shadow); match the extracted focus ring\n";
    const durations = [...new Set(transitions.join(" ").match(/\d+(?:\.\d+)?(?:ms|s)/g) ?? [])];
    if (durations.length > 0) md += `- Transition durations in use: ${durations.map((d) => code(d)).join(", ")}\n`;
    return `${md}- Always respect \`prefers-reduced-motion\`: set transitions to \`0s\` when it is on\n`;
}

const CATEGORY_LABELS: Record<types.DOMComponent["category"], string> = {
    "card": "Cards", "list-item": "List Items", "nav-item": "Navigation Items", "button": "Buttons",
    "badge": "Badges & Chips", "form-field": "Form Fields", "unknown": "Other Components",
};

function suggestedCss(comp: types.DOMComponent, profile: types.DesignProfile): string {
    const sp = profile.spacing;
    const pad = sp.base * 2;
    const hex = (role: types.ColorRole): string | undefined => roleColor(profile, role)?.hex;
    const radius = commonRadius(profile);
    const cls = (comp.commonClasses[0] ?? comp.name.toLowerCase().replace(/\s+/g, "-")).replace(/[^\w-]/g, "");
    const lines = [`.${cls} {`];
    const add = (cond: string | undefined | boolean, line: string): void => { if (cond) lines.push(line); };
    switch (comp.category) {
        case "card":
            add(hex("surface"), `  background: ${hex("surface")};`); add(hex("border"), `  border: 1px solid ${hex("border")};`);
            lines.push(`  border-radius: ${radius};`, `  padding: ${pad}px;`);
            break;
        case "button":
            add(hex("accent"), `  background: ${hex("accent")};`); add(hex("text-primary"), `  color: ${hex("text-primary")};`);
            lines.push(`  border-radius: ${radius};`, `  padding: ${sp.base}px ${pad}px;`, "  cursor: pointer;");
            break;
        case "badge":
            add(hex("surface"), `  background: ${hex("surface")};`); add(hex("border"), `  border: 1px solid ${hex("border")};`);
            lines.push(`  border-radius: ${radius};`, `  padding: ${Math.round(sp.base * 0.5)}px ${sp.base}px;`, "  font-size: 12px;");
            break;
        case "nav-item":
            lines.push(`  padding: ${sp.base}px ${pad}px;`, "  cursor: pointer;");
            add(hex("accent"), `  /* active: color: ${hex("accent")}; */`);
            break;
        case "list-item":
            lines.push(`  padding: ${sp.base}px 0;`);
            add(hex("border"), `  border-bottom: 1px solid ${hex("border")};`);
            break;
        default:
            add(hex("surface"), `  background: ${hex("surface")};`);
            lines.push(`  padding: ${sp.base}px;`);
    }
    lines.push("}");
    return lines.join("\n");
}

export function generateComponentsMd(components: types.DOMComponent[], profile: types.DesignProfile): string {
    let md = "# Component Reference\n\n> Repeated DOM patterns found by structural analysis. Each appeared at least three times.\n\n";
    if (components.length === 0) return `${md}No repeated components were found on the page.\n`;
    md += "## Detected Components\n\n| Component | Category | Instances | Key Classes |\n|-----------|----------|-----------|-------------|\n";
    for (const c of components) md += `| **${text(c.name, 60)}** | ${c.category} | ${c.instances}x | ${c.commonClasses.slice(0, 3).map((cl) => code(`.${cl}`)).join(", ")} |\n`;
    md += "\n";
    const byCategory = groupBy(components, (c) => c.category);
    for (const category of Object.keys(CATEGORY_LABELS) as Array<types.DOMComponent["category"]>) {
        const comps = byCategory.get(category);
        if (!comps?.length) continue;
        md += `## ${CATEGORY_LABELS[category]}\n\n`;
        for (const comp of comps) {
            md += `### ${text(comp.name, 60)}\n\n**Instances found:** ${comp.instances}\n\n`;
            if (comp.commonClasses.length > 0) md += `**CSS classes:** ${comp.commonClasses.map((c) => code(`.${c}`)).join(" ")}\n\n`;
            md += `**HTML structure:**\n\n${fenced("html", comp.htmlSnippet)}\n**Base styles (from the design tokens):**\n\n${fenced("css", suggestedCss(comp, profile))}\n`;
        }
    }
    md += "## Component Rules\n\n- Match class names exactly from the patterns above\n- Instances of one component must look identical\n- Do not add wrappers or change the DOM structure\n";
    const border = roleColor(profile, "border");
    const accent = roleColor(profile, "accent");
    if (border) md += `- Use ${code(border.hex)} for dividers within components\n`;
    if (accent) md += `- Use ${code(accent.hex)} for interactive/active states\n`;
    return md;
}

export function generateVisualGuideMd(profile: types.DesignProfile, pages: types.PageScreenshot[], sections: types.SectionScreenshot[], anim: types.FullAnimationResult): string {
    let md = `# ${text(profile.projectName)} - Visual Guide\n\n> Master visual reference. Study every screenshot before implementing UI.\n> Match colors, layout, typography, spacing and motion states.\n\n`;
    if (anim.libraries.length > 0) md += `**Motion Stack:** ${anim.libraries.map((l) => `**${text(l.name, 60)}**`).join(", ")}\n\n`;
    if (anim.webglDetected) md += `**WebGL/3D:** detected (${anim.canvasCount} canvas elements); reproduce with Three.js or CSS 3D transforms\n\n`;
    if (anim.scrollFrames.length > 0) {
        md += "## Scroll Journey\n\nEach screenshot is the page at one scroll depth. Reproduce the transitions between them.\n\n";
        for (const f of anim.scrollFrames) {
            const label = f.scrollPercent === 0 ? "Hero - above the fold" : f.scrollPercent === 100 ? "Footer - end of page" : `${f.scrollPercent}% scroll depth`;
            md += `### ${label}\n\n*Scroll position: ${f.scrollY}px of ${f.pageHeight}px*\n\n${image(label, `../screens/scroll/${basename(f.filePath)}`)}\n\n`;
        }
    }
    const framed = anim.videos.filter((v) => v.firstFramePath);
    if (framed.length > 0) {
        md += "## Video Backgrounds\n\nThese videos play as background elements; use the first frame as the poster while the video loads.\n\n";
        for (const v of framed) md += `### Video ${v.index} (${v.role})\n\n${v.src ? `*Source: ${code(v.src, 80)}*\n\n` : ""}${image(`Video ${v.index} first frame`, `../screens/scroll/${basename(v.firstFramePath!)}`)}\n\n`;
    }
    if (pages.length > 0) {
        md += "## Full Page Screenshots\n\n";
        for (const p of pages) md += `### ${text(p.title, 80)}\n\n*URL: ${code(p.url)}*\n\n${image(p.title, `../screens/pages/${basename(p.filePath)}`)}\n\n`;
    }
    if (sections.length > 0) {
        md += "## Section Screenshots\n\nClipped sections showing individual components in context.\n\n";
        for (const s of sections) md += `### ${text(s.page, 60)} - section ${s.index} (${code(s.selector)})\n\n*${s.width}x${s.height}px*\n\n${image(`Section ${s.index}`, `../screens/sections/${basename(s.filePath)}`)}\n\n`;
    }
    return md;
}

export function generateScreensIndex(pages: types.PageScreenshot[], sections: types.SectionScreenshot[], anim: types.FullAnimationResult): string {
    let md = "# Screenshot Index\n\n";
    if (anim.scrollFrames.length > 0) {
        md += "## Scroll Journey\n\n| Scroll | Y Position | File |\n|--------|-----------|------|\n";
        for (const f of anim.scrollFrames) md += `| ${f.scrollPercent}% | ${f.scrollY}px | \`${f.filePath}\` |\n`;
        md += "\n";
    }
    const framed = anim.videos.filter((v) => v.firstFramePath);
    if (framed.length > 0) md += `## Video First Frames\n\n${framed.map((v) => `- Video ${v.index} (${v.role}): \`${v.firstFramePath}\``).join("\n")}\n\n`;
    if (pages.length > 0) {
        md += "## Pages\n\n| Page | URL | File |\n|------|-----|------|\n";
        for (const p of pages) md += `| ${text(p.title, 60)} | ${code(p.url)} | \`${p.filePath}\` |\n`;
        md += "\n";
    }
    if (sections.length > 0) {
        md += "## Sections\n\n| Page | Section | File |\n|------|---------|------|\n";
        for (const s of sections) md += `| ${text(s.page, 60)} | #${s.index} (${code(s.selector)}) | \`${s.filePath}\` |\n`;
    }
    return md;
}
