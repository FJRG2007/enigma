/**
 * Faithful port of no-mistakes' `internal/intent/paths.go`: home resolution,
 * path canonicalization, and the git-aware repo matcher that decides whether a
 * candidate session's cwd belongs to the same repository as the change.
 *
 * Go threaded `context.Context` into the git calls; here every git call takes
 * an optional trailing `AbortSignal`. `newRepoMatcher` is async (Go computed
 * the origin identity eagerly in its constructor via a blocking git call).
 */

import { homedir } from "node:os";
import * as gitGate from "../git";
import { realpathSync } from "node:fs";
import { resolve, normalize, isAbsolute, join } from "node:path";

/**
 * Returns the home directory to use, preferring an explicit override (used in
 * tests) over the OS-reported value.
 */
export function resolveHome(override: string): string {
    if (override !== "") {
        return override;
    }
    return homedir();
}

/**
 * Returns the path with symlinks evaluated and cleaned. It silently falls back
 * to normalize(abs) if realpath fails (e.g. the path does not exist), since
 * both sides of the comparison receive the same fallback treatment.
 */
export function canonicalPath(p: string): string {
    if (p === "") {
        return "";
    }
    let abs: string;
    try {
        abs = resolve(p);
    } catch {
        abs = p;
    }
    try {
        return realpathSync(abs);
    } catch {
        return normalize(abs);
    }
}

/** Compares two paths after canonicalization. */
export function pathsEqual(a: string, b: string): boolean {
    return canonicalPath(a) === canonicalPath(b);
}

/** A repository's stable identity used to match sessions across worktrees. */
export interface RepoIdentity {
    canonical: string;
    commonDir: string;
    remote: string;
}

/** Decides whether a candidate cwd shares a repository with the origin cwd. */
export class RepoMatcher {
    origin: string;
    ids: Map<string, RepoIdentity>;

    constructor(origin: string) {
        this.origin = origin;
        this.ids = new Map();
    }

    async matches(cwd: string, signal?: AbortSignal): Promise<boolean> {
        if (this.origin === "") {
            return true;
        }
        const candidate = canonicalPath(cwd);
        if (candidate === "") {
            return false;
        }
        if (candidate === this.origin) {
            return true;
        }
        const origin = this.ids.get(this.origin) as RepoIdentity;
        let candidateID = this.ids.get(candidate);
        if (!candidateID) {
            candidateID = await gitRepoIdentity(cwd, signal);
            this.ids.set(candidate, candidateID);
        }
        if (origin.commonDir !== "" && candidateID.commonDir !== "" && origin.commonDir === candidateID.commonDir) {
            return true;
        }
        return origin.remote !== "" && candidateID.remote !== "" && origin.remote === candidateID.remote;
    }
}

/** Builds a RepoMatcher, eagerly resolving the origin repo identity. */
export async function newRepoMatcher(originCwd: string, signal?: AbortSignal): Promise<RepoMatcher> {
    const m = new RepoMatcher(canonicalPath(originCwd));
    if (m.origin !== "") {
        m.ids.set(m.origin, await gitRepoIdentity(originCwd, signal));
    }
    return m;
}

/** Resolves a directory's git common-dir and normalized origin remote. */
export async function gitRepoIdentity(dir: string, signal?: AbortSignal): Promise<RepoIdentity> {
    const id: RepoIdentity = { canonical: canonicalPath(dir), commonDir: "", remote: "" };
    if (id.canonical === "") {
        return id;
    }
    const commonDir = await gitOutput(dir, ["rev-parse", "--git-common-dir"], signal);
    if (commonDir !== "") {
        let resolved = commonDir;
        if (!isAbsolute(resolved)) {
            resolved = join(dir, resolved);
        }
        id.commonDir = canonicalPath(resolved);
    }
    let remote = await gitOutput(dir, ["remote", "get-url", "origin"], signal);
    if (remote === "") {
        const first = firstLine(await gitOutput(dir, ["remote"], signal));
        if (first !== "") {
            remote = await gitOutput(dir, ["remote", "get-url", first], signal);
        }
    }
    id.remote = normalizeGitRemote(remote);
    return id;
}

/** Runs a git command in `dir`, returning trimmed stdout or "" on any error. */
async function gitOutput(dir: string, args: string[], signal?: AbortSignal): Promise<string> {
    try {
        return await gitGate.run(dir, args, signal);
    } catch {
        return "";
    }
}

/** Normalizes a git remote URL to a `host/path` identity for comparison. */
export function normalizeGitRemote(remote: string): string {
    remote = remote.trim();
    if (remote === "") {
        return "";
    }
    try {
        const u = new URL(remote);
        if (u.host !== "") {
            return cleanRemoteParts(u.host, u.pathname);
        }
    } catch {
        // Not a standard URL; fall through to scp-like and path handling.
    }
    const at = remote.indexOf("@");
    if (at >= 0) {
        const rest = remote.slice(at + 1);
        const colon = rest.indexOf(":");
        if (colon >= 0) {
            return cleanRemoteParts(rest.slice(0, colon), rest.slice(colon + 1));
        }
    }
    if (isAbsolute(remote)) {
        return canonicalPath(remote);
    }
    return cleanRemoteParts("", remote);
}

/** Lowercases and trims a (host, path) remote pair into a comparable string. */
function cleanRemoteParts(host: string, path: string): string {
    host = host.trim().toLowerCase();
    path = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    path = path.replace(/\.git$/, "");
    path = path.toLowerCase();
    if (host === "") {
        return path;
    }
    if (path === "") {
        return host;
    }
    return `${host}/${path}`;
}

/** Returns the first line of `s`, trimmed. */
function firstLine(s: string): string {
    const i = s.indexOf("\n");
    if (i >= 0) {
        return s.slice(0, i).trim();
    }
    return s.trim();
}
