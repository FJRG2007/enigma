/**
 * Faithful 1:1 port of upstream's `internal/git` package (git.go + env.go),
 * rebranded for enigma gate. Every git invocation goes through `node:child_process`
 * `execFile`/`execFileSync` with an argv array (never a shell string) to mirror the
 * Go `exec.CommandContext(ctx, "git", args...)` calls and stay injection-safe.
 *
 * Go threaded `context.Context`; here every command takes an optional trailing
 * `signal?: AbortSignal`. Go functions that took no context (FindGitRoot,
 * FindMainRepoRoot) are ported as synchronous helpers via `execFileSync`.
 *
 * Naming: Go's exported `Run` (trimmed stdout, errors on failure) is ported as the
 * faithful `run`; the raw `{stdout, stderr, code}` helper requested for the port is
 * exported separately as `runRaw` to avoid colliding with it.
 */

import { realpathSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, resolve, dirname, normalize, isAbsolute } from "node:path";

/** Cap on captured git output; git diffs can be large, so this is generous. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** Message used when the git binary cannot be spawned (Go's exec.ErrNotFound). */
const ERR_NOT_FOUND = "exec: \"git\": executable file not found";

/** Matches http(s) URLs so credentials embedded in them can be redacted. */
const HTTP_URL_PATTERN = /https?:\/\/[^\s'"<>]+/g;

/**
 * EmptyTreeSHA is the well-known SHA of an empty tree in git. Used as a base
 * when there is no prior commit to diff against.
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Error from a failed git command, carrying the exit code and stderr. */
export class GitError extends Error {
    constructor(
        message: string,
        readonly code: number,
        readonly stderr: string,
        readonly notFound: boolean,
    ) {
        super(message);
        this.name = "GitError";
    }
}

interface RawResult {
    stdout: string;
    stderr: string;
    code: number;
    notFound: boolean;
}

/** Redacts userinfo from a single URL, leaving credential-free values unchanged. */
function redactUrl(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === "") return raw;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return raw;
    }
    if (!parsed.username && !parsed.password) return raw;
    parsed.username = "redacted";
    parsed.password = "";
    return parsed.toString();
}

/** Redacts credential-bearing http(s) URLs found anywhere inside a message. */
function redactText(text: string): string {
    return text.replace(HTTP_URL_PATTERN, (match) => redactUrl(match));
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * NonInteractiveEnv returns the environment for a git subprocess forced into a
 * fully non-interactive mode: editors point at `true` so commit/rebase accept
 * the existing message, and GIT_TERMINAL_PROMPT=0 fails fast instead of blocking
 * on credentials. PWD is mirrored to `dir` on non-Windows platforms, matching
 * what os/exec injects when Env is left unset.
 */
export function nonInteractiveEnv(dir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_TERMINAL_PROMPT: "0",
    };
    if (dir !== "" && process.platform !== "win32") {
        env.PWD = dir;
    }
    return env;
}

/** Runs git and resolves the raw outcome; rejects only when the run is aborted. */
function execGit(
    args: string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv | undefined,
    signal?: AbortSignal,
): Promise<RawResult> {
    return new Promise((resolvePromise, reject) => {
        execFile(
            "git",
            args,
            { cwd, env, signal, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
            (err, stdout, stderr) => {
                if (err) {
                    const e = err as NodeJS.ErrnoException;
                    if (e.code === "ABORT_ERR" || e.name === "AbortError") {
                        reject(err);
                        return;
                    }
                    const notFound = e.code === "ENOENT";
                    const code = typeof e.code === "number" ? e.code : notFound ? -1 : 1;
                    resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code, notFound });
                    return;
                }
                resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0, notFound: false });
            },
        );
    });
}

function notFoundError(label: string): GitError {
    return new GitError(`git ${label}: ${ERR_NOT_FOUND}`, -1, "", true);
}

/**
 * Run executes a git command in `dir` and returns trimmed stdout. Throws a
 * GitError that includes the command and stderr (both redacted) on failure.
 */
export async function run(dir: string, args: string[], signal?: AbortSignal): Promise<string> {
    const r = await execGit(args, dir, nonInteractiveEnv(dir), signal);
    if (r.notFound) throw notFoundError(redactText(args.join(" ")));
    if (r.code !== 0) {
        const stderr = r.stderr.trim();
        throw new GitError(
            `git ${redactText(args.join(" "))}: exit status ${r.code}: ${redactText(stderr)}`,
            r.code,
            stderr,
            false,
        );
    }
    return r.stdout.trim();
}

