/**
 * Shared, side-effect-free helpers. Kept tiny and dependency-free so any module
 * can import them without pulling in heavier concerns.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/** True if `pth` exists and is a directory. */
export function isDir(pth: string): boolean {
    try { return statSync(pth).isDirectory(); } catch { return false; }
}

/**
 * Parse a JSON file, returning null on any error. Strips a leading UTF-8 BOM
 * (common in Windows-edited files) so a valid-but-BOM-prefixed config is not
 * mistaken for unreadable - callers merge into the parsed object, so a false
 * null would clobber the user's existing settings.
 */
export function readJson<T = Record<string, unknown>>(file: string): T | null {
    try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T; } catch { return null; }
}

/**
 * Resolve the full path of an executable named `bin` on the user's PATH, or null
 * if not found (cross-platform, no spawn). On Windows each PATHEXT extension is
 * tried in order so the real file (e.g. `claude.cmd`) is returned, which callers
 * need to spawn it correctly.
 */
export function resolveBin(bin: string): string | null {
    const dirs = (process.env.PATH || process.env.Path || "").split(sep === "\\" ? ";" : ":").filter(Boolean);
    const exts = sep === "\\"
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
        : [""];
    for (const d of dirs) {
        for (const ext of exts) {
            const candidate = join(d, bin + ext);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/** Is an executable named `bin` resolvable on the user's PATH? (cross-platform, no spawn) */
export function isOnPath(bin: string): boolean {
    return resolveBin(bin) !== null;
}
