/**
 * Tidying up after a finished branch.
 *
 * An agent or a gate run creates a working branch, the work lands in the default
 * branch, and the checkout is left sitting on a branch nobody will touch again -
 * with the branch still on the remote. This puts the checkout back on the default
 * branch and removes the dead branch locally and on the remote.
 *
 * THE ENTIRE DESIGN IS THE REFUSALS. Deleting a branch that still holds work is
 * unrecoverable in practice, so nothing here runs on a guess: a branch is only
 * touched when the default branch DEMONSTRABLY contains everything it has, proved by
 * content rather than by ancestry (a squash or rebase merge rewrites the commits, so
 * `--merged` alone answers "no" to branches that are perfectly merged, and no check
 * that trusts commit identity can be the only one). Every other case - unmerged
 * commits, uncommitted or stashed work, a remote tip we could not read, a branch
 * checked out somewhere else, a protected name - is REPORTED and left alone.
 *
 * And even the branches it does delete are recoverable: the tip SHA is written to an
 * undo ledger and printed with the command that restores it, before anything is
 * removed. `git reflog` keeps the same commit reachable for its expiry window, so a
 * deletion made here is always reversible with information the caller was handed.
 */

import * as git from "./gate/git";
import { enigmaHome } from "./util";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

/** Branch names never deleted, whatever the containment check says. */
const PROTECTED = new Set(["main", "master", "develop", "development", "trunk", "release", "stable", "HEAD"]);

/** How many deletions the undo ledger keeps. */
const LEDGER_LIMIT = 200;

export type SkipReason =
    | "protected-name"
    | "default-branch"
    | "not-contained"
    | "checked-out-elsewhere"
    | "remote-ahead"
    | "remote-unverifiable"
    | "dirty-worktree"
    | "has-stash";

/** One branch and what tidying decided about it. */
export interface BranchVerdict {
    branch: string;
    /** Tip commit, recorded so a deletion can be undone. */
    sha: string;
    /** True when every safety check passed and the branch may be removed. */
    tidyable: boolean;
    /** Why it was left alone. Absent when `tidyable`. */
    reason?: SkipReason;
    /** Human sentence for the report, always set. */
    detail: string;
    /** True when the branch also exists on the remote and that copy is contained too. */
    remote: boolean;
}

export interface TidyPlan {
    /** Default branch the checkout is returned to. */
    defaultBranch: string;
    /**
     * The ref work is proved merged into: the remote's copy of the default branch when it
     * resolves, else the local one. Absent on a blocked plan.
     */
    baseRef?: string;
    /** Branch the checkout is on right now ("" when detached). */
    currentBranch: string;
    /** Every local branch with its verdict, tidyable ones first. */
    verdicts: BranchVerdict[];
    /**
     * Set when the whole repository is off limits - no default branch, so nothing can be
     * proved merged against anything. Nothing is touched while this is set. A dirty working
     * tree is NOT one of these: it refuses the checked-out branch and only that one.
     */
    blocked?: string;
}

export interface TidyResult {
    plan: TidyPlan;
    /** Branches deleted locally. */
    deleted: string[];
    /** Branches deleted on the remote. */
    deletedRemote: string[];
    /** True when the checkout was moved back to the default branch. */
    switched: boolean;
    /** Failures that did not stop the rest (a remote that refused the delete). */
    problems: string[];
    /** Idle worktrees removed (or, on a dry run, that would be) so their branches could go. */
    worktrees: string[];
    /** Branches that existed only on the remote and were deleted there (or would be), with their tips. */
    remoteOnly: Array<{ branch: string; sha: string; }>;
    /** Stale remote-tracking refs pruned (branches already deleted on their remote). */
    pruned: number;
    /** Things kept for a reason that is not a failure, for the report. */
    notes: string[];
}

