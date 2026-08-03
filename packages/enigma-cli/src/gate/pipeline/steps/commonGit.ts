/**
 * Git base/default-branch resolution helpers shared by pipeline steps. Faithful
 * port of the upstream `internal/pipeline/steps/common_git.go`.
 *
 * Go threaded `context.Context` as the first argument; here every helper takes an
 * `AbortSignal` first, matching Go's positional order so the eventual step ports
 * call them identically. Go's `git.Run` returned `(out, error)`; here git.run
 * throws on failure, so the "try git.Run, fall back on error" branches become
 * try/catch.
 */

import { log } from "@/gate/log";
import * as git from "@/gate/git";

/**
 * Rethrows a git failure that is really a cancellation. Every helper here treats
 * a failing git call as "this revision is unusable" and falls back, but a
 * cancelled run fails every call the same way, which would turn a cancellation
 * into a run-visible claim that the operator's base commit is broken.
 */
function rethrowIfAborted(signal: AbortSignal, err: unknown): void {
    if (signal.aborted) throw err;
}

/**
 * Resolves a revision to its canonical commit SHA, or null when git cannot.
 *
 * Every base SHA that reaches a `<base>..<head>` range goes through here: git
 * reads an empty left side as HEAD, so `git diff --name-only ..HEAD --` exits 0
 * with no output and a step concludes there is nothing to do instead of failing.
 * Returning the resolved SHA rather than the input also canonicalizes a ref
 * name, an abbreviated SHA, or a value carrying stray whitespace.
 */
