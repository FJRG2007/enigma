/**
 * UI components of a local project (React/Vue/Svelte files under the usual component
 * folders): name, category, variants, props, classes, animation and state patterns, and
 * a short markup snippet. Text analysis only; no file is parsed as code or executed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname, extname, relative } from "node:path";
import type { ComponentCategory, ComponentInfo, TailwindPattern } from "../types";

const COMPONENT_DIRS = [
    "src/components", "components", "app/components", "src/app/components", "src/ui", "src/common",
    "lib/components", "src/lib/components", "src/features", "src/views", "src/pages", "app", "pages",
];
const COMPONENT_EXTENSIONS = [".tsx", ".jsx", ".vue", ".svelte"];
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "__tests__", "__mocks__", ".next", ".nuxt"]);
const NON_COMPONENT_FILES = new Set(["types", "utils", "helpers", "constants", "styles", "hooks", "context", "store", "provider"]);
const MAX_FILE_BYTES = 512 * 1024;
/** A ceiling on files read, so a monorepo with thousands of pages stays a bounded scan. */
const MAX_COMPONENTS = 2000;

const CATEGORY_PATTERNS: Array<[ComponentCategory, RegExp]> = [
    ["layout", /^(layout|container|grid|stack|flex|page|section|wrapper|sidebar|header|footer|main|shell|frame|panel|divider|spacer|center)/i],
    ["navigation", /^(nav|navbar|menu|breadcrumb|tab|tabs|pagination|stepper|link|drawer|appbar|topbar|bottombar)/i],
    ["data-display", /^(card|list|table|avatar|badge|chip|tag|stat|metric|tooltip|accordion|collapse|timeline|tree|calendar|chart|graph|progress|indicator)/i],
    ["data-input", /^(input|form|select|checkbox|radio|switch|toggle|slider|textarea|datepicker|timepicker|upload|dropdown|combobox|autocomplete|search|filter|rating)/i],
    ["feedback", /^(alert|toast|snackbar|notification|banner|skeleton|spinner|loading|error|empty|placeholder|progress)/i],
    ["overlay", /^(modal|dialog|popover|sheet|bottomsheet|lightbox|overlay|confirm|command|commandpalette)/i],
    ["typography", /^(heading|text|title|paragraph|label|caption|code|highlight|prose|markdown|typography)/i],
    ["media", /^(image|video|icon|logo|thumbnail|gallery|carousel|slider|embed|player)/i],
];

const VARIANT_KEYWORDS = new Set([
    "primary", "secondary", "tertiary", "ghost", "outline", "link", "danger", "warning", "success", "info", "error",
    "sm", "md", "lg", "xl", "2xl", "small", "medium", "large", "default", "destructive", "subtle",
    "solid", "soft", "plain", "minimal", "filled",
]);

export function emptyTailwindPattern(): TailwindPattern {
    return { backgrounds: [], borders: [], spacing: [], typography: [], effects: [], layout: [], interactive: [] };
}

function toPascalCase(text: string): string {
    return text.replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (s) => s.toUpperCase());
}

