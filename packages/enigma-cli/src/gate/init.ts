/**
 * Gate setup and teardown for a git repo: create/repair the disposable bare
 * repo that fronts the real remote, install the post-receive hook, wire the
 * `gate` git remote, and record the repo in the database. Faithful port of the
 * Go `internal/gate` package.
 *
 * Init is idempotent: re-running it repairs and refreshes an existing gate
 * (newer hook, hook-path isolation, restored remote) instead of failing, and
 * reattaches a gate whose working directory was renamed or moved.
 */

import { log } from "./log";
import { Paths } from "./paths";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { detectProvider, repoSlug, PROVIDER_GITHUB } from "./scm/host";
import { isolateHooksPath, refreshManagedPostReceiveHook } from "./hook";
import {
    run,
    initBare,
    addRemote,
    ensureRemote,
    removeRemote,
    getRemoteURL,
    defaultBranch,
    findMainRepoRoot,
    getConfiguredRemoteURL
} from "./git";
import {
    type Repo,
    type Database,
    getRepo,
    deleteRepo,
    getRepoByPath,
    updateRepoMetadata,
    updateRepoWorkingPath,
    insertRepoWithIDAndFork,
    updateRepoMetadataWithFork
} from "./db";

/** Name of the git remote that points to the local gate. */
export const REMOTE_NAME = "gate";

/** Result of an init: the repo record and whether a new gate was created. */
export interface InitResult {
    repo: Repo;
    created: boolean;
}

/** Deterministic 12-char hex ID from an absolute path. */
function repoID(absPath: string): string {
    return createHash("sha256").update(absPath).digest("hex").slice(0, 12);
}

/** Sets up a gate for the git repo at workDir. See InitWithFork. */
export async function init(d: Database, p: Paths, workDir: string): Promise<InitResult> {
    return initWithFork(d, p, workDir, "");
}

/**
 * Init plus an optional GitHub fork push URL. The origin remote remains the
 * parent repository used for PRs. When forkURL is empty, an existing fork
 * setting is preserved across idempotent refreshes.
 */
export async function initWithFork(d: Database, p: Paths, workDir: string, forkURL: string): Promise<InitResult> {
    forkURL = forkURL.trim();

    // Normalize worktrees back to the main repo root so one repo record works
    // from either the main checkout or any attached worktree.
    const absRoot = findMainRepoRoot(workDir);

    // Look up any existing gate so we know whether this is a fresh init or a
    // refresh, and so we never tear down a working gate on a repair failure.
    let existing = getRepoByPath(d, absRoot);
    if (existing === null) {
        // No record at this path, but the repo may have been moved or renamed
        // after init; if so, reattach its existing gate instead of failing.
        existing = await reattachRelocatedRepo(d, p, absRoot);
    }

    // Read origin URL. Keep the historical rewritten value for non-fork repos,
    // but preserve the literal parent URL when fork routing is configured.
    const useConfigured = forkURL !== "" || (existing !== null && (existing.forkUrl ?? "").trim() !== "");
    const getOriginURL = useConfigured ? getConfiguredRemoteURL : getRemoteURL;
    const upstreamURL = await getOriginURL(absRoot, "origin");
    if (forkURL !== "") validateForkRouting(upstreamURL, forkURL);

    const id = existing !== null ? existing.id : repoID(absRoot);
    const bareDir = p.repoDir(id);

    // Provision (or repair) the on-disk gate. This is idempotent.
    try {
        await provisionGate(bareDir, absRoot, upstreamURL, p.reposDir(), existing !== null);
    } catch (err) {
        // Only tear down a gate we created in this call; never destroy an
        // already-initialized gate when a repair pass fails.
        if (existing === null) {
            try {
                if ((await getRemoteURL(absRoot, REMOTE_NAME)) === bareDir) await removeRemote(absRoot, REMOTE_NAME);
            } catch {
                // best-effort rollback
            }
            rmSync(bareDir, { recursive: true, force: true });
        }
        throw err;
    }

    // Detect default branch from upstream remote.
    const branch = await defaultBranch(absRoot, "origin");

    if (existing !== null) {
        const repo =
            forkURL !== ""
                ? updateRepoMetadataWithFork(d, existing.id, upstreamURL, forkURL, branch)
                : updateRepoMetadata(d, existing.id, upstreamURL, branch);
        if (repo === null) throw new Error("update repo metadata: repo not found");
        log.info("gate refreshed", "repo_id", repo.id, "path", absRoot);
        return { repo, created: false };
    }

    // Insert repo record with deterministic ID.
    let repo: Repo;
    try {
        repo = insertRepoWithIDAndFork(d, id, absRoot, upstreamURL, forkURL, branch);
    } catch (err) {
        // Rollback: remove remote and bare repo.
        try {
            await removeRemote(absRoot, REMOTE_NAME);
        } catch {
            // best-effort
        }
        rmSync(bareDir, { recursive: true, force: true });
        throw new Error(`insert repo: ${(err as Error).message}`);
    }

    log.info("gate initialized", "repo_id", id, "path", absRoot, "upstream", upstreamURL);
    return { repo, created: true };
}

