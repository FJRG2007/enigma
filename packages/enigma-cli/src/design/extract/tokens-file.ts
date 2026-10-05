/**
 * Tokens from design-token files (`tokens.json`, `theme.ts`, `design-tokens.js`, ...),
 * in plain nested form or the Design Tokens Community Group `{ value, type }` form.
 * JS/TS modules are read statically, never executed (see object-literal.ts); when even
 * that finds nothing, a text scan picks up hex colors and well-known font names.
 */

import { join, extname } from "node:path";
import type { RawTokens } from "../types";
import { emptyRawTokens } from "../raw-tokens";
import { existsSync, readFileSync } from "node:fs";
import { isColorLiteral, normalizeHex, tryParseColor } from "../color";
import { readExportedObject, readTopLevelLiterals, type LiteralValue } from "../object-literal";

const FILE_NAMES = [
    "tokens.json", "design-tokens.json", "theme.json", "theme.ts", "theme.js",
    "tokens.ts", "tokens.js", "design-tokens.ts", "design-tokens.js",
];
const DIRS = ["", "src", "src/styles", "src/theme", "styles", "theme", "config"];
const KNOWN_FONTS = /['"]?(Inter|Roboto|Helvetica|Arial|Poppins|Montserrat|Open Sans|Lato|Nunito|Source Sans|JetBrains Mono|Fira Code|SF Mono|Menlo|Consolas)['"]?/gi;

function colorHex(value: string): string | null {
    return value.startsWith("#") ? normalizeHex(value) : tryParseColor(value);
}

function leafName(key: string): string {
    return key.split(".").pop() || key;
}

function classifyValue(key: string, value: string, tokens: RawTokens): void {
    const lower = key.toLowerCase();
    if (isColorLiteral(value)) {
        const hex = colorHex(value);
        if (hex) tokens.colors.push({ value: hex, frequency: 1, source: "tokens-file", name: leafName(key) });
        return;
    }
    if (lower.includes("font") || lower.includes("family") || lower.includes("typeface")) {
        tokens.fonts.push({ family: value, source: "tokens-file" });
        return;
    }
    if (lower.includes("shadow") || lower.includes("elevation")) {
        tokens.shadows.push({ value, name: leafName(key) });
        return;
    }
    const px = value.match(/^(\d+(?:\.\d+)?)\s*(px|rem|em)?$/);
    if (px && /spacing|space|gap|size/.test(lower)) {
        let n = parseFloat(px[1]!);
        if (px[2] === "rem" || px[2] === "em") n *= 16;
        if (n > 0 && n <= 200) tokens.spacingValues.push(Math.round(n));
    }
}

function classifyTokenValue(key: string, value: string, type: string, tokens: RawTokens): void {
    const t = type.toLowerCase();
    if (t === "color" || isColorLiteral(value)) {
        const hex = colorHex(value);
        if (hex) tokens.colors.push({ value: hex, frequency: 1, source: "tokens-file", name: leafName(key) });
    } else if (t === "fontfamily" || t === "fontfamilies") {
        tokens.fonts.push({ family: value, source: "tokens-file" });
    } else if (t === "fontsize" || t === "fontsizes") {
        tokens.fonts.push({ family: "", size: value, source: "tokens-file" });
    } else if (t === "spacing" || t === "dimension") {
        const n = parseFloat(value);
        if (!isNaN(n) && n > 0) tokens.spacingValues.push(value.includes("rem") ? Math.round(n * 16) : n);
    } else if (t === "boxshadow" || t === "shadow") {
        tokens.shadows.push({ value, name: leafName(key) });
    } else {
        classifyValue(key, value, tokens);
    }
}

function walk(obj: Record<string, LiteralValue>, prefix: string, tokens: RawTokens): void {
    for (const [key, value] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "string") {
            classifyValue(full, value, tokens);
        } else if (typeof value === "number") {
            if (value > 0 && value <= 200) tokens.spacingValues.push(value);
        } else if (Array.isArray(value)) {
            if (key.toLowerCase().includes("font") && value.length && value.every((v) => typeof v === "string")) {
                tokens.fonts.push({ family: value[0] as string, source: "tokens-file" });
            }
        } else if (value && typeof value === "object") {
            // DTCG: `{ value, type }` (or `$value`, `$type`) is one token, not a group.
            const tokenValue = value.value ?? value.$value;
            if (typeof tokenValue === "string") classifyTokenValue(full, tokenValue, String(value.type ?? value.$type ?? ""), tokens);
            else walk(value, full, tokens);
        }
    }
}

function extractFromFile(path: string, tokens: RawTokens): void {
    const content = readFileSync(path, "utf8");
    if (extname(path) === ".json") {
        const parsed: unknown = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) walk(parsed as Record<string, LiteralValue>, "", tokens);
        return;
    }
    const exported = readExportedObject(content);
    const named = exported ? null : readTopLevelLiterals(content);
    const data = exported ?? named;
    if (data && Object.keys(data).length) { walk(data, "", tokens); return; }
    for (const m of content.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) tokens.colors.push({ value: normalizeHex(m[0]), frequency: 1, source: "tokens-file" });
    for (const m of content.matchAll(KNOWN_FONTS)) tokens.fonts.push({ family: m[1]!, source: "tokens-file" });
}

export function extractTokenFiles(projectDir: string): RawTokens {
    const tokens = emptyRawTokens();
    for (const dir of DIRS) {
        for (const name of FILE_NAMES) {
            const path = join(projectDir, dir, name);
            if (!existsSync(path)) continue;
            try { extractFromFile(path, tokens); } catch { /* unreadable or malformed file */ }
        }
    }
    return tokens;
}
