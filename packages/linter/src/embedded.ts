/**
 * Embedded-source extraction for container formats. Each extractor returns the code regions of a
 * file as EmbeddedBlocks whose lines map back to the physical file, so the engine can lint the
 * embedded code as its real language without ever feeding the wrapper (JSON, HTML) to the rules.
 */

import { extname } from "node:path";
import { extractNotebookBlocks } from "./notebook";
import { lineOf, computeLineStarts } from "./lines";
import type { Language, EmbeddedBlock } from "./types";

/** The code blocks embedded in a container file, or [] when it has none. */
export function extractEmbedded(file: string, text: string): EmbeddedBlock[] {
    switch (extname(file).toLowerCase()) {
        case ".ipynb": return extractNotebookBlocks(text);
        case ".astro": return extractAstroBlocks(text);
        case ".vue": case ".svelte": return extractScriptBlocks(text);
        default: return [];
    }
}

/** Build a block for a contiguous region whose first character is at `innerStart` in `text`. */
function contiguousBlock(language: Language, inner: string, innerStart: number, lineStarts: number[]): EmbeddedBlock {
    const startLine = lineOf(innerStart, lineStarts);
    const lineMap = inner.split("\n").map((_, i) => startLine + i);
    return { language, text: inner, lineMap };
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Every `<script>...</script>` block in an HTML-like SFC, typed by its `lang` attribute.
 *
 * `fallback` is what a block with no `lang` is, and it is a per-format answer rather than a
 * constant - see the Astro note below.
 */
function extractScriptBlocks(text: string, fallback: Language = "js"): EmbeddedBlock[] {
    const lineStarts = computeLineStarts(text);
    const blocks: EmbeddedBlock[] = [];
    SCRIPT.lastIndex = 0;
    for (let match = SCRIPT.exec(text); match; match = SCRIPT.exec(text)) {
        const [whole, attrs, inner] = match;
        if (!inner || !inner.trim()) continue;
        const innerStart = match.index + whole.indexOf(">") + 1;
        blocks.push(contiguousBlock(scriptLanguage(attrs ?? "", fallback), inner, innerStart, lineStarts));
    }
    return blocks;
}

/**
 * Astro files: the leading `---` frontmatter plus any `<script>` blocks, all TypeScript.
 *
 * A bare `<script>` IS TypeScript here, which is where this differs from .vue and .svelte:
 * Astro compiles the block whether or not it carries `lang="ts"`, so requiring the attribute
 * would be requiring something the format does not ask for and nobody writes.
 *
 * Read as JavaScript, a type annotation is a syntax error that the parser recovers from
 * SILENTLY and wrongly: in `new Map<string, number>()` the angle brackets become comparison
 * operators, the statement ends at the comma, and `require-semicolons` reports a missing
 * semicolon on a line that has one. A single type argument happens to recover intact, which
 * is why this survived - the defect needs a comma inside the brackets to show itself.
 */
function extractAstroBlocks(text: string): EmbeddedBlock[] {
    const lineStarts = computeLineStarts(text);
    const blocks: EmbeddedBlock[] = [];
    const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (frontmatter && frontmatter[1]!.trim()) {
        const innerStart = frontmatter.index + frontmatter[0].indexOf("\n") + 1;
        blocks.push(contiguousBlock("ts", frontmatter[1]!, innerStart, lineStarts));
    }
    blocks.push(...extractScriptBlocks(text, "ts"));
    return blocks;
}

/** The language of a `<script>` block from its `lang` attribute, or the format's default. */
function scriptLanguage(attrs: string, fallback: Language): Language {
    const match = /lang\s*=\s*["']?(ts|typescript|js|javascript)/i.exec(attrs);
    if (!match) return fallback;
    return /^t/i.test(match[1]!) ? "ts" : "js";
}
