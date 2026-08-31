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

import { join } from "node:path";
import * as git from "./gate/git";
import { enigmaHome } from "./util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
    /** Branch the checkout is on right now ("" when detached). */
    currentBranch: string;
    /** Every local branch with its verdict, tidyable ones first. */
    verdicts: BranchVerdict[];
    /**
     * Set when the whole repository is off limits - a dirty worktree, no default
     * branch, a detached HEAD. Nothing is touched while this is set.
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
        return differing.trim() === "";
    } catch { return false; }
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
    if (await git.hasUncommittedChanges(dir).catch(() => true)) {
        return { defaultBranch, currentBranch, verdicts: [], blocked: "the working tree has uncommitted changes" };
    }

    const busy = await branchesInOtherWorktrees(dir);
    const stashed = await branchesWithStash(dir);
    const verdicts: BranchVerdict[] = [];

    for (const branch of await localBranches(dir)) {
        const sha = await git.resolveRef(dir, branch).catch(() => "");
        const verdict = (tidyable: boolean, detail: string, reason?: SkipReason): BranchVerdict =>
            ({ branch, sha, tidyable, reason, detail, remote: false });

        if (branch === defaultBranch) { verdicts.push(verdict(false, "the default branch", "default-branch")); continue; }
        if (PROTECTED.has(branch)) { verdicts.push(verdict(false, "a protected branch name", "protected-name")); continue; }
        if (busy.has(branch) && branch !== currentBranch) {
            verdicts.push(verdict(false, "checked out in another worktree", "checked-out-elsewhere"));
            continue;
        }
        if (stashed.has(branch)) {
            verdicts.push(verdict(false, "a stash entry is based on it", "has-stash"));
            continue;
        }
        if (!await containedIn(dir, defaultBranch, branch)) {
            verdicts.push(verdict(false, `${defaultBranch} does not contain all of its work`, "not-contained"));
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
            if (remoteSha && !await containedIn(dir, defaultBranch, remoteSha)) {
                verdicts.push(verdict(false, `the copy on ${remote} has work ${defaultBranch} does not contain`, "remote-ahead"));
                continue;
            }
            onRemote = Boolean(remoteSha);
        }
        verdicts.push({ ...verdict(true, `fully contained in ${defaultBranch}`), remote: onRemote });
    }

    verdicts.sort((a, b) => Number(b.tidyable) - Number(a.tidyable) || a.branch.localeCompare(b.branch));
    return { defaultBranch, currentBranch, verdicts };
}

export interface TidyOptions {
    /** Remote to clean up too; "" leaves every remote alone. */
    remote?: string;
    /** Produce the plan and report it without touching anything. */
    dryRun?: boolean;
    /** Branch names to consider; empty means every tidyable branch. */
    only?: string[];
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
    const plan = await planTidy(dir, remote);
    const result: TidyResult = { plan, deleted: [], deletedRemote: [], switched: false, problems: [] };
    if (plan.blocked) return result;

    const wanted = new Set(opts.only ?? []);
    const targets = plan.verdicts.filter((v) => v.tidyable && (wanted.size === 0 || wanted.has(v.branch)));
    if (targets.length === 0 || opts.dryRun) return result;

    if (targets.some((v) => v.branch === plan.currentBranch)) {
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

    for (const target of targets) {
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
            if (!await containedIn(dir, plan.defaultBranch, target.branch)) {
                result.problems.push(`kept ${target.branch}: ${plan.defaultBranch} no longer contains all of its work`);
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
