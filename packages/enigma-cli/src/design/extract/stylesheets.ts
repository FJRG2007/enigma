/**
 * Every stylesheet in a local project, folded into one RawTokens: CSS, SCSS and LESS
 * files, plus the `<style>` blocks of HTML, Vue, Svelte and Astro files, where a
 * component-based project keeps most of its CSS.
 */

import { join } from "node:path";
import type { RawTokens } from "../types";
import { emptyRawTokens } from "../raw-tokens";
import { extractCssTokens } from "./css-tokens";
import { readdirSync, readFileSync, statSync } from "node:fs";

const STYLE_EXTENSIONS = [".css", ".scss", ".less"];
const MARKUP_EXTENSIONS = [".html", ".htm", ".vue", ".svelte", ".astro"];
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output", ".svelte-kit", ".astro", "coverage", ".turbo", ".cache", "vendor"]);
const MAX_DEPTH = 6;
/** Bigger than any hand-written stylesheet; past it the file is a build artifact. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;

function hasExtension(name: string, list: string[]): boolean {
    return list.some((ext) => name.endsWith(ext));
}

export function findStyleSources(dir: string, depth = 0, out: string[] = []): string[] {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (out.length >= MAX_FILES) break;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) findStyleSources(full, depth + 1, out);
        else if (entry.isFile() && (hasExtension(entry.name, STYLE_EXTENSIONS) || hasExtension(entry.name, MARKUP_EXTENSIONS))) out.push(full);
    }
    return out;
}

/** The CSS inside a markup file's `<style>` blocks, with whether each is SCSS/LESS. */
function styleBlocks(markup: string): Array<{ css: string; preprocessed: boolean; }> {
    return [...markup.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)].map((m) => ({
        css: m[2]!,
        preprocessed: /\blang\s*=\s*["']?(scss|sass|less|stylus)/i.test(m[1]!),
    }));
}

export function extractStylesheetTokens(projectDir: string): RawTokens {
    const tokens = emptyRawTokens();
    for (const file of findStyleSources(projectDir)) {
        try {
            if (statSync(file).size > MAX_FILE_BYTES) continue;
            const content = readFileSync(file, "utf8");
            if (hasExtension(file, MARKUP_EXTENSIONS)) {
                for (const block of styleBlocks(content)) extractCssTokens(block.css, tokens, { lineComments: block.preprocessed });
            } else {
                extractCssTokens(content, tokens, { lineComments: !file.endsWith(".css") });
            }
        } catch { /* unreadable file */ }
    }
    return tokens;
}