/**
 * Path of the undo ledger, resolved lazily per call so a test can move the home.
 *
 * Through `enigmaHome()` rather than the os helper: bun on Linux resolves that one from
 * the OS account and ignores a reassigned `$HOME`, so the ledger went to the runner's
 * real home while the test had blocked a path under its temp one - the write succeeded,
 * the branch was deleted, and the single test asserting that an unwritable ledger STOPS a
 * deletion passed on Windows and failed on CI. Every other `~/.enigma` path resolves the
 * same way for the same reason (util.ts).
 */
function ledgerPath(): string {
    return join(enigmaHome(), ".enigma", "deleted-branches.json");
}

interface LedgerEntry {
    at: string;
    repo: string;
    branch: string;
    sha: string;
    remote: boolean;
}

/** Read the undo ledger; a missing or corrupt file reads as empty, never throws. */
export function readLedger(): LedgerEntry[] {
    try {
        const raw = JSON.parse(readFileSync(ledgerPath(), "utf8"));
        return Array.isArray(raw) ? (raw as LedgerEntry[]) : [];
    } catch { return []; }
}

/**
 * Record a deletion BEFORE it happens. A write failure is fatal to the deletion, not
 * merely logged: the ledger is what makes the removal reversible, so a branch is
 * never deleted while it cannot be written down.
 */
function recordDeletion(repo: string, entry: Omit<LedgerEntry, "at" | "repo">): void {
    const next = [{ at: new Date().toISOString(), repo, ...entry }, ...readLedger()].slice(0, LEDGER_LIMIT);
    mkdirSync(join(enigmaHome(), ".enigma"), { recursive: true });
    writeFileSync(ledgerPath(), `${JSON.stringify(next, null, 2)}\n`);
}

