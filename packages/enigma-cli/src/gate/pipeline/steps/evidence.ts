/**
 * Resolves where the test step writes evidence artifacts. By default (opt-out)
 * evidence lives in a temporary directory keyed by run ID and is referenced only
 * by local path; opting in to store-in-repo lands it under a readable,
 * branch-named directory inside the worktree so it is committed, pushed, and
 * rendered on the PR. Path safety rejects absolute/escaping/symlinked targets and
 * falls back to the temporary location. Faithful port of the upstream
 * `internal/pipeline/steps/evidence.go`.
 *
 * The temp-dir base is rebranded `enigma-gate-evidence` to match the gate's
 * agent-steering prompt, which tells agents that is the only allowed
 * out-of-worktree write location.
 */

import { tmpdir } from "node:os";
import { lstatSync } from "node:fs";
import type { Evidence } from "../../config";
import { join, sep, isAbsolute, normalize } from "node:path";

export function testEvidenceRoot(): string {
    return join(tmpdir(), "enigma-gate-evidence");
}

export function testEvidenceDir(runID: string): string {
    return join(testEvidenceRoot(), runID);
}

/** Picks where the test step writes evidence artifacts (directory only). */
export function resolveTestEvidenceDir(workDir: string, branch: string, runID: string, ev: Evidence): string {
    return resolveTestEvidenceLocation(workDir, branch, runID, ev).dir;
}

/** The resolved evidence directory plus whether it lives inside the repo. */
export interface TestEvidenceLocation {
    dir: string;
    storeInRepo: boolean;
}

export function resolveTestEvidenceLocation(
    workDir: string,
    branch: string,
    runID: string,
    ev: Evidence
): TestEvidenceLocation {
    if (!ev.storeInRepo) {
        return { dir: testEvidenceDir(runID), storeInRepo: false };
    }
    const [sub, ok] = safeRepoSubdir(ev.dir);
    if (!ok) {
        return { dir: testEvidenceDir(runID), storeInRepo: false };
    }
    let segments = evidenceBranchSlug(branch);
    if (segments.length === 0) segments = [runID];
    const relParts = [sub, ...segments];
    const rel = join(...relParts);
    if (repoPathHasSymlink(workDir, rel)) {
        return { dir: testEvidenceDir(runID), storeInRepo: false };
    }
    const parts = [workDir, ...relParts];
    return { dir: join(...parts), storeInRepo: true };
}

function repoPathHasSymlink(workDir: string, rel: string): boolean {
    const clean = normalize(rel);
    if (clean === "." || clean === ".." || clean.startsWith(`..${sep}`) || isAbsolute(clean)) {
        return true;
    }
    let current = workDir;
    for (const part of clean.split(sep)) {
        current = join(current, part);
        let info;
        try {
            info = lstatSync(current);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
            return true;
        }
        if (info.isSymbolicLink()) return true;
    }
    return false;
}

/**
 * Validates a configured evidence directory as a relative path that stays inside
 * the repo worktree. Returns the cleaned, OS-native path and false when the
 * directory is empty, absolute, or escapes the worktree.
 */
export function safeRepoSubdir(dir: string): [string, boolean] {
    dir = dir.trim();
    if (dir === "" || isAbsolute(dir) || hasPathRootPrefix(dir) || hasWindowsDrivePrefix(dir)) {
        return ["", false];
    }
    const clean = normalize(fromSlash(dir));
    if (clean === "." || clean === ".." || clean.startsWith(`..${sep}`)) {
        return ["", false];
    }
    const sepIdx = clean.indexOf(sep);
    const first = sepIdx === -1 ? clean : clean.slice(0, sepIdx);
    if (first.toLowerCase() === ".git") return ["", false];
    return [clean, true];
}

function hasPathRootPrefix(path: string): boolean {
    return path.startsWith("/") || path.startsWith("\\");
}

function hasWindowsDrivePrefix(path: string): boolean {
    if (path.length < 2 || path[1] !== ":") return false;
    const c = path.charCodeAt(0);
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Converts forward slashes to the OS separator (filepath.FromSlash). */
function fromSlash(path: string): string {
    return process.platform === "win32" ? path.split("/").join("\\") : path;
}

/**
 * Turns a branch name into readable, filesystem-safe path segments. Branch
 * separators become nested directories; unsafe characters become dashes and
 * traversal segments are dropped.
 */
export function evidenceBranchSlug(branch: string): string[] {
    const segments: string[] = [];
    for (const raw of branch.split("/")) {
        const seg = sanitizeEvidenceSegment(raw);
        if (seg === "" || seg === "." || seg === "..") continue;
        segments.push(seg);
    }
    return segments;
}

/**
 * Keeps alphanumerics, dash, underscore, and dot, replacing every other rune
 * with a dash, then collapses dash runs and trims leading/trailing dashes.
 */
function sanitizeEvidenceSegment(s: string): string {
    s = s.trim();
    let b = "";
    for (const r of s) {
        if (
            (r >= "a" && r <= "z") ||
            (r >= "A" && r <= "Z") ||
            (r >= "0" && r <= "9") ||
            r === "-" ||
            r === "_" ||
            r === "."
        ) {
            b += r;
        } else {
            b += "-";
        }
    }
    let out = b;
    while (out.includes("--")) out = out.split("--").join("-");
    return trimDash(out);
}

function trimDash(s: string): string {
    let start = 0;
    let end = s.length;
    while (start < end && s[start] === "-") start++;
    while (end > start && s[end - 1] === "-") end--;
    return s.slice(start, end);
}
