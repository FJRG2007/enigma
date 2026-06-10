/** Language detection: map a file extension to the language the engine should lint it as. */

import { extname } from "node:path";
import type { Language } from "./types";

const EXTENSION_LANGUAGE: Record<string, Language> = {
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
    ".py": "python", ".pyi": "python",
    ".rs": "rust",
    ".prisma": "prisma",
};

/** Languages parsed with the TypeScript compiler API (the only ones with a `sourceFile`). */
export const JS_TS: Language[] = ["ts", "js"];

/** Every language the linter understands. Text-based rules target all of these. */
export const ALL_LANGUAGES: Language[] = ["ts", "js", "python", "rust", "prisma"];

/**
 * Container formats: not a single language, but a wrapper that embeds source of a known language
 * in specific regions (Jupyter cells, SFC `<script>` blocks, Astro frontmatter). They are routed
 * through the embedded-source extractor instead of `languageFor`.
 */
export const CONTAINER_EXTENSIONS = new Set([".ipynb", ".astro", ".vue", ".svelte"]);

/** File extensions the linter will discover and lint (direct languages plus container formats). */
export const SOURCE_EXTENSIONS = new Set([...Object.keys(EXTENSION_LANGUAGE), ...CONTAINER_EXTENSIONS]);

/** The language for a file path, or null when its extension is not a direct (non-container) language. */
export function languageFor(file: string): Language | null {
    return EXTENSION_LANGUAGE[extname(file).toLowerCase()] ?? null;
}

/** Whether a file is a container format whose embedded source must be extracted before linting. */
export function isContainer(file: string): boolean {
    return CONTAINER_EXTENSIONS.has(extname(file).toLowerCase());
}
