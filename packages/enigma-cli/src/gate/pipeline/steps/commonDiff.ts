/**
 * Diff/test-file helpers for pipeline steps: test-file detection, new-test-file
 * discovery via `git status --porcelain`, and gitignore-style filtering of a
 * unified diff. Faithful port of the no-mistakes
 * `internal/pipeline/steps/common_diff.go`.
 *
 * Go used `filepath.Match` for ignore-pattern globbing; that algorithm is ported
 * inline as `filepathMatch` (boolean-only, swallowing ErrBadPattern exactly as
 * the Go callers did with `matched, _ := filepath.Match(...)`). Path separators
 * follow the host OS, matching Go's `filepath.Separator`.
 */

import * as git from "../../git";
import { sep, basename } from "node:path";

/** OS path separator, matching Go's filepath.Separator. */
const SEPARATOR = process.platform === "win32" ? "\\" : "/";

/** Returns true if the file path matches common test-file naming patterns. */
export function isTestFile(path: string): boolean {
    const base = basename(path);
    if (base === "") return false;

    // Go: *_test.go
    if (base.endsWith("_test.go")) return true;
    // Rust: *_test.rs
    if (base.endsWith("_test.rs")) return true;
    // Python: test_*.py or *_test.py
    if (base.endsWith(".py")) {
        const name = base.slice(0, -".py".length);
        if (name.startsWith("test_") || name.endsWith("_test")) return true;
    }
    // Ruby: test_*.rb
    if (base.endsWith(".rb") && basename(path).startsWith("test_")) return true;
    // Java: *Test.java or *Tests.java
    if (base.endsWith("Test.java") || base.endsWith("Tests.java")) return true;
    // JS/TS: *.test.{js,ts,jsx,tsx} or *.spec.{js,ts,jsx,tsx}
    for (const ext of [".js", ".ts", ".jsx", ".tsx"]) {
        if (base.endsWith(`.test${ext}`) || base.endsWith(`.spec${ext}`)) return true;
    }
    return false;
}

/**
 * Returns paths of new (untracked or staged-new) files matching common test-file
 * naming patterns, using `git status --porcelain`.
 */
export async function detectNewTestFiles(signal: AbortSignal, dir: string): Promise<string[]> {
    let out: string;
    try {
        out = await git.run(dir, ["status", "--porcelain"], signal);
    } catch {
        return [];
    }
    if (out === "") return [];
    const testFiles: string[] = [];
    for (const line of out.split("\n")) {
        if (line.length < 4) continue;
        // Porcelain format: XY <path> where XY is a 2-char status code + space.
        const status = line.slice(0, 2);
        const path = line.slice(3).trim();
        // New files: untracked (??) or staged add (A ) or staged add + mods (AM).
        if (status === "??" || status[0] === "A") {
            if (isTestFile(path)) testFiles.push(path);
        }
    }
    return testFiles;
}

/**
 * Checks if a file path matches an ignore pattern with gitignore-like semantics:
 *   - No slash: match against filename only (e.g. "*.generated.go").
 *   - Ends with "/**": match any file under that directory (e.g. "vendor/**").
 *   - Otherwise: filepath.Match against the full path.
 */
export function matchIgnorePattern(path: string, pattern: string): boolean {
    // "vendor/**" matches anything under "vendor/".
    if (pattern.endsWith("/**")) {
        const prefix = pattern.slice(0, -"/**".length);
        return path === prefix || path.startsWith(`${prefix}/`);
    }
    // No slash in pattern -> match against basename only.
    if (!pattern.includes("/")) {
        return filepathMatch(pattern, basename(path));
    }
    // Full path match.
    return filepathMatch(pattern, path);
}

/**
 * Removes diff sections for files matching any ignore pattern. Input is a unified
 * diff; output is the same diff with matching file sections removed. Returns the
 * original diff unchanged when patterns is empty.
 */
export function filterDiff(diff: string, patterns: string[]): string {
    if (patterns.length === 0 || diff === "") return diff;

    const lines = diff.split("\n");
    const result: string[] = [];
    let skip = false;

    for (const line of lines) {
        // Detect the start of a new file section.
        if (line.startsWith("diff --git ")) {
            const path = extractDiffPath(line);
            skip = false;
            for (const p of patterns) {
                if (matchIgnorePattern(path, p)) {
                    skip = true;
                    break;
                }
            }
        }
        if (!skip) result.push(line);
    }

    return result.join("\n");
}

/**
 * Extracts the file path from a "diff --git a/<path> b/<path>" header. For
 * non-rename diffs both paths are identical, so the path length is derived from
 * the known structure rather than splitting on " b/" (which could appear in
 * filenames).
 */