/** Local branch names, in `git for-each-ref` order. */
async function localBranches(dir: string): Promise<string[]> {
    const out = await git.run(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * How long a worktree must sit untouched before it counts as abandoned. Agents create a
 * worktree per task (Claude Code's `.claude/worktrees`, a session scratchpad, the gate) and
 * rarely remove it, and a worktree that still exists pins its branch as "checked out
 * elsewhere" - measured in one repository, 34 of 41 branches were held that way. Six hours
 * is far past any single agent turn, so a worktree a live session is using is never one.
 */
const WORKTREE_IDLE_MS = 6 * 60 * 60 * 1000;

interface WorktreeEntry { path: string; head: string; branch: string; locked: boolean; }

/** Every worktree but the main one, parsed from `git worktree list --porcelain`. */
async function linkedWorktrees(dir: string): Promise<WorktreeEntry[]> {
    const out = await git.run(dir, ["worktree", "list", "--porcelain"]).catch(() => "");
    const entries: WorktreeEntry[] = [];
    for (const block of out.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/).map((l) => l.trim());
        const path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
        if (!path) continue;
        entries.push({
            path,
            head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "",
            branch: (lines.find((l) => l.startsWith("branch "))?.slice(7) ?? "").replace(/^refs\/heads\//, ""),
            locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
        });
    }
    return entries.slice(1); // the first entry is the main working tree
}

/** Newest modification time across a worktree's directory and its git metadata, in ms. */
async function lastTouched(path: string): Promise<number> {
    const gitDir = await git.run(path, ["rev-parse", "--absolute-git-dir"]).catch(() => "");
    let newest = 0;
    for (const file of [path, join(gitDir, "HEAD"), join(gitDir, "index"), join(gitDir, "logs", "HEAD")]) {
        try { newest = Math.max(newest, statSync(file).mtimeMs); } catch { /* absent: not evidence either way */ }
    }
    return newest;
}

/**
 * Linked worktrees that are safe to remove: not locked, not the gate's own (it tears those
 * down itself), present on disk, clean (untracked files count as work), untouched for
 * WORKTREE_IDLE_MS, and holding nothing `base` lacks. Removing one loses no line of work by
 * construction, and `git worktree remove` without --force re-checks the clean half itself.
 */
export async function idleWorktrees(dir: string, base: string, defaultBranch: string, now = Date.now()): Promise<WorktreeEntry[]> {
    const slashes = (p: string): string => p.split("\\").join("/").toLowerCase();
    const gateRoot = slashes(join(enigmaHome(), ".enigma", "gate"));
    const idle: WorktreeEntry[] = [];
    for (const wt of await linkedWorktrees(dir)) {
        if (wt.locked || !existsSync(wt.path)) continue;
        if (slashes(wt.path).startsWith(gateRoot)) continue;
        if (now - await lastTouched(wt.path) < WORKTREE_IDLE_MS) continue;
        const status = await git.run(wt.path, ["status", "--porcelain"]).catch(() => null);
        if (status === null || status !== "") continue;
        const tip = wt.branch || wt.head;
        if (!tip || !await containedInAny(dir, base, defaultBranch, tip)) continue;
        idle.push(wt);
    }
    return idle;
}

/** Branches checked out by another worktree, which git itself refuses to delete. */
async function branchesInOtherWorktrees(dir: string): Promise<Set<string>> {
    const out = await git.run(dir, ["worktree", "list", "--porcelain"]).catch(() => "");
    const busy = new Set<string>();
    for (const line of out.split("\n")) {
        const m = /^branch refs\/heads\/(.+)$/.exec(line.trim());
        if (m) busy.add(m[1]);
    }
    return busy;
}

/** Branches named by a stash entry, whose work is not on the branch itself. */
async function branchesWithStash(dir: string): Promise<Set<string>> {
    const out = await git.run(dir, ["stash", "list", "--format=%gs"]).catch(() => "");
    const held = new Set<string>();
    for (const line of out.split("\n")) {
        const m = /^(?:WIP on|On) ([^:]+):/.exec(line.trim());
        if (m) held.add(m[1].trim());
    }
    return held;
}

/**
 * True when `base` already holds everything `branch` introduces.
 *
 * TWO PROOFS, and the second one is the whole reason this is not a one-liner.
 *
 * ANCESTRY settles the easy case: the branch tip is reachable from base, so base has
 * its commits outright. A squash or a rebase merge breaks that - the commits are
 * rewritten and the tip is an ancestor of nothing - and `git branch --merged` answers
 * "not merged" to a branch that was merged perfectly. Squash merges are the common
 * case in a PR workflow, so stopping at ancestry would refuse to tidy almost
 * everything.
 *
 * CONTENT settles the rest, and it is deliberately not the three-dot diff (the first
 * cut used that and it was WRONG: `base...branch` measures from the MERGE BASE, which
 * a squash merge does not move, so a fully merged branch still showed its own files as
 * added). What actually answers the question: take the files the branch touched, and
 * compare exactly those between base and the branch tip. Empty means base's copy of
 * every file the branch changed is byte-identical to the branch's - the work is in
 * base, whatever the commit graph says.
 *
 * That framing also defeats the case a patch-id check would wave through: if base
 * merged the branch and then REVERTED it, the files differ again and this correctly
 * refuses. Base moving on and editing one of those files also refuses - a false
 * refusal, which costs a branch left behind and never a line of work.
 *
 * A git failure reads as "not contained": the safe answer to a question we could not
 * put is never "go ahead and delete".
 */
async function containedIn(dir: string, base: string, branch: string): Promise<boolean> {
    try {
        const ancestor = await git.runRaw(dir, ["merge-base", "--is-ancestor", branch, base]);
        if (ancestor.code === 0) return true;
    } catch { /* fall through to the content proof */ }

    try {
        const mergeBase = (await git.run(dir, ["merge-base", base, branch])).trim();
        if (!mergeBase) return false;
        const touched = (await git.run(dir, ["diff", "--name-only", mergeBase, branch]))
            .split("\n").map((l) => l.trim()).filter(Boolean);
        if (touched.length === 0) return true;
        const differing = await git.run(dir, ["diff", "--name-only", base, branch, "--", ...touched]);
        if (differing.trim() === "") return true;
    } catch { /* fall through to the merge proof */ }

    // MERGE NO-OP settles what content alone refuses: a squash-merged branch whose files the
    // base has edited SINCE. Merging the branch into base now, with no conflict, produces
    // exactly base's own tree - so base already has everything the branch would bring. A
    // conflict, or any tree change, means it would still add something and is refused. Needs
    // git 2.38+ (`merge-tree --write-tree`); an older git fails here and reads as "not contained".
    try {
        const merged = await git.runRaw(dir, ["merge-tree", "--write-tree", base, branch]);
        if (merged.code !== 0) return false;
        const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
        const baseTree = (await git.run(dir, ["rev-parse", `${base}^{tree}`])).trim();
        return tree !== "" && tree === baseTree;
    } catch { return false; }
}

/**
 * Contained in the remote's default branch OR the local one. Either keeps the work: the
 * remote copy is what everyone else has, and the local one is what the old check accepted.
 * Both are needed because either can be the one ahead - the local branch after a merge not
 * yet pushed, the remote after a PR merged elsewhere - and a failed fetch leaves no way to tell.
 */
async function containedInAny(dir: string, base: string, defaultBranch: string, branch: string): Promise<boolean> {
    if (await containedIn(dir, base, branch)) return true;
    return base !== defaultBranch && await containedIn(dir, defaultBranch, branch);
}

/**
 * The ref to prove containment against. A local default branch is routinely far behind its
 * remote - measured at 560+ commits in two of the author's repositories - and proving against
 * it found almost nothing merged, so the feature silently tidied nothing. The remote copy is
 * refreshed first; offline, or with no such remote, the local branch is used as before.
 */
async function containmentBase(dir: string, remote: string, defaultBranch: string): Promise<string> {
    if (!remote) return defaultBranch;
    try { await git.run(dir, ["fetch", "--quiet", remote, defaultBranch]); } catch { /* offline: use what is there */ }
    const tracked = `${remote}/${defaultBranch}`;
    try {
        await git.run(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${tracked}`]);
        return tracked;
    } catch { return defaultBranch; }
}

/**
 * Decide what may be tidied in `dir`, touching nothing. `remote` is the remote whose
 * copies are considered (default `origin`); pass "" to ignore remotes entirely.
 */
export async function planTidy(dir: string, remote = "origin"): Promise<TidyPlan> {
    const empty = (blocked: string): TidyPlan => ({ defaultBranch: "", currentBranch: "", verdicts: [], blocked });

    let defaultBranch: string;
    try { defaultBranch = await git.defaultBranch(dir, remote || "origin"); }
    catch { return empty("no default branch could be resolved, so nothing can be proved merged"); }
    if (!defaultBranch) return empty("no default branch could be resolved, so nothing can be proved merged");

    const currentBranch = await git.currentBranch(dir).catch(() => "");
    /**
     * Uncommitted changes protect exactly ONE branch: the one checked out here, because
     * that is the only branch whose deletion needs the checkout moved off it. Deleting any
     * other ref does not read or write the working tree at all.
     *
     * This used to block the whole repository, and the blanket was not caution, it was the
     * feature never running. Measured on the author's machine: of 96 automatic cleanups the
     * gate logged, 95 were skipped for this one reason and one for another - a repository
     * an agent is working in is dirty almost all the time, so "clean tree" meant "never".
     * A per-branch refusal keeps every guarantee the blanket had; see the `dirty-worktree`
     * verdict below.
     */
    const dirty = await git.hasUncommittedChanges(dir).catch(() => true);
    const base = await containmentBase(dir, remote, defaultBranch);

    const busy = await branchesInOtherWorktrees(dir);
    const stashed = await branchesWithStash(dir);
    const verdicts: BranchVerdict[] = [];

    for (const branch of await localBranches(dir)) {
        const sha = await git.resolveRef(dir, branch).catch(() => "");
        const verdict = (tidyable: boolean, detail: string, reason?: SkipReason): BranchVerdict =>
            ({ branch, sha, tidyable, reason, detail, remote: false });

        if (branch === defaultBranch) { verdicts.push(verdict(false, "the default branch", "default-branch")); continue; }
        if (PROTECTED.has(branch)) { verdicts.push(verdict(false, "a protected branch name", "protected-name")); continue; }
        if (dirty && branch === currentBranch) {
            verdicts.push(verdict(false, "checked out here, and the working tree has uncommitted changes to move off it first", "dirty-worktree"));
            continue;
        }
        if (busy.has(branch) && branch !== currentBranch) {
            verdicts.push(verdict(false, "checked out in another worktree", "checked-out-elsewhere"));
            continue;
        }
        if (stashed.has(branch)) {
            verdicts.push(verdict(false, "a stash entry is based on it", "has-stash"));
            continue;
        }
        if (!await containedInAny(dir, base, defaultBranch, branch)) {
            verdicts.push(verdict(false, `${base} does not contain all of its work`, "not-contained"));
            continue;
        }

        // The local branch is merged. The REMOTE copy is a separate question: it can
        // hold commits this checkout has never seen, and deleting it would take them
        // with it. Unreadable (offline, no such remote) counts as unverified, and an
        // unverified remote is left in place rather than guessed at.
        let onRemote = false;
        if (remote) {
            let remoteSha: string | null = null;
            try {
                const ls = await git.lsRemote(dir, remote, `refs/heads/${branch}`);
                remoteSha = ls.trim() ? ls.trim().split(/\s+/)[0] : "";
            } catch { remoteSha = null; }

            if (remoteSha === null) {
                verdicts.push({ ...verdict(true, "merged locally; the remote copy could not be read, so it stays", "remote-unverifiable"), remote: false });
                continue;
            }
            if (remoteSha && !await containedInAny(dir, base, defaultBranch, remoteSha)) {
                verdicts.push(verdict(false, `the copy on ${remote} has work ${base} does not contain`, "remote-ahead"));
                continue;
            }
            onRemote = Boolean(remoteSha);
        }
        verdicts.push({ ...verdict(true, `fully contained in ${base}`), remote: onRemote });
    }

    verdicts.sort((a, b) => Number(b.tidyable) - Number(a.tidyable) || a.branch.localeCompare(b.branch));
    return { defaultBranch, baseRef: base, currentBranch, verdicts };
}

export interface TidyOptions {
    /** Remote to clean up too; "" leaves every remote alone. */
    remote?: string;
    /** Produce the plan and report it without touching anything. */
    dryRun?: boolean;
    /** Branch names to consider; empty means every tidyable branch. */
    only?: string[];
    /**
     * Never switch off or delete the branch checked out here. Set by the unattended background
     * run: a branch an agent just created has no commits yet, so it is trivially contained in
     * the default branch, and moving the checkout under a live session would land its next
     * commit on the default branch.
     */
    keepCurrent?: boolean;
}

/**
 * Apply `planTidy`. Switches back to the default branch when the checkout is sitting
 * on one of the branches being removed, then deletes each - local first, remote after
 * - recording the tip in the undo ledger before each deletion.
 *
 * `git branch -d` does the local delete, so git's own merge check runs on top of ours.
 * When git REFUSES, that is not automatically new information: `-d` decides by ancestry,
 * so it says "not fully merged" about every squash-merged branch - the exact case the
 * content proof exists for, and the common one in a PR workflow. Insisting on `-d` would
 * make the feature refuse almost everything it was built to clean up.
 *
 * So a refusal falls back to `-D`, but only after RE-PROVING containment against the
 * repository as it is at that moment. That re-check is the point: it costs one git call
 * and it closes the window between planning and deleting, where a concurrent commit or
 * a fetch could have made the plan stale. If the second proof does not hold, the branch
 * is kept and the disagreement is reported.
 */
export async function tidy(dir: string, opts: TidyOptions = {}): Promise<TidyResult> {
    const remote = opts.remote ?? "origin";
    // A worktree whose directory is gone still pins its branch as "checked out elsewhere".
    // Pruning drops only the records of directories that no longer exist; a live worktree,
    // clean or not, is never touched.
    if (!opts.dryRun) await git.run(dir, ["worktree", "prune"]).catch(() => "");
    // Remote-tracking refs whose branch is gone on the remote: `remote prune` deletes only those
    // local refs, never a branch anywhere, so it costs no work. They are most of what a branch
    // list shows after a PR workflow - measured in one repository, the 40 `origin/*` refs stood
    // for 4 real branches, and the gate's mirror remotes carried 279 more.
    const pruned = opts.dryRun ? 0 : await pruneRemotes(dir);
    let plan = await planTidy(dir, remote);
    const result: TidyResult = { plan, deleted: [], deletedRemote: [], switched: false, problems: [], notes: [], worktrees: [], remoteOnly: [], pruned };
    if (plan.blocked) return result;

    // Abandoned worktrees first: each one pins its branch, so the plan is rebuilt once after
    // removing any, and the branches they held are judged like every other branch.
    const base = plan.baseRef ?? plan.defaultBranch;
    for (const wt of await idleWorktrees(dir, base, plan.defaultBranch)) {
        if (opts.dryRun) { result.worktrees.push(wt.path); continue; }
        try {
            await git.run(dir, ["worktree", "remove", wt.path]);
            result.worktrees.push(wt.path);
        } catch (err) {
            result.problems.push(`kept the worktree ${wt.path}: ${(err as Error).message}`);
        }
    }
    if (result.worktrees.length && !opts.dryRun) {
        plan = await planTidy(dir, remote);
        result.plan = plan;
        if (plan.blocked) return result;
    }

    const wanted = new Set(opts.only ?? []);
    const targets = plan.verdicts.filter((v) => v.tidyable && (wanted.size === 0 || wanted.has(v.branch)) && !(opts.keepCurrent && v.branch === plan.currentBranch));
    const localWork = targets.length > 0 && !opts.dryRun;

    if (localWork && targets.some((v) => v.branch === plan.currentBranch)) {
        try {
            await git.run(dir, ["checkout", plan.defaultBranch]);
            result.switched = true;
        } catch (err) {
            // Without the switch the current branch cannot be deleted, and a failed
            // checkout means the tree is not in the state the plan was built from.
            result.problems.push(`could not switch to ${plan.defaultBranch}: ${(err as Error).message}`);
            return result;
        }
    }

    // Branches that exist only on the remote. A branch with a local copy is never one of them -
    // the local verdict above decides both copies - and a dry run only reports them.
    const remoteOnly = await remoteOnlyBranches(dir, remote, plan);
    // An unreadable PR list is a normal state (no gh, not GitHub), not a failure: the branches
    // are simply kept, and the report says why without turning the exit code red.
    if (remoteOnly.note) result.notes.push(remoteOnly.note);
    for (const target of remoteOnly.verdicts) {
        if (wanted.size && !wanted.has(target.branch)) continue;
        if (opts.dryRun) { result.remoteOnly.push({ branch: target.branch, sha: target.sha }); continue; }
        try {
            recordDeletion(dir, { branch: target.branch, sha: target.sha, remote: true });
            await git.run(dir, ["push", remote, "--delete", target.branch]);
            result.deletedRemote.push(target.branch);
            result.remoteOnly.push({ branch: target.branch, sha: target.sha });
        } catch (err) {
            result.problems.push(`kept ${target.branch} on ${remote}: ${(err as Error).message}`);
        }
    }

    for (const target of localWork ? targets : []) {
        try {
            recordDeletion(dir, { branch: target.branch, sha: target.sha, remote: target.remote });
        } catch (err) {
            result.problems.push(`kept ${target.branch}: its restore point could not be recorded (${(err as Error).message})`);
            continue;
        }
        try {
            await git.run(dir, ["branch", "-d", target.branch]);
            result.deleted.push(target.branch);
        } catch {
            // git's ancestry check refused. Re-prove containment by content NOW, against
            // the live repository, and only force the delete if it still holds.
            const base = plan.baseRef ?? plan.defaultBranch;
            if (!await containedInAny(dir, base, plan.defaultBranch, target.branch)) {
                result.problems.push(`kept ${target.branch}: ${base} no longer contains all of its work`);
                continue;
            }
            try {
                await git.run(dir, ["branch", "-D", target.branch]);
                result.deleted.push(target.branch);
            } catch (err) {
                result.problems.push(`kept ${target.branch}: git refused to delete it (${(err as Error).message})`);
                continue;
            }
        }
        if (!target.remote || !remote) continue;
        try {
            await git.run(dir, ["push", remote, "--delete", target.branch]);
            result.deletedRemote.push(target.branch);
        } catch (err) {
            result.problems.push(`${target.branch} is gone locally but still on ${remote} (${(err as Error).message})`);
        }
    }
    return result;
}

/** The command that puts a deleted branch back, for the report. */
export function restoreCommand(branch: string, sha: string): string {
    return `git branch ${branch} ${sha}`;
}

/** How often a repository is tidied in the background, at most. */
const BACKGROUND_TIDY_EVERY_MS = 60 * 60 * 1000;

/**
 * Whether `repoRoot` is due a background tidy, claiming the slot when it is. The marker is
 * written BEFORE the spawn, so a child that cannot start costs one attempt an hour rather
 * than one per turn; a marker dated in the future (a clock change) counts as expired.
 */
export function claimBackgroundTidy(repoRoot: string, now = Date.now()): boolean {
    const key = createHash("sha1").update(repoRoot.toLowerCase()).digest("hex").slice(0, 16);
    const marker = join(enigmaHome(), ".enigma", "tidy", key);
    try {
        const age = now - statSync(marker).mtimeMs;
        if (age >= 0 && age < BACKGROUND_TIDY_EVERY_MS) return false;
    } catch { /* never tidied: due now */ }
    try {
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, String(now));
    } catch { /* an unwritable marker costs the throttle, never the cleanup */ }
    return true;
}

/**
 * Tidy `repoRoot` in a detached child, at most once an hour per repository. Called from the
 * turn-end hook, which already runs every turn: a branch merged outside a gate run (the
 * GitHub button after the run timed out, an agent's own PR, a branch no gate ever saw) is
 * otherwise left behind until someone asks. Never on the critical path - the marker is one
 * stat, and the child does the fetch, the proofs and the deletes after the turn has ended.
 * Gated on `gateTidyBranches`, the same switch as the gate's own pass.
 */
export function scheduleBackgroundTidy(repoRoot: string, enabled: boolean): void {
    // ENIGMA_NO_BACKGROUND_TIDY turns it off for one process (a test suite driving the hook).
    if (!enabled || !repoRoot || process.env.ENIGMA_NO_BACKGROUND_TIDY || !claimBackgroundTidy(repoRoot)) return;
    try {
        // A compiled binary takes the command directly; node/bun on the source entry need the
        // entry path first (the same dispatch ci-watch.ts documents).
        const exe = basename(process.execPath).toLowerCase();
        const dev = exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe";
        const args = ["branches", "tidy", "--keep-current", "--cwd", repoRoot];
        const child = spawn(process.execPath, dev ? [process.argv[1]!, ...args] : args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => { /* the cleanup just did not run this hour */ });
        child.unref();
    } catch { /* a convenience; a hook must never fail the turn over it */ }
}

/**
 * Branches that exist only on `remote`, are fully contained in `base`, and were merged through a
 * pull request - the dead branches a PR workflow leaves on the remote after a squash merge from
 * the web, which no local branch ever represented. A remote branch is someone's work until proved
 * otherwise, so each condition must be SHOWN, never assumed:
 * - the remote-tracking ref must exist locally at the very sha the remote reports, or there is
 *   nothing to prove containment against (no fetch is forced here);
 * - the PR list must be readable (`gh pr list`); when it is not - no gh, not GitHub, not logged
 *   in - every remote-only branch is kept;
 * - no PR on the branch is open, and a merged PR from this repository had it as its head at
 *   this very sha. Containment alone is not enough: a long-lived shared branch (staging, a
 *   deploy branch, a teammate's branch pushed before its first commit) is contained in the
 *   default branch every time it is fast-forwarded, and is nobody's leftover.
 */
export async function remoteOnlyBranches(dir: string, remote: string, plan: TidyPlan, listPRs: (dir: string) => Promise<PRHeads | null> = prHeads): Promise<{ verdicts: BranchVerdict[]; note?: string; }> {
    if (!remote || plan.blocked) return { verdicts: [] };
    const base = plan.baseRef ?? plan.defaultBranch;
    const local = new Set(await localBranches(dir));
    const heads = await git.run(dir, ["ls-remote", "--heads", remote]).catch(() => null);
    if (heads === null) return { verdicts: [], note: `${remote} could not be read, so its branches were left alone` };
    const prs = await listPRs(dir);
    if (prs === null) return { verdicts: [], note: `pull requests could not be listed (gh), so branches that exist only on ${remote} were left alone` };
    const verdicts: BranchVerdict[] = [];
    for (const line of heads.split("\n")) {
        const [sha = "", ref = ""] = line.trim().split(/\s+/);
        const branch = ref.replace("refs/heads/", "");
        if (!sha || !branch || local.has(branch) || branch === plan.defaultBranch || PROTECTED.has(branch) || prs.open.has(branch)) continue;
        if (!prs.merged.get(branch)?.has(sha)) continue;
        const tracking = await git.resolveRef(dir, `refs/remotes/${remote}/${branch}`).catch(() => "");
        if (tracking !== sha) continue;
        if (!await containedInAny(dir, base, plan.defaultBranch, sha)) continue;
        verdicts.push({ branch, sha, tidyable: true, detail: `only on ${remote}, fully contained in ${base}, merged by a PR at this commit`, remote: true });
    }
    return { verdicts };
}

/** Runs `git remote prune` for every remote and returns how many tracking refs it removed. */
async function pruneRemotes(dir: string): Promise<number> {
    const remotes = (await git.run(dir, ["remote"]).catch(() => "")).split("\n").map((r) => r.trim()).filter(Boolean);
    let pruned = 0;
    for (const r of remotes) {
        const out = await git.run(dir, ["remote", "prune", r]).catch(() => "");
        pruned += out.split("\n").filter((l) => l.includes("[pruned]")).length;
    }
    return pruned;
}

export interface PRHeads {
    /** Head branch names of the open PRs. */
    open: Set<string>;
    /** Head branch name -> the head shas it was merged at, for PRs from this repository. */
    merged: Map<string, Set<string>>;
}

/** The repository's PR heads, open and merged, or null when they cannot be listed. */
async function prHeads(dir: string): Promise<PRHeads | null> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolveHeads) => {
        execFile("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,headRefOid,state,isCrossRepository"], { cwd: dir, windowsHide: true, timeout: 30_000 }, (err, stdout) => {
            if (err) return resolveHeads(null);
            try {
                const rows = JSON.parse(String(stdout)) as Array<{ headRefName?: unknown; headRefOid?: unknown; state?: unknown; isCrossRepository?: unknown; }>;
                if (!Array.isArray(rows)) return resolveHeads(null);
                const heads: PRHeads = { open: new Set(), merged: new Map() };
                for (const row of rows) {
                    const branch = String(row.headRefName ?? "");
                    if (!branch) continue;
                    if (row.state === "OPEN") heads.open.add(branch);
                    if (row.state !== "MERGED" || row.isCrossRepository !== false || typeof row.headRefOid !== "string") continue;
                    if (!heads.merged.has(branch)) heads.merged.set(branch, new Set());
                    heads.merged.get(branch)!.add(row.headRefOid);
                }
                resolveHeads(heads);
            } catch {
                resolveHeads(null);
            }
        });
    });
}
