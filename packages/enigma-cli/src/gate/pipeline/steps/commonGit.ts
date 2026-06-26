/**
 * Git base/default-branch resolution helpers shared by pipeline steps. Faithful
 * port of the no-mistakes `internal/pipeline/steps/common_git.go`.
 *
 * Go threaded `context.Context` as the first argument; here every helper takes an
 * `AbortSignal` first, matching Go's positional order so the eventual step ports
 * call them identically. Go's `git.Run` returned `(out, error)`; here git.run
 * throws on failure, so the "try git.Run, fall back on error" branches become
 * try/catch.
 */

import * as git from "../../git";

/**
 * Returns a usable base SHA for diff/log operations. When baseSHA is the zero ref
 * (new branch push), tries git merge-base against the default branch, falling
 * back to the empty tree SHA.
 */
export async function resolveBaseSHA(
    signal: AbortSignal,
    workDir: string,
    baseSHA: string,
    defaultBranch: string
): Promise<string> {
    if (!git.isZeroSHA(baseSHA)) return baseSHA;
    const mb = await mergeBaseWithDefaultBranch(signal, workDir, defaultBranch);
    if (mb !== "") return mb;
    return git.EMPTY_TREE_SHA;
}

/**
 * Returns the branch base commit relative to the default branch when possible,
 * keeping pipeline steps scoped to the full branch, not just the last pushed
 * delta. Falls back to resolveBaseSHA when merge-base cannot be determined.
 */
export async function resolveBranchBaseSHA(
    signal: AbortSignal,
    workDir: string,
    fallbackBaseSHA: string,
    defaultBranch: string
): Promise<string> {
    const mb = await mergeBaseWithDefaultBranch(signal, workDir, defaultBranch);
    if (mb !== "") return mb;
    return resolveBaseSHA(signal, workDir, fallbackBaseSHA, defaultBranch);
}

export async function resolveDefaultBranchTipSHA(
    signal: AbortSignal,
    workDir: string,
    upstreamURL: string,
    fallbackBaseSHA: string,
    defaultBranch: string
): Promise<string> {
    const [sha] = await resolveDefaultBranchTip(signal, workDir, upstreamURL, fallbackBaseSHA, defaultBranch);
    return sha;
}

export async function resolveDefaultBranchTip(
    signal: AbortSignal,
    workDir: string,
    upstreamURL: string,
    fallbackBaseSHA: string,
    defaultBranch: string
): Promise<[string, boolean]> {
    if (defaultBranch.trim() !== "") {
        const remoteName = await resolveUpstreamRemoteName(signal, workDir, upstreamURL);
        try {
            await git.fetchRemoteBranch(workDir, remoteName, defaultBranch, signal);
        } catch {
            return [await unresolvedDefaultBranchTip(signal, workDir, fallbackBaseSHA, defaultBranch), false];
        }
        for (const ref of [`${remoteName}/${defaultBranch}`, defaultBranch]) {
            try {
                const sha = await git.run(workDir, ["rev-parse", "--verify", ref], signal);
                if (sha.trim() !== "") return [sha.trim(), true];
            } catch {
                // err -> try the next ref.
            }
        }
    }
    return [await resolveBaseSHA(signal, workDir, fallbackBaseSHA, defaultBranch), false];
}

export async function unresolvedDefaultBranchTip(
    signal: AbortSignal,
    workDir: string,
    fallbackBaseSHA: string,
    defaultBranch: string
): Promise<string> {
    if (!git.isZeroSHA(fallbackBaseSHA)) return fallbackBaseSHA;
    try {
        const sha = await git.run(workDir, ["rev-parse", "--verify", defaultBranch], signal);
        if (sha.trim() !== "") return sha.trim();
    } catch {
        // localErr -> fall back to the empty tree SHA.
    }
    return git.EMPTY_TREE_SHA;
}

export async function resolveUpstreamRemoteName(
    signal: AbortSignal,
    workDir: string,
    upstreamURL: string
): Promise<string> {
    if (upstreamURL.trim() === "") return "origin";
    let remotes: string;
    try {
        remotes = await git.run(workDir, ["remote"], signal);
    } catch {
        return "origin";
    }
    for (const remote of remotes.split(/\s+/).filter(part => part !== "")) {
        try {
            const url = await git.getRemoteURL(workDir, remote, signal);
            if (url.trim() === upstreamURL.trim()) return remote;
        } catch {
            // urlErr -> try the next remote.
        }
    }
    return "origin";
}

export async function mergeBaseWithDefaultBranch(
    signal: AbortSignal,
    workDir: string,
    defaultBranch: string
): Promise<string> {
    if (defaultBranch.trim() === "") return "";
    for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
        try {
            const mb = await git.run(workDir, ["merge-base", "HEAD", ref], signal);
            if (mb.trim() !== "") return mb.trim();
        } catch {
            // err -> try the next ref.
        }
    }
    return "";
}

export function normalizedBranchRef(ref: string): string {
    if (!ref.startsWith("refs/")) return `refs/heads/${ref}`;
    return ref;
}
