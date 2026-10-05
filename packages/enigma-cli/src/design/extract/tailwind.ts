/**
 * Tokens from a Tailwind config (v3 `tailwind.config.*`), read statically - the config
 * is never executed (see object-literal.ts). Theme values and `theme.extend` merge the
 * way Tailwind merges them; anything the static reader cannot resolve falls back to
 * Tailwind's defaults, plus a text scan of the `fontFamily` block for the font names.
 */

import { join } from "node:path";
import { emptyRawTokens } from "../raw-tokens";
import { existsSync, readFileSync } from "node:fs";
import type { Breakpoint, RawTokens } from "../types";
import { isColorLiteral, normalizeHex, tryParseColor } from "../color";
import { readExportedObject, type LiteralValue } from "../object-literal";

const CONFIG_FILES = ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs", "tailwind.config.cjs"];

/** Tailwind's default spacing scale in px (rem x 16). */
const DEFAULT_SPACING_PX = [1, 2, 4, 5, 6, 7, 8, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96];

const DEFAULT_BREAKPOINTS: Breakpoint[] = [
    { name: "sm", value: "640px", source: "tailwind" },
    { name: "md", value: "768px", source: "tailwind" },
    { name: "lg", value: "1024px", source: "tailwind" },
    { name: "xl", value: "1280px", source: "tailwind" },
    { name: "2xl", value: "1536px", source: "tailwind" },
];

/** Readable names for the font keys configs commonly use. */
const KNOWN_FONT_KEYS: Record<string, string> = {
    sans: "Sans-serif", serif: "Serif", mono: "Monospace", display: "Display", body: "Body",
    exo2: "Exo 2", exo: "Exo", inter: "Inter", roboto: "Roboto", poppins: "Poppins",
    montserrat: "Montserrat", lato: "Lato", nunito: "Nunito", jetbrains: "JetBrains Mono",
    "fira-code": "Fira Code", "source-code": "Source Code Pro", "space-grotesk": "Space Grotesk",
    "space-mono": "Space Mono", doto: "Doto", geist: "Geist", "geist-mono": "Geist Mono",
    outfit: "Outfit", manrope: "Manrope", "dm-sans": "DM Sans", "dm-mono": "DM Mono", sora: "Sora",
    "ibm-plex": "IBM Plex Sans", "ibm-plex-mono": "IBM Plex Mono", raleway: "Raleway",
    "open-sans": "Open Sans", "source-sans": "Source Sans Pro", ubuntu: "Ubuntu",
    "ubuntu-mono": "Ubuntu Mono", barlow: "Barlow", overpass: "Overpass", rubik: "Rubik",
    karla: "Karla", cabin: "Cabin", mulish: "Mulish",
};

type Obj = Record<string, LiteralValue>;