function validateForkRouting(upstreamURL: string, forkURL: string): void {
    const parentProvider = detectProvider(upstreamURL);
    const forkProvider = detectProvider(forkURL);
    if (parentProvider === PROVIDER_GITHUB && forkProvider === PROVIDER_GITHUB) {
        if (repoSlug(upstreamURL) === "" || repoSlug(forkURL) === "") {
            throw new Error("fork URL routing requires GitHub parent and fork remotes with owner/repo paths");
        }
        return;
    }
    throw new Error(
        `fork URL routing is currently supported only for GitHub parent and fork remotes (parent provider: ${parentProvider}, fork provider: ${forkProvider})`
    );
}

/**
 * Creates or repairs the on-disk gate: the bare repo, its push/hook config,
 * hook-path isolation, and the remotes wiring the working repo to the gate and
 * the gate to its upstream. Every step is idempotent so this doubles as the
 * repair path for re-running init.
 */
async function provisionGate(
    bareDir: string,
    absRoot: string,
    upstreamURL: string,
    reposDir: string,
    refresh: boolean
): Promise<void> {
    // Create the bare repo. git init --bare is a no-op on an existing one.
    await initBare(bareDir);
    await run(bareDir, ["config", "receive.advertisePushOptions", "true"]);

    refreshManagedPostReceiveHook(bareDir);

    // Pin core.hookspath in the bare's per-worktree config so subprocess writes
    // to shared local config (e.g. husky during pnpm install) can't disable the
    // gate hook.
    await isolateHooksPath(bareDir);

    // Record upstream as origin on the gate repo so the SCM CLI can resolve
    // repository context from detached worktrees created from the gate.
    await ensureRemote(bareDir, "origin", upstreamURL);

    await ensureWorkingRemote(absRoot, bareDir, reposDir, refresh);
}

async function ensureWorkingRemote(absRoot: string, bareDir: string, reposDir: string, refresh: boolean): Promise<void> {
    if (refresh) {
        await ensureRemote(absRoot, REMOTE_NAME, bareDir);
        return;
    }
    let existingURL: string;
    try {
        existingURL = await getRemoteURL(absRoot, REMOTE_NAME);
    } catch {
        await addRemote(absRoot, REMOTE_NAME, bareDir);
        return;
    }
    if (existingURL === bareDir) return;
    // A leftover remote pointing into our own repos dir is stale gate wiring
    // (e.g. the working directory was copied, or its gate was half-ejected);
    // repoint it. Anything else is a user-managed remote we must not touch.
    if (dirname(existingURL) === reposDir) {
        await ensureRemote(absRoot, REMOTE_NAME, bareDir);
        return;
    }
    throw new Error(`remote "${REMOTE_NAME}" already exists with url "${existingURL}"`);
}

/**
 * Detects a working directory renamed or moved after init: it carries a gate
 * remote pointing at a gate in our repos dir, but its repo record references
 * the old path. When the old path no longer exists, the record is migrated to
 * the new path so the existing gate and its run history are reattached. Returns
 * null when the repo should be treated as a fresh init instead.
 */
async function reattachRelocatedRepo(d: Database, p: Paths, absRoot: string): Promise<Repo | null> {
    let remoteURL: string;
    try {
        remoteURL = await getRemoteURL(absRoot, REMOTE_NAME);
    } catch {
        return null;
    }
    const id = basename(remoteURL).replace(/\.git$/, "");
    if (p.repoDir(id) !== remoteURL) {
        // Not one of our gate paths; fresh init decides what to do with it.
        return null;
    }
    const repo = getRepo(d, id);
    if (repo === null) return null;
    if (existsSync(repo.workingPath)) {
        // The recorded checkout still exists, so absRoot is a copy of it, not a
        // move; the copy gets its own gate.
        return null;
    }
    const migrated = updateRepoWorkingPath(d, id, absRoot);
    if (migrated === null) return null;
    log.info("gate reattached after working dir move", "repo_id", id, "old_path", repo.workingPath, "new_path", absRoot);
    return migrated;
}

/**
 * Removes the gate from the repo at workDir: removes the remote, deletes the
 * bare repo and worktrees, and deletes the repo record from the database.
 */
export async function eject(d: Database, p: Paths, workDir: string): Promise<Repo> {
    // Normalize worktrees back to the main repo root so eject works no matter
    // which checkout the user runs it from.
    const absRoot = findMainRepoRoot(workDir);

    const repo = getRepoByPath(d, absRoot);
    if (repo === null) throw new Error(`not initialized for ${absRoot}`);

    // Remove remote from working repo (non-fatal).
    try {
        await removeRemote(absRoot, REMOTE_NAME);
    } catch {
        // best-effort
    }

    // Delete bare repo.
    rmSync(p.repoDir(repo.id), { recursive: true, force: true });

    // Delete worktrees for this repo.
    rmSync(join(p.worktreesDir(), repo.id), { recursive: true, force: true });

    // Delete repo record (cascades to runs + steps).
    deleteRepo(d, repo.id);

    log.info("gate ejected", "repo_id", repo.id, "path", absRoot);
    return repo;
}