/**
 * runRaw executes a git command in `dir` and returns the untrimmed stdout,
 * stderr, and exit code without throwing on a non-zero exit. Throws only when
 * the git binary itself cannot be spawned.
 */
export async function runRaw(
    dir: string,
    args: string[],
    signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number; }> {
    const r = await execGit(args, dir, nonInteractiveEnv(dir), signal);
    if (r.notFound) throw notFoundError(redactText(args.join(" ")));
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
}

/**
 * IsZeroSHA returns true if the SHA is the null/zero ref that git uses for new
 * or deleted branches (40 zeros).
 */
export function isZeroSHA(sha: string): boolean {
    return sha === "0000000000000000000000000000000000000000";
}

/** InitBare creates a new bare git repository at the given path. */
export async function initBare(path: string, signal?: AbortSignal): Promise<void> {
    const r = await execGit(["init", "--bare", path], undefined, undefined, signal);
    if (r.notFound) throw new Error(`git init --bare: ${ERR_NOT_FOUND}`);
    if (r.code !== 0) {
        const combined = `${r.stdout}${r.stderr}`.trim();
        throw new Error(`git init --bare: exit status ${r.code}: ${combined}`);
    }
}

/** AddRemote adds a named remote to the repo at dir. */
export async function addRemote(dir: string, name: string, url: string, signal?: AbortSignal): Promise<void> {
    await run(dir, ["remote", "add", name, url], signal);
}

/**
 * EnsureRemote sets the named remote to url, adding it when absent and updating
 * its URL when it already exists. Idempotent, so it is safe to call when
 * repairing or re-running an init.
 */
export async function ensureRemote(dir: string, name: string, url: string, signal?: AbortSignal): Promise<void> {
    try {
        await getRemoteURL(dir, name, signal);
    } catch {
        await addRemote(dir, name, url, signal);
        return;
    }
    await run(dir, ["remote", "set-url", name, url], signal);
}

/** RemoveRemote removes a named remote from the repo at dir. */
export async function removeRemote(dir: string, name: string, signal?: AbortSignal): Promise<void> {
    await run(dir, ["remote", "remove", name], signal);
}

/** GetRemoteURL returns the URL of a named remote. */
export async function getRemoteURL(dir: string, name: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["remote", "get-url", name], signal);
}

/**
 * GetConfiguredRemoteURL returns the literal remote URL from git config, without
 * applying url.*.insteadOf rewrites.
 */
export async function getConfiguredRemoteURL(dir: string, name: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["config", "--get", `remote.${name}.url`], signal);
}

/**
 * FindGitRoot walks up from path to find the git repository root. Resolves
 * symlinks for consistency on macOS (e.g. /tmp -> /private/tmp).
 */
export function findGitRoot(path: string): string {
    const abs = resolve(path);
    let root: string;
    try {
        root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: abs,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        }).trim();
    } catch {
        throw new Error(`not a git repository: ${abs}`);
    }
    try {
        return realpathSync(root);
    } catch {
        return root;
    }
}

/**
 * FindMainRepoRoot returns the root of the main working tree. For a regular repo
 * this matches findGitRoot; for a worktree it resolves back to the main
 * repository root by inspecting git's common dir.
 */
export function findMainRepoRoot(path: string): string {
    const abs = resolve(path);
    let commonDir: string;
    try {
        commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
            cwd: abs,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        }).trim();
    } catch {
        throw new Error(`not a git repository: ${abs}`);
    }
    if (!isAbsolute(commonDir)) {
        commonDir = join(abs, commonDir);
    }
    const root = dirname(normalize(commonDir));
    try {
        return realpathSync(root);
    } catch {
        return root;
    }
}

/** Diff returns the unified diff between two commits. */
export async function diff(dir: string, base: string, head: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["diff", `${base}..${head}`, "--"], signal);
}

/** Options for diffNameOnly. */
export interface DiffNameOnlyOptions {
    signal?: AbortSignal;
    /** Extra `git diff` flags placed before the revision, e.g. "--diff-filter=d". */
    extraArgs?: string[];
}

/**
 * DiffNameOnly returns the list of files changed between base and head, or
 * between base and the working tree when head is empty. Output is split on
 * newlines with empty entries removed.
 *
 * Every name-only listing in the gate goes through here so the trailing "--"
 * cannot be forgotten at a call site. It keeps git from falling back to reading
 * the revision as a pathspec when it cannot resolve it: without it the fallback
 * stats the 82-char range relative to the worktree, and under a deep gate
 * worktree that stat exceeds the Windows path limit, so an unresolvable range
 * is reported as "failed to stat '<base>..<head>': Filename too long" instead
 * of naming the revision git could not find.
 */