function isObj(value: LiteralValue | undefined): value is Obj {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(a: Obj, b: Obj): Obj {
    const out: Obj = { ...a };
    for (const [key, value] of Object.entries(b)) {
        const prev = out[key];
        out[key] = isObj(prev) && isObj(value) ? mergeDeep(prev, value) : value;
    }
    return out;
}

/** `exo2` -> `Exo 2`, `jetbrains` -> `JetBrains Mono`: a font key as the family it names. */
export function configKeyToFontName(key: string): string {
    const known = KNOWN_FONT_KEYS[key.toLowerCase().replace(/_/g, "-")];
    if (known) return known;
    return key
        .replace(/[-_]/g, " ")
        .replace(/([a-z])(\d)/g, "$1 $2")
        .replace(/(\d)([a-z])/g, "$1 $2")
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

/** A functional key (`sans`, `heading`) rather than a typeface name. */
function isGenericConfigKey(key: string): boolean {
    return /^(sans|serif|mono|heading|body|display|code|ui)$/i.test(key);
}

function resolveFontName(primary: string, key: string): string {
    if (!primary.startsWith("var(") && !primary.startsWith("--")) return primary.replace(/["']/g, "").trim();
    return configKeyToFontName(key);
}

function flattenColors(obj: Obj, prefix: string, out: RawTokens["colors"]): void {
    for (const [key, value] of Object.entries(obj)) {
        const name = key === "DEFAULT" && prefix ? prefix : prefix ? `${prefix}-${key}` : key;
        if (typeof value === "string" && isColorLiteral(value)) {
            const hex = value.startsWith("#") ? normalizeHex(value) : tryParseColor(value);
            if (hex) out.push({ value: hex, frequency: 1, source: "tailwind", name });
        } else if (isObj(value)) {
            flattenColors(value, name, out);
        }
    }
}

export function findTailwindConfig(dir: string): string | null {
    for (const file of CONFIG_FILES) if (existsSync(join(dir, file))) return join(dir, file);
    return null;
}

/** Font names from the raw text of a `fontFamily: { ... }` block. */
function fontsFromConfigText(content: string, tokens: RawTokens): void {
    const block = content.match(/fontFamily\s*:\s*\{([^}]+)\}/s)?.[1];
    if (!block) return;
    for (const entry of block.matchAll(/(\w[\w-]*)\s*:\s*\[([^\]]+)\]/g)) {
        const key = entry[1]!;
        const list = entry[2]!;
        const varMatch = list.match(/var\(--font-(\w[\w-]*)\)/);
        if (varMatch) {
            const resolved = configKeyToFontName(varMatch[1]!);
            if (!isGenericConfigKey(key) && !tokens.fonts.some((f) => f.family === resolved)) tokens.fonts.push({ family: resolved, source: "tailwind" });
            tokens.fontVarMap[`var(--font-${varMatch[1]})`] = resolved;
            tokens.fontVarMap[key] = resolved;
            continue;
        }
        const nameMatch = list.match(/["']([^"']+)["']/);
        if (nameMatch && !/^(sans-serif|serif|monospace|system-ui|ui-|inherit)/.test(nameMatch[1]!)) {
            if (!tokens.fonts.some((f) => f.family === nameMatch[1])) tokens.fonts.push({ family: nameMatch[1]!, source: "tailwind" });
            tokens.fontVarMap[key] = nameMatch[1]!;
        }
    }
}

export function extractTailwindTokens(projectDir: string): RawTokens {
    const tokens = emptyRawTokens();
    const configPath = findTailwindConfig(projectDir);
    if (!configPath) return tokens;

    let content = "";
    try { content = readFileSync(configPath, "utf8"); } catch { return tokens; }
    const config = readExportedObject(content);
    const theme = isObj(config?.theme) ? config!.theme as Obj : {};
    const extend = isObj(theme.extend) ? theme.extend : {};
    const section = (key: string): Obj => mergeDeep(isObj(theme[key]) ? theme[key] as Obj : {}, isObj(extend[key]) ? extend[key] as Obj : {});

    flattenColors(section("colors"), "", tokens.colors);

    const fontFamilies = section("fontFamily");
    for (const [key, value] of Object.entries(fontFamilies)) {
        // A stack, a single name, or the tuple form `[["Inter", "sans-serif"], { ...settings }]`.
        const first = Array.isArray(value) ? value[0] : value;
        const primary = typeof first === "string" ? first : Array.isArray(first) && typeof first[0] === "string" ? first[0] : null;
        if (!primary) continue;
        const resolved = resolveFontName(primary, key);
        if (!isGenericConfigKey(key) && !tokens.fonts.some((f) => f.family === resolved)) tokens.fonts.push({ family: resolved, source: "tailwind" });
        tokens.fontVarMap[`var(--font-${key})`] = resolved;
        tokens.fontVarMap[key] = resolved;
    }
    // Font stacks built from spreads or imports are invisible to the static reader.
    if (Object.keys(fontFamilies).length === 0) fontsFromConfigText(content, tokens);

    for (const value of Object.values(section("spacing"))) {
        const num = parseFloat(String(value));
        if (!isNaN(num) && num > 0) tokens.spacingValues.push(Math.round(String(value).includes("rem") ? num * 16 : num));
    }
    tokens.spacingValues.push(...DEFAULT_SPACING_PX);

    for (const value of Object.values(section("borderRadius"))) if (typeof value === "string") tokens.borderRadii.push(value);
    for (const [name, value] of Object.entries(section("boxShadow"))) if (typeof value === "string") tokens.shadows.push({ value, name });

    for (const [name, value] of Object.entries(section("screens"))) {
        const min = isObj(value) && typeof value.min === "string" ? value.min : null;
        if (typeof value === "string" || min) tokens.breakpoints.push({ name, value: min ?? String(value), source: "tailwind" });
    }
    if (tokens.breakpoints.length === 0) tokens.breakpoints = DEFAULT_BREAKPOINTS.map((b) => ({ ...b }));
    return tokens;
}