export async function resolveCommitSHA(
    signal: AbortSignal,
    workDir: string,
    rev: string
): Promise<string | null> {
    const trimmed = rev.trim();
    if (trimmed === "") return null;
    try {
        const out = await git.run(workDir, ["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`], signal);
        return out.trim() === "" ? null : out.trim();
    } catch (err) {
        rethrowIfAborted(signal, err);
        return null;
    }
}

/**
 * Run-visible log channel (`sctx.log`). A base SHA the caller supplied but git
 * cannot use changes what every later step diffs, so the substitution has to
 * reach the operator reading the run, not just the daemon log file.
 */
export type ScopeNotifier = (text: string) => void;

function branchLabel(defaultBranch: string): string {
    return defaultBranch.trim() === "" ? "the default branch" : defaultBranch.trim();
}

function reportBaseSubstitution(
    notify: ScopeNotifier | undefined,
    workDir: string,
    baseSHA: string,
    cause: string,
    outcome: string
): void {
    const text = `${cause}; ${outcome}`;
    log.warn(text, "base_sha", baseSHA, "work_dir", workDir);
    notify?.(text);
}

function shownSHA(sha: string): string {
    return sha.trim() === "" ? "(empty)" : sha.trim();
}

/** Why the caller-supplied base could not be used, in operator-facing wording. */
function unusableBaseCause(baseSHA: string): string {
    return `base commit ${shownSHA(baseSHA)} does not resolve to a commit in this worktree`;
}

function zeroBaseCause(): string {
    return "base commit is the zero ref (new branch with no pushed history)";
}

/** Wording for the empty-tree fallback, shared by both unusable-base causes. */
function emptyTreeOutcome(defaultBranch: string): string {
    return `no merge-base with ${branchLabel(defaultBranch)} either, so this step diffs against the empty tree and treats every tracked file as changed`;
}

/**
 * Returns a usable base SHA for diff/log operations. The caller-supplied SHA is
 * used only when git resolves it to a commit present in this worktree; when it
 * is the zero ref (new branch push), orphaned by a force push, or otherwise
 * unusable, tries git merge-base against the default branch and falls back to
 * the empty tree SHA, so the range covers everything rather than nothing.
 *
 * The empty tree is the right base for a genuinely empty history, but it also
 * silently widens every later diff to the whole repository, so every path that
 * reaches it is reported through `notify` when one is supplied - including the
 * zero ref, which is the more common way a run gets there than a broken base.
 */
export async function resolveBaseSHA(
    signal: AbortSignal,
    workDir: string,
    baseSHA: string,
    defaultBranch: string,
    notify?: ScopeNotifier
): Promise<string> {
    const zero = git.isZeroSHA(baseSHA);
    if (!zero) {
        const resolved = await resolveCommitSHA(signal, workDir, baseSHA);
        if (resolved !== null) return resolved;
    }
    const mb = await mergeBaseWithDefaultBranch(signal, workDir, defaultBranch);
    if (mb !== "") {
        // A zero ref resolving to a merge-base is the expected new-branch path,
        // not a substitution worth a warning; a broken base still is one.
        if (!zero) {
            reportBaseSubstitution(
                notify, workDir, baseSHA,
                unusableBaseCause(baseSHA),
                `using merge-base ${mb} with ${branchLabel(defaultBranch)} instead`
            );
        }
        return mb;
    }
    reportBaseSubstitution(
        notify, workDir, baseSHA,
        zero ? zeroBaseCause() : unusableBaseCause(baseSHA),
        emptyTreeOutcome(defaultBranch)
    );
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
    defaultBranch: string,
    notify?: ScopeNotifier
): Promise<string> {
    const mb = await mergeBaseWithDefaultBranch(signal, workDir, defaultBranch);
    if (mb !== "") return mb;
    return resolveBaseSHA(signal, workDir, fallbackBaseSHA, defaultBranch, notify);
}

/**
 * The tip this resolves feeds the rebase target, so its substitutions take the
 * same optional `notify` as the diff base: a caller that acts on the returned
 * SHA regardless of the resolved flag should pass the run-visible channel.
 */
export async function resolveDefaultBranchTipSHA(
    signal: AbortSignal,
    workDir: string,
    upstreamURL: string,
    fallbackBaseSHA: string,
    defaultBranch: string,
    notify?: ScopeNotifier
): Promise<string> {
    const [sha] = await resolveDefaultBranchTip(
        signal, workDir, upstreamURL, fallbackBaseSHA, defaultBranch, notify
    );
    return sha;
}

export async function resolveDefaultBranchTip(
    signal: AbortSignal,
    workDir: string,
    upstreamURL: string,
    fallbackBaseSHA: string,
    defaultBranch: string,
    notify?: ScopeNotifier
): Promise<[string, boolean]> {
    if (defaultBranch.trim() !== "") {
        const remoteName = await resolveUpstreamRemoteName(signal, workDir, upstreamURL);
        try {
            await git.fetchRemoteBranch(workDir, remoteName, defaultBranch, signal);
        } catch (err) {
            rethrowIfAborted(signal, err);
            return [
                await unresolvedDefaultBranchTip(signal, workDir, fallbackBaseSHA, defaultBranch, notify),
                false
            ];
        }
        for (const ref of [`${remoteName}/${defaultBranch}`, defaultBranch]) {
            try {
                const sha = await git.run(workDir, ["rev-parse", "--verify", ref], signal);
                if (sha.trim() !== "") return [sha.trim(), true];
            } catch (err) {
                rethrowIfAborted(signal, err);
                // err -> try the next ref.
            }
        }
    }
    return [await resolveBaseSHA(signal, workDir, fallbackBaseSHA, defaultBranch, notify), false];
}

export async function unresolvedDefaultBranchTip(
    signal: AbortSignal,
    workDir: string,
    fallbackBaseSHA: string,
    defaultBranch: string,
    notify?: ScopeNotifier
): Promise<string> {
    if (!git.isZeroSHA(fallbackBaseSHA)) {
        const resolved = await resolveCommitSHA(signal, workDir, fallbackBaseSHA);
        if (resolved !== null) return resolved;
    }
    try {
        const sha = await git.run(workDir, ["rev-parse", "--verify", defaultBranch], signal);
        if (sha.trim() !== "") return sha.trim();
    } catch (err) {
        rethrowIfAborted(signal, err);
        // localErr -> fall back to the empty tree SHA.
    }
    const text = `${branchLabel(defaultBranch)} tip does not resolve in this worktree, and neither does base commit ${shownSHA(fallbackBaseSHA)}; this step falls back to the empty tree and treats every tracked file as changed`;
    log.warn(text, "base_sha", fallbackBaseSHA, "default_branch", defaultBranch, "work_dir", workDir);
    notify?.(text);
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
    } catch (err) {
        rethrowIfAborted(signal, err);
        return "origin";
    }
    for (const remote of remotes.split(/\s+/).filter(part => part !== "")) {
        try {
            const url = await git.getRemoteURL(workDir, remote, signal);
            if (url.trim() === upstreamURL.trim()) return remote;
        } catch (err) {
            rethrowIfAborted(signal, err);
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
        } catch (err) {
            rethrowIfAborted(signal, err);
            // err -> try the next ref.
        }
    }
    return "";
}

export function normalizedBranchRef(ref: string): string {
    if (!ref.startsWith("refs/")) return `refs/heads/${ref}`;
    return ref;
}