export async function diffNameOnly(
    dir: string,
    base: string,
    head: string,
    options: DiffNameOnlyOptions = {},
): Promise<string[]> {
    const rev = head.trim() === "" ? base : `${base}..${head}`;
    const args = ["diff", "--name-only", ...(options.extraArgs ?? []), rev, "--"];
    const out = await run(dir, args, options.signal);
    const files: string[] = [];
    for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (trimmed !== "") files.push(trimmed);
    }
    return files;
}

/** CommitTime returns the committer timestamp for a SHA. */
export async function commitTime(dir: string, sha: string, signal?: AbortSignal): Promise<Date> {
    const out = await run(dir, ["show", "-s", "--format=%ct", sha], signal);
    const text = out.trim();
    if (!/^-?\d+$/.test(text)) {
        throw new Error(`parse commit time "${out}": invalid number`);
    }
    return new Date(Number(text) * 1000);
}

/** CommitAuthorEmail returns the author email for a SHA. */
export async function commitAuthorEmail(dir: string, sha: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["show", "-s", "--format=%ae", sha], signal);
}

/**
 * DiffHead returns the unified diff between HEAD and the working tree (both
 * staged and unstaged changes).
 */
export async function diffHead(dir: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["diff", "HEAD"], signal);
}

/** Log returns oneline log entries between two commits. */
export async function log(dir: string, base: string, head: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["log", "--oneline", `${base}..${head}`, "--"], signal);
}

/** HeadSHA returns the full SHA of HEAD. */
export async function headSHA(dir: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["rev-parse", "HEAD"], signal);
}

/** CurrentBranch returns the current branch name. */
export async function currentBranch(dir: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
}

/**
 * IsDetachedHEAD reports whether the working tree is in a detached-HEAD state.
 * Uses `git symbolic-ref` which fails cleanly when HEAD is not a symbolic ref.
 */
export async function isDetachedHEAD(dir: string, signal?: AbortSignal): Promise<boolean> {
    const r = await execGit(["symbolic-ref", "-q", "HEAD"], dir, undefined, signal);
    if (r.notFound) throw notFoundError("symbolic-ref");
    if (r.code === 1) return true;
    if (r.code !== 0) {
        throw new GitError(`git symbolic-ref: exit status ${r.code}`, r.code, r.stderr.trim(), false);
    }
    return false;
}

/**
 * DefaultBranch queries a remote to determine its default branch name via
 * `git ls-remote --symref`. Falls back to "main" if detection fails (e.g. empty
 * remote, unreachable).
 */
