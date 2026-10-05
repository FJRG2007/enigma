/**
 * UI components a live site renders, recognized from its markup (static HTML and the
 * `_jsx("tag")`/`createElement("tag")` calls of client-rendered bundles) and from the
 * class names its stylesheets define.
 */

import { emptyTailwindPattern } from "./components";
import type { ComponentCategory, ComponentInfo } from "../types";

function component(name: string, category: ComponentCategory, classes: Iterable<string> = [], extra: Partial<ComponentInfo> = {}): ComponentInfo {
    return {
        name, filePath: "html", variants: [], cssClasses: [...classes].slice(0, 10), jsxSnippet: "", props: [], category,
        hasAnimation: false, animationDetails: [], statePatterns: [], tailwindPatterns: emptyTailwindPattern(), ...extra,
    };
}

function jsxUses(html: string, tag: string): boolean {
    return new RegExp(`(?:_jsx|createElement)\\s*\\(\\s*["']${tag}["']`, "i").test(html);
}

/** `.class { declarations }` from the combined CSS, by class name. */
function ruleLookup(css: string): Map<string, string[]> {
    const rules = new Map<string, string[]>();
    for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
        const list = rules.get(m[1]!) ?? [];
        list.push(m[2]!.trim());
        rules.set(m[1]!, list);
    }
    return rules;
}

function matchingStyles(rules: Map<string, string[]>, classes: Set<string>, patterns: string[]): string {
    const decls: string[] = [];
    for (const cls of classes) decls.push(...(rules.get(cls) ?? []));
    for (const [cls, list] of rules) if (patterns.some((p) => cls.includes(p))) decls.push(...list);
    return decls.join("; ");
}

function elementClasses(html: string, tag: string): Set<string> {
    const classes = new Set<string>();
    for (const m of html.matchAll(new RegExp(`<${tag}[^>]*class\\s*=\\s*["']([^"']*)["']`, "gi"))) for (const c of m[1]!.split(/\s+/).filter(Boolean)) classes.add(c);
    for (const m of html.matchAll(new RegExp(`(?:_jsx|createElement)\\s*\\(\\s*["']${tag}["'][^)]*className\\s*:\\s*["'\`]([^"'\`]*)["'\`]`, "gi"))) {
        for (const c of m[1]!.split(/\s+/).filter(Boolean)) classes.add(c);
    }
    return classes;
}

function classesMatching(html: string, pattern: RegExp): Set<string> {
    const classes = new Set<string>();
    for (const m of html.matchAll(/(?:class|className)\s*[:=]\s*["'`]([^"'`]*)["'`]/gi)) {
        for (const cls of m[1]!.split(/\s+/).filter(Boolean)) if (pattern.test(cls)) classes.add(cls);
    }
    return classes;
}

function variantsOf(classes: Set<string>, base: string): string[] {
    const out = new Set<string>();
    for (const cls of classes) {
        if (!cls.includes(base) || cls === base) continue;
        const variant = cls.replace(new RegExp(`.*${base}[-_]?`, "i"), "");
        if (variant && variant.length < 20) out.add(variant);
    }
    return [...out].slice(0, 5);
}

export function detectHtmlComponents(html: string, css: string): ComponentInfo[] {
    const out: ComponentInfo[] = [];
    const rules = ruleLookup(css);

    const buttonClasses = new Set<string>();
    for (const m of html.matchAll(/<button[^>]*class\s*=\s*["']([^"']*)["'][^>]*>/gi)) for (const c of m[1]!.split(/\s+/).filter(Boolean)) buttonClasses.add(c);
    for (const m of html.matchAll(/<a[^>]*class\s*=\s*["']([^"']*\b(?:btn|button|cta)\b[^"']*)["'][^>]*>/gi)) for (const c of m[1]!.split(/\s+/).filter(Boolean)) buttonClasses.add(c);
    if (buttonClasses.size > 0 || /<button[\s>]/i.test(html) || jsxUses(html, "button")) {
        const styles = matchingStyles(rules, buttonClasses, ["btn", "button", "cta"]);
        out.push(component("Button", "data-input", buttonClasses, { variants: variantsOf(buttonClasses, "btn"), hasAnimation: styles.includes("transition") }));
    }

    const hasInputs = /<input[^>]*type\s*=\s*["'](text|email|password|search|url|tel|number)["']/i.test(html)
        || /<textarea/i.test(html) || /<select/i.test(html) || jsxUses(html, "input") || jsxUses(html, "textarea");
    if (hasInputs) out.push(component("Input", "data-input", elementClasses(html, "input"), { statePatterns: [":focus", ":placeholder"] }));

    const cards = classesMatching(html, /\bcard\b/i);
    if (cards.size >= 2) out.push(component("Card", "data-display", cards, { variants: variantsOf(cards, "card") }));

    if (/<nav[\s>]/i.test(html) || /<header[\s>]/i.test(html) || jsxUses(html, "nav")) {
        const navClasses = new Set([...elementClasses(html, "nav"), ...elementClasses(html, "header")]);
        out.push(component("Navigation", "navigation", navClasses));
    }

    const chips = classesMatching(html, /\b(chip|tag|badge|label|pill)\b/i);
    if (chips.size > 0) out.push(component("Badge", "data-display", chips));
    const modals = classesMatching(html, /\b(modal|dialog|drawer|overlay|popup)\b/i);
    if (modals.size > 0) out.push(component("Modal", "overlay", modals));
    if (/<footer[\s>]/i.test(html) || jsxUses(html, "footer")) out.push(component("Footer", "layout", elementClasses(html, "footer")));
    if ((html.match(/<img\s/gi) ?? []).length >= 3) out.push(component("Image", "media"));

    const svgCount = (html.match(/<svg[\s>]/gi) ?? []).length + (html.match(/(?:_jsx|createElement)\s*\(\s*["']svg["']/gi) ?? []).length;
    if (svgCount >= 3 || /lucide-react|heroicons|@phosphor|react-icons/i.test(html)) out.push(component("Icon", "media"));

    const lists = classesMatching(html, /\b(list|timeline|steps|progress)\b/i);
    if (lists.size > 0) out.push(component("List", "data-display", lists));

    if (/<canvas[\s>]/i.test(html) || /mapbox|leaflet|google.*maps/i.test(html) || jsxUses(html, "canvas") || /\bd3\b.*select|topojson/i.test(html)) {
        out.push(component("Map/Canvas", "media"));
    }
    return out;
}
