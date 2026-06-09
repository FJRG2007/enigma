/** File discovery: walk paths and collect lintable source files. */

import { join, extname } from "node:path";
import { statSync, readdirSync } from "node:fs";
import { SOURCE_EXTENSIONS } from "./languages";

const SKIP_DIR = new Set([
    "node_modules", "dist", "build", "out", "coverage", "target",
    ".next", ".nuxt", ".svelte-kit", ".turbo", ".git",
    "__pycache__", ".venv", "venv", ".mypy_cache", ".ruff_cache",
]);

/** Recursively collect lintable source files under the given paths. */
export function discoverFiles(paths: string[]): string[] {
    const found: string[] = [];
    for (const path of paths) walk(path, found);
    return found;
}

function walk(path: string, out: string[]): void {
    let stat;
    try { stat = statSync(path); } catch { return; }
    if (stat.isDirectory()) {
        for (const entry of readdirSync(path)) {
            if (SKIP_DIR.has(entry)) continue;
            walk(join(path, entry), out);
        }
    } else if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
        out.push(path);
    }
}