export async function defaultBranch(dir: string, remote: string, signal?: AbortSignal): Promise<string> {
    let out: string;
    try {
        out = await run(dir, ["ls-remote", "--symref", remote, "HEAD"], signal);
    } catch {
        return "main";
    }
    for (const line of out.split("\n")) {
        if (line.startsWith("ref: refs/heads/")) {
            const parts = line.split(/\s+/).filter((part) => part !== "");
            if (parts.length >= 2) return parts[1].replace(/^refs\/heads\//, "");
        }
    }
    return "main";
}

/**
 * FetchRemoteBranch fetches a single branch into a remote-tracking ref. Uses a
 * force-update refspec (+) so non-fast-forward updates are accepted.
 */
export async function fetchRemoteBranch(
    dir: string,
    remote: string,
    branch: string,
    signal?: AbortSignal,
): Promise<void> {
    const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
    await run(dir, ["fetch", "--no-tags", remote, refspec], signal);
}

/** FetchRemoteBranchToRef fetches a branch into an explicit local ref. */
export async function fetchRemoteBranchToRef(
    dir: string,
    remote: string,
    branch: string,
    localRef: string,
    signal?: AbortSignal,
): Promise<void> {
    const refspec = `+refs/heads/${branch}:${localRef}`;
    await run(dir, ["fetch", "--no-tags", remote, refspec], signal);
}

/**
 * Push pushes a ref to a remote. If forceWithLease is true, uses
 * --force-with-lease with the expectedSHA for a safe force-push.
 */
export async function push(
    dir: string,
    remote: string,
    ref: string,
    expectedSHA: string,
    forceWithLease: boolean,
    signal?: AbortSignal,
): Promise<void> {
    return pushWithOptions(dir, remote, ref, expectedSHA, forceWithLease, null, signal);
}

/** PushWithOptions pushes a ref to a remote with per-push options. */
export async function pushWithOptions(
    dir: string,
    remote: string,
    ref: string,
    expectedSHA: string,
    forceWithLease: boolean,
    pushOptions: string[] | null,
    signal?: AbortSignal,
): Promise<void> {
    const args: string[] = ["push"];
    for (const option of pushOptions ?? []) {
        args.push("-o", option);
    }
    args.push(remote);
    if (forceWithLease) {
        if (expectedSHA !== "") {
            args.push(`--force-with-lease=${ref}:${expectedSHA}`);
        } else {
            args.push("--force-with-lease");
        }
    }
    args.push(`HEAD:${ref}`);
    await run(dir, args, signal);
}

/** LsRemote returns the SHA of a ref on a remote, or "" if it does not exist. */
export async function lsRemote(dir: string, remote: string, ref: string, signal?: AbortSignal): Promise<string> {
    const out = await run(dir, ["ls-remote", remote, ref], signal);
    if (out === "") return "";
    const parts = out.split(/\s+/).filter((part) => part !== "");
    if (parts.length < 1) return "";
    return parts[0];
}

/**
 * HasUncommittedChanges reports whether the working tree or index differs from
 * HEAD. Equivalent to a non-empty `git status --porcelain`.
 */
export async function hasUncommittedChanges(dir: string, signal?: AbortSignal): Promise<boolean> {
    const out = await run(dir, ["status", "--porcelain"], signal);
    return out !== "";
}

/**
 * CreateBranch creates a new branch with the given name and switches to it.
 * Fails if the branch already exists.
 */
export async function createBranch(dir: string, name: string, signal?: AbortSignal): Promise<void> {
    await run(dir, ["checkout", "-b", name], signal);
}

/**
 * CommitAll stages every change in the working tree and creates a single commit
 * with the given message. Fails if there are no changes to commit.
 */
export async function commitAll(dir: string, message: string, signal?: AbortSignal): Promise<void> {
    await run(dir, ["add", "-A"], signal);
    const dirty = await hasUncommittedChanges(dir, signal);
    if (!dirty) throw new Error("no changes to commit");
    await run(dir, ["commit", "-m", message], signal);
}

/**
 * CopyLocalUserIdentity copies local user.name and user.email from srcDir into
 * dstDir. Missing values in srcDir are ignored.
 */
export async function copyLocalUserIdentity(srcDir: string, dstDir: string, signal?: AbortSignal): Promise<void> {
    for (const key of ["user.name", "user.email"]) {
        const value = await run(srcDir, ["config", "--local", "--get", "--default", "", key], signal);
        if (value === "") continue;
        await run(dstDir, ["config", "--local", key, value], signal);
    }
}

/** WorktreeAdd creates a detached worktree at wtPath checked out to the given SHA. */
export async function worktreeAdd(repoDir: string, wtPath: string, sha: string, signal?: AbortSignal): Promise<void> {
    await run(repoDir, ["worktree", "add", "--detach", wtPath, sha], signal);
}

/** WorktreeRemove removes a worktree at the given path. */
export async function worktreeRemove(repoDir: string, wtPath: string, signal?: AbortSignal): Promise<void> {
    await run(repoDir, ["worktree", "remove", "--force", wtPath], signal);
}

/**
 * ResolveRef returns the commit SHA that ref resolves to via
 * `git rev-parse --verify <ref>^{commit}`. Throws if the ref does not resolve.
 */
export async function resolveRef(dir: string, ref: string, signal?: AbortSignal): Promise<string> {
    try {
        return await run(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);
    } catch (err) {
        throw new Error(`resolve ref ${ref}: ${errMessage(err)}`);
    }
}

/**
 * RefExists reports whether the given ref resolves to a commit. A missing ref is
 * a clean `false` rather than an error.
 */
export async function refExists(dir: string, ref: string, signal?: AbortSignal): Promise<boolean> {
    const r = await execGit(
        ["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        undefined,
        nonInteractiveEnv(dir),
        signal,
    );
    if (r.notFound) throw notFoundError(`rev-parse ${ref}`);
    if (r.code === 1) return false;
    if (r.code !== 0) {
        throw new GitError(`git rev-parse ${ref}: exit status ${r.code}`, r.code, r.stderr.trim(), false);
    }
    return true;
}

/**
 * ShowFile returns the content of path as stored at the given ref via
 * `git show <ref>:<path>`. A failure (e.g. the path is absent at the ref) is
 * surfaced as the underlying git error.
 */
export async function showFile(dir: string, ref: string, path: string, signal?: AbortSignal): Promise<string> {
    return run(dir, ["show", `${ref}:${path}`], signal);
}
