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

/** File extensions the linter will discover and lint. */
export const SOURCE_EXTENSIONS = new Set(Object.keys(EXTENSION_LANGUAGE));

/** The language for a file path, or null when its extension is not lintable. */
export function languageFor(file: string): Language | null {
    return EXTENSION_LANGUAGE[extname(file).toLowerCase()] ?? null;
}