function categorize(name: string, filePath: string, content: string, classes: string[]): ComponentCategory {
    for (const [category, pattern] of CATEGORY_PATTERNS) if (pattern.test(name)) return category;
    const path = filePath.toLowerCase();
    if (/\/layouts?\//.test(path)) return "layout";
    if (/\/nav|\/menu|\/header|\/footer/.test(path)) return "navigation";
    if (/\/forms?\/|\/inputs?\//.test(path)) return "data-input";
    if (/\/modals?\/|\/dialogs?\/|\/overlays?\//.test(path)) return "overlay";
    if (/\/feedback\/|\/toast|\/alert/.test(path)) return "feedback";
    if (/<form[\s>]|onSubmit|handleSubmit/i.test(content)) return "data-input";
    if (/<table[\s>]|<thead|<tbody/i.test(content)) return "data-display";
    if (/<nav[\s>]|useRouter|useNavigate|Link\s/i.test(content)) return "navigation";
    if (/AnimatePresence|createPortal|usePortal/i.test(content)) return "overlay";
    if (/grid-cols|flex.*gap|justify-between|items-center/.test(classes.join(" "))) return "layout";
    return "other";
}

function detectAnimations(content: string): { hasAnimation: boolean; animationDetails: string[]; } {
    const details: string[] = [];
    for (const v of content.match(/variants\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g) ?? []) details.push(`motion-variant: ${v.slice(0, 120)}`);
    if (/motion\.|<motion\./.test(content)) {
        details.push("framer-motion");
        const spring = content.match(/spring\s*:\s*\{([^}]+)\}/);
        if (spring) details.push(`spring: {${spring[1]!.trim()}}`);
        const transition = content.match(/transition\s*=\s*\{?\{([^}]+)\}/);
        if (transition) details.push(`transition: {${transition[1]!.trim()}}`);
        if (/AnimatePresence/.test(content)) details.push("animate-presence");
        if (/layoutId|layout=/.test(content)) details.push("layout-animation");
        const animate = content.match(/animate\s*=\s*\{?\{([^}]+)\}/);
        if (animate) details.push(`animate: {${animate[1]!.trim()}}`);
    }
    const animateClasses = content.match(/animate-[\w-]+/g);
    if (animateClasses) details.push(...[...new Set(animateClasses)].map((c) => `tw-${c}`));
    const transitionClasses = content.match(/transition-[\w-]+|duration-[\w-]+|ease-[\w-]+/g);
    if (transitionClasses) details.push(`tw-transitions: ${[...new Set(transitionClasses)].join(", ")}`);
    if (/hover:scale|hover:translate|hover:-translate|group-hover:/.test(content)) details.push("hover-transforms");
    return { hasAnimation: details.length > 0, animationDetails: details };
}

function detectStatePatterns(content: string): string[] {
    const checks: Array<[RegExp, string]> = [
        [/useState/, "useState"], [/useReducer/, "useReducer"], [/useContext/, "useContext"],
        [/useQuery|useMutation/, "react-query"], [/useSWR/, "swr"], [/useForm/, "react-hook-form"],
        [/useRef/, "useRef"], [/forwardRef/, "forwardRef"], [/React\.memo|memo\(/, "memo"],
    ];
    const out = checks.filter(([re]) => re.test(content)).map(([, name]) => name);
    if (/useStore|create\(/.test(content) && /zustand/i.test(content)) out.splice(3, 0, "zustand");
    return out;
}

export function tailwindPatternOf(classes: string[]): TailwindPattern {
    const p = emptyTailwindPattern();
    for (const cls of classes) {
        if (/^bg-/.test(cls)) p.backgrounds.push(cls);
        else if (/^(border|rounded|ring|outline)/.test(cls)) p.borders.push(cls);
        else if (/^(p-|px-|py-|pt-|pb-|pl-|pr-|m-|mx-|my-|mt-|mb-|ml-|mr-|gap-|space-)/.test(cls)) p.spacing.push(cls);
        else if (/^(text-|font-|tracking-|leading-|truncate|line-clamp)/.test(cls)) p.typography.push(cls);
        else if (/^(shadow|opacity|blur|backdrop|ring|drop-shadow|filter)/.test(cls)) p.effects.push(cls);
        else if (/^(flex|grid|col-|row-|justify|items-|self-|w-|h-|min-|max-|overflow|relative|absolute|fixed|sticky|z-)/.test(cls)) p.layout.push(cls);
        else if (/^(hover:|focus:|active:|disabled:|group-|peer-|cursor-|pointer-events|select-)/.test(cls)) p.interactive.push(cls);
    }
    return p;
}

function isLikelyVariant(text: string): boolean {
    return VARIANT_KEYWORDS.has(text.toLowerCase()) || text.length <= 15;
}

function extractVariants(content: string): string[] {
    const variants: string[] = [];
    const add = (v: string): void => { if (!variants.includes(v) && isLikelyVariant(v)) variants.push(v); };
    for (const m of content.matchAll(/['"](\w+)['"]\s*\|/g)) add(m[1]!);
    for (const m of content.matchAll(/\|\s*['"](\w+)['"]/g)) add(m[1]!);
    // class-variance-authority: `variants: { size: {...}, intent: {...} }`
    for (const m of content.matchAll(/variants?\s*:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gi)) {
        for (const k of m[1]!.matchAll(/(\w+)\s*:/g)) add(k[1]!);
    }
    return variants;
}

function extractClasses(content: string): string[] {
    const classes = new Set<string>();
    const addAll = (text: string): void => { for (const cls of text.split(/\s+/)) if (cls.trim() && !cls.includes("${")) classes.add(cls.trim()); };
    for (const m of content.matchAll(/class(?:Name)?\s*=\s*["']([^"']+)["']/g)) addAll(m[1]!);
    for (const m of content.matchAll(/class(?:Name)?\s*=\s*\{`([^`]+)`\}/g)) addAll(m[1]!.replace(/\$\{[^}]+\}/g, " "));
    for (const m of content.matchAll(/(?:cn|clsx|classnames|cva)\s*\(\s*["']([^"']+)["']/g)) addAll(m[1]!);
    for (const m of content.matchAll(/(?:cn|clsx|classnames)\s*\(([^)]+)\)/gs)) {
        for (const s of m[1]!.matchAll(/["']([^"']+)["']/g)) addAll(s[1]!);
    }
    return [...classes].slice(0, 80);
}

function extractSnippet(content: string): string {
    const m = content.match(/return\s*\(\s*\n?([\s\S]*?)\n?\s*\);?/) ?? content.match(/=>\s*\(\s*\n?([\s\S]*?)\n?\s*\);?/);
    return m ? m[1]!.split("\n").slice(0, 40).join("\n").trim() : "";
}

function extractProps(content: string): string[] {
    const props: string[] = [];
    const declared = content.match(/(?:interface|type)\s+\w*Props\w*\s*(?:=\s*)?\{([^}]+)\}/);
    if (declared) for (const m of declared[1]!.matchAll(/(\w+)\s*[?:]?\s*:/g)) if (!props.includes(m[1]!)) props.push(m[1]!);
    const destructured = content.match(/\(\s*\{\s*([^}]+)\s*\}\s*(?::\s*\w+)?\s*\)/);
    if (destructured) {
        for (const part of destructured[1]!.split(",")) {
            const name = part.trim().split(/[\s=:]/)[0]!.trim();
            if (name && !props.includes(name) && /^[a-zA-Z]/.test(name)) props.push(name);
        }
    }
    return props;
}

function parseComponent(filePath: string, rootDir: string): ComponentInfo | null {
    let content: string;
    try {
        if (statSync(filePath).size > MAX_FILE_BYTES) return null;
        content = readFileSync(filePath, "utf8");
    } catch { return null; }

    let name = basename(filePath, extname(filePath));
    if (name.toLowerCase() === "index") {
        // `Button/index.tsx` is the Button component; a barrel in components/ is not a component.
        const dirName = basename(dirname(filePath));
        if (dirName === "components" || dirName === "ui" || dirName === "lib") return null;
        name = dirName;
    } else if (NON_COMPONENT_FILES.has(name.toLowerCase())) {
        return null;
    }

    const hasMarkup = /<[A-Z][a-zA-Z]*[\s/>]/.test(content) || /return\s*\(?\s*</.test(content);
    if (!hasMarkup && !/export\s+(default\s+)?/.test(content)) return null;

    const componentName = toPascalCase(name);
    const relPath = relative(rootDir, filePath).replace(/\\/g, "/");
    const cssClasses = extractClasses(content);
    return {
        name: componentName,
        filePath: relPath,
        variants: extractVariants(content),
        cssClasses,
        jsxSnippet: extractSnippet(content),
        props: extractProps(content),
        category: categorize(componentName, relPath, content, cssClasses),
        ...detectAnimations(content),
        statePatterns: detectStatePatterns(content),
        tailwindPatterns: tailwindPatternOf(cssClasses),
    };
}

function scan(dir: string, rootDir: string, seen: Set<string>, out: ComponentInfo[]): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (out.length >= MAX_COMPONENTS) return;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { scan(full, rootDir, seen, out); continue; }
        // Component folders overlap (`app` contains `app/components`); each file counts once.
        if (!entry.isFile() || seen.has(full) || !COMPONENT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
        seen.add(full);
        const component = parseComponent(full, rootDir);
        if (component) out.push(component);
    }
}

export function extractComponents(projectDir: string): ComponentInfo[] {
    const out: ComponentInfo[] = [];
    const seen = new Set<string>();
    for (const dir of COMPONENT_DIRS) {
        const full = join(projectDir, dir);
        try { if (statSync(full).isDirectory()) scan(full, projectDir, seen, out); } catch { /* absent */ }
    }
    return out;
}
