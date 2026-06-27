/**
 * Shared, side-effect-free helpers. Kept tiny and dependency-free so any module
 * can import them without pulling in heavier concerns.
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";

/** True if `pth` exists and is a directory. */
export function isDir(pth: string): boolean {
    try { return statSync(pth).isDirectory(); } catch { return false; }
}

/**
 * The home directory enigma anchors its config and managed agent dirs to.
 * ENIGMA_CONFIG_HOME overrides it - required because bun on Linux does not reflect
 * a runtime-reassigned $HOME via os.homedir(), so tests (and advanced users) cannot
 * rely on resetting $HOME. Both config.ts and agents.ts resolve home through here so
 * the config file and the agent skill/memory/command dirs never disagree.
 */
export function enigmaHome(): string {
    return process.env.ENIGMA_CONFIG_HOME || homedir();
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

/** Executable extensions to try for a bare name: PATHEXT on Windows, none elsewhere. */
function execExtensions(): string[] {
    return sep === "\\"
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
        : [""];
}

/**
 * First existing `bin` (with each executable extension) found under any of `dirs`,
 * or null. Cross-platform, no spawn - the directory-scoped core shared by resolveBin
 * (which searches PATH) and the off-PATH discovery in tool-path.ts.
 */
export function resolveBinIn(bin: string, dirs: string[]): string | null {
    for (const d of dirs) {
        for (const ext of execExtensions()) {
            const candidate = join(d, bin + ext);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * Resolve the full path of an executable named `bin` on the user's PATH, or null
 * if not found (cross-platform, no spawn). On Windows each PATHEXT extension is
 * tried in order so the real file (e.g. `claude.cmd`) is returned, which callers
 * need to spawn it correctly.
 */
export function resolveBin(bin: string): string | null {
    const dirs = (process.env.PATH || process.env.Path || "").split(sep === "\\" ? ";" : ":").filter(Boolean);
    return resolveBinIn(bin, dirs);
}

/** Is an executable named `bin` resolvable on the user's PATH? (cross-platform, no spawn) */
export function isOnPath(bin: string): boolean {
    return resolveBin(bin) !== null;
}

/** Split a version into [major, minor, patch], dropping a leading "v" and any prerelease tag. */
export function parseVersion(version: string): [number, number, number] {
    const core = String(version).trim().replace(/^v/, "").split("-")[0]!;
    const [major, minor, patch] = core.split(".").map((n) => parseInt(n, 10) || 0);
    return [major || 0, minor || 0, patch || 0];
}

/** True when `latest` is a strictly higher release than `current`. */
export function isNewer(latest: string, current: string): boolean {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    for (let i = 0; i < 3; i++) {
        if (a[i]! > b[i]!) return true;
        if (a[i]! < b[i]!) return false;
    }
    return false;
}

/** List file paths under `dir` relative to it, posix-normalized. */
export function listFilesRel(dir: string, base: string = dir): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (isDir(full)) out.push(...listFilesRel(full, base));
        else out.push(relative(base, full).split(sep).join("/"));
    }
    return out;
}

/** Deterministic sha256 over every file in a skill EXCEPT skill.json (which carries it). */
export function computeContentSha(dir: string): string {
    const files = listFilesRel(dir).filter((f) => f !== "skill.json").sort();
    const h = createHash("sha256");
    for (const f of files) {
        h.update(f); h.update("\0");
        h.update(readFileSync(join(dir, f))); h.update("\0");
    }
    return h.digest("hex");
}