export function extractDiffPath(diffLine: string): string {
    const prefix = "diff --git a/";
    if (!diffLine.startsWith(prefix)) return "";
    const rest = diffLine.slice(prefix.length);
    // Non-rename: rest is "<path> b/<path>" where both paths are equal.
    // Total length = 2*pathLen + len(" b/") = 2*pathLen + 3.
    const pathLen = Math.floor((rest.length - 3) / 2);
    if (pathLen > 0 && pathLen + 3 <= rest.length && rest.slice(pathLen, pathLen + 3) === " b/") {
        return rest.slice(0, pathLen);
    }
    // Fallback for renames or unexpected format: split on first " b/".
    const idx = rest.indexOf(" b/");
    if (idx >= 0) return rest.slice(idx + " b/".length);
    return "";
}

/**
 * Boolean port of Go's filepath.Match: `*` matches a non-separator run, `?` a
 * single non-separator rune, `[...]` a char class. A malformed pattern yields
 * false, mirroring how the callers discard the ErrBadPattern error.
 */
function filepathMatch(pattern: string, name: string): boolean {
    while (pattern.length > 0) {
        const [star, chunk, rest] = scanChunk(pattern);
        pattern = rest;
        if (star && chunk === "") {
            // Trailing * matches the rest of name unless it has a separator.
            return !name.includes(SEPARATOR);
        }
        const matched = matchChunk(chunk, name);
        if (matched.ok && (matched.rest.length === 0 || pattern.length > 0)) {
            name = matched.rest;
            continue;
        }
        if (matched.err) return false;
        if (star) {
            let advanced = false;
            for (let i = 0; i < name.length && name[i] !== SEPARATOR; i++) {
                const m = matchChunk(chunk, name.slice(i + 1));
                if (m.ok) {
                    if (pattern.length === 0 && m.rest.length > 0) continue;
                    name = m.rest;
                    advanced = true;
                    break;
                }
                if (m.err) return false;
            }
            if (advanced) continue;
        }
        return false;
    }
    return name.length === 0;
}

function scanChunk(pattern: string): [boolean, string, string] {
    let star = false;
    while (pattern.length > 0 && pattern[0] === "*") {
        pattern = pattern.slice(1);
        star = true;
    }
    let inrange = false;
    let i = 0;
    for (; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\") {
            if (process.platform !== "win32") {
                if (i + 1 < pattern.length) i++;
            }
        } else if (c === "[") {
            inrange = true;
        } else if (c === "]") {
            inrange = false;
        } else if (c === "*") {
            if (!inrange) break;
        }
    }
    return [star, pattern.slice(0, i), pattern.slice(i)];
}

interface ChunkMatch {
    rest: string;
    ok: boolean;
    err: boolean;
}

function matchChunk(chunk: string, s: string): ChunkMatch {
    let failed = false;
    while (chunk.length > 0) {
        if (!failed && s.length === 0) failed = true;
        const c = chunk[0];
        if (c === "[") {
            let r = "";
            if (!failed) {
                r = s[0];
                s = s.slice(1);
            }
            chunk = chunk.slice(1);
            let negated = false;
            if (chunk.length > 0 && chunk[0] === "^") {
                negated = true;
                chunk = chunk.slice(1);
            }
            let match = false;
            let nrange = 0;
            for (;;) {
                if (chunk.length > 0 && chunk[0] === "]" && nrange > 0) {
                    chunk = chunk.slice(1);
                    break;
                }
                const lo = getEsc(chunk);
                if (lo.err) return { rest: "", ok: false, err: true };
                let hiRune = lo.rune;
                chunk = lo.rest;
                if (chunk[0] === "-") {
                    const hi = getEsc(chunk.slice(1));
                    if (hi.err) return { rest: "", ok: false, err: true };
                    hiRune = hi.rune;
                    chunk = hi.rest;
                }
                if (lo.rune <= r && r <= hiRune) match = true;
                nrange++;
            }
            if (match === negated) failed = true;
        } else if (c === "?") {
            if (!failed) {
                if (s[0] === SEPARATOR) failed = true;
                s = s.slice(1);
            }
            chunk = chunk.slice(1);
        } else if (c === "\\" && process.platform !== "win32") {
            chunk = chunk.slice(1);
            if (chunk.length === 0) return { rest: "", ok: false, err: true };
            if (!failed) {
                if (chunk[0] !== s[0]) failed = true;
                s = s.slice(1);
            }
            chunk = chunk.slice(1);
        } else {
            if (!failed) {
                if (chunk[0] !== s[0]) failed = true;
                s = s.slice(1);
            }
            chunk = chunk.slice(1);
        }
    }
    if (failed) return { rest: "", ok: false, err: false };
    return { rest: s, ok: true, err: false };
}

interface EscResult {
    rune: string;
    rest: string;
    err: boolean;
}

function getEsc(chunk: string): EscResult {
    if (chunk.length === 0 || chunk[0] === "-" || chunk[0] === "]") {
        return { rune: "", rest: chunk, err: true };
    }
    if (chunk[0] === "\\" && process.platform !== "win32") {
        chunk = chunk.slice(1);
        if (chunk.length === 0) return { rune: "", rest: chunk, err: true };
    }
    const rune = chunk[0];
    const rest = chunk.slice(1);
    if (rest.length === 0) return { rune, rest, err: true };
    return { rune, rest, err: false };
}
