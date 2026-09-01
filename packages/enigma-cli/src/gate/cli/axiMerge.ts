/**
 * The agent-facing `axi merge` command: merges the run's PR when the user asked
 * for it, and waits for the pipeline to close.
 *
 * Why it exists: once CI is green the `ci` step keeps polling until the PR is
 * merged or closed, so the run sits there - `running`, making no progress - until
 * a person acts. The default is still that the person is the user (the gate opens
 * the PR and leaves it for review). But when the user has said "merge it", the
 * agent needs a way to do exactly that without reaching for raw provider commands,
 * and the pipeline needs to end up in the same place as if a human had clicked
 * merge: the `ci` step observes the merged PR on its next poll and completes.
 *
 * The safety bar is the provider's own view of the PR, not the run's logs: a PR
 * with failing or still-running checks is refused unless the caller passes
 * `--force`, because "merge it" said before CI finished is not consent to merge a
 * red branch.
 */

import * as scm from "../scm/types";
import { buildHostFor } from "../pipeline/steps/host";
import { type Run, getRun, getStepsByRun } from "../db";
import { field, toonHelp, type ToonField } from "../toon";
import { currentBranchForRunResolve, resolveRun } from "./axiQuery";
import { detectProvider, PROVIDER_UNKNOWN, type Provider } from "../scm/host";
import {
    type AxiEnv,
    type AxiDeps,
    sleep,
    errMessage,
    openAxiEnv,
    repoInitHelp
} from "./axiEnv";
import {
    type AxiIO,
    emitDoc,
    emitError,
    outcomeFor,
    runObjectField,
    runViewFromDB,
    terminalStatus
} from "./axiRender";

/** How long to wait for the pipeline to notice the merge before reporting anyway. */
const RUN_SETTLE_TIMEOUT = 180_000;

/** How often the settle wait re-reads the run. */
const RUN_SETTLE_POLL = 1_000;

/** Arguments for `axi merge`, already parsed. */
export interface MergeArgs {
    /** Explicit run id; empty resolves the current branch's run. */
    run: string;
    /** Merge method; empty uses the default (squash). */
    method: string;
    /** Merge even when checks are failing or still running. */
    force: boolean;
}

/** The provider a run's PR lives on, preferring the remote over the PR URL. */
function providerFor(upstreamUrl: string, prUrl: string | null): Provider {
    const fromRemote = detectProvider(upstreamUrl);
    if (fromRemote !== PROVIDER_UNKNOWN) return fromRemote;
    return prUrl === null ? PROVIDER_UNKNOWN : detectProvider(prUrl);
}

/** Names the checks that would make merging premature, grouped by why. */
interface CheckBlockers {
    failing: string[];
    pending: string[];
}

/** Splits checks into the ones that failed and the ones still running. */
function checkBlockers(checks: scm.Check[]): CheckBlockers {
    const failing: string[] = [];
    const pending: string[] = [];
    for (const c of checks) {
        if (c.bucket === scm.CHECK_BUCKET_FAIL) failing.push(c.name);
        else if (c.bucket === scm.CHECK_BUCKET_PENDING) pending.push(c.name);
    }
    failing.sort();
    pending.sort();
    return { failing, pending };
}

/** The outcome of merging one PR. */
export interface MergeOutcome {
    /** True when this call merged the PR; false when it was already merged. */
    merged: boolean;
    method: scm.MergeMethod;
    prURL: string;
}

/**
 * Merges the run's PR through its provider, after checking the provider's own view
 * of the PR. Throws with a user-facing message when the PR cannot or should not be
 * merged; `force` skips only the check-state bar, never a closed PR or a conflict,
 * since neither is something a flag can make true.
 */
export async function mergeRunPR(
    repo: { workingPath: string; upstreamUrl: string; forkUrl: string; },
    runPrUrl: string | null,
    method: scm.MergeMethod,
    force: boolean,
    signal?: AbortSignal
): Promise<MergeOutcome> {
    const prURL = runPrUrl ?? "";
    if (prURL === "") throw new Error("this run has no PR to merge");

    const provider = providerFor(repo.upstreamUrl, runPrUrl);
    const [host, reason] = buildHostFor({
        workDir: repo.workingPath,
        env: [],
        signal,
        upstreamUrl: repo.upstreamUrl,
        forkUrl: repo.forkUrl,
        prUrl: runPrUrl
    }, provider);
    if (host === null) throw new Error(`cannot merge: ${reason}`);
    await host.available(signal);

    const pr: scm.PR = { number: scm.extractPRNumber(prURL), url: prURL };

    const state = await host.getPRState(pr, signal);
    if (state === scm.PR_STATE_MERGED) return { merged: false, method, prURL };
    if (state === scm.PR_STATE_CLOSED) throw new Error(`PR ${prURL} is closed, so there is nothing to merge`);

    if (!force) {
        const { failing, pending } = checkBlockers(await host.getChecks(pr, signal));
        if (failing.length > 0) {
            throw new Error(`CI is failing on this PR (${failing.join(", ")}) - fix it, or pass --force to merge anyway`);
        }
        if (pending.length > 0) {
            throw new Error(`CI has not finished on this PR (${pending.join(", ")}) - wait for it, or pass --force to merge anyway`);
        }
    }

    if (host.capabilities().mergeableState) {
        let mergeable: scm.MergeableState = scm.MERGEABLE_UNKNOWN;
        try {
            mergeable = await host.getMergeableState(pr, signal);
        } catch {
            // An unreadable mergeable state is not evidence of a conflict; the
            // provider refuses the merge itself if there is one.
        }
        if (mergeable === scm.MERGEABLE_CONFLICT) {
            throw new Error(`PR ${prURL} has merge conflicts - resolve them first`);
        }
    }

    await host.mergePR(pr, method, signal);
    return { merged: true, method, prURL };
}

/**
 * Waits for the pipeline to notice the merged PR and finish, returning the run as
 * it stands when it settles or when the wait runs out. The `ci` step polls on a
 * backoff, so this can take a couple of minutes; timing out is not a failure, it
 * just means the run closes on its own after this command returns.
 */
async function waitForRunToSettle(env: AxiEnv, runID: string, signal?: AbortSignal): Promise<Run | null> {
    const deadline = Date.now() + RUN_SETTLE_TIMEOUT;
    for (;;) {
        const run = getRun(env.d, runID);
        if (run === null || terminalStatus(run.status)) return run;
        if (Date.now() >= deadline) return run;
        await sleep(RUN_SETTLE_POLL, signal);
    }
}

/** Renders the merged outcome, plus the run once it has settled. */
function emitMergeResult(io: AxiIO, env: AxiEnv, run: Run, outcome: MergeOutcome): number {
    const fields: ToonField[] = [];
    const steps = getStepsByRun(env.d, run.id);
    fields.push(runObjectField(runViewFromDB(run, steps)));
    fields.push(field("outcome", outcome.merged ? "merged" : "already-merged"));
    fields.push(field("pr", outcome.prURL));
    fields.push(field("method", outcome.method));

    const help: string[] = [];
    if (terminalStatus(run.status)) {
        help.push(`The PR is merged and the run finished (${outcomeFor(run.status)}). Summarize for the user what the pipeline validated and that the branch is now in.`);
    } else {
        // The wait already gave the ci step longer than its slowest poll interval, so
        // a run still open here is not just slow - promising it closes "in a moment"
        // would be a guess. Say what is true and where to look.
        help.push("The PR is merged, but the run has not closed yet. Report the merge; check `enigma gate axi status` if the run matters, since a stopped daemon never observes the merged PR.");
    }
    fields.push(toonHelp(help));
    emitDoc(io, fields);
    return 0;
}

/**
 * Merges the PR of the resolved run. Only ever run when the user asked for the
 * merge: the gate's default is to leave a validated PR for them to review.
 */
export async function runAxiMerge(deps: AxiDeps, args: MergeArgs): Promise<number> {
    const methodArg = args.method.trim();
    if (methodArg !== "" && !scm.isMergeMethod(methodArg)) {
        return emitError(deps.io, 2, `unknown merge method "${methodArg}"`,
            `Valid methods: ${scm.MERGE_METHODS.join(", ")}`);
    }
    const method: scm.MergeMethod = methodArg === "" ? scm.DEFAULT_MERGE_METHOD : methodArg;

    let env: AxiEnv;
    try {
        env = await openAxiEnv(deps, false);
    } catch (err) {
        return emitError(deps.io, 1, errMessage(err), ...repoInitHelp(err));
    }
    try {
        let run: Run | null;
        try {
            run = resolveRun(env, args.run.trim(), await currentBranchForRunResolve(deps.signal));
        } catch (err) {
            return emitError(deps.io, 1, errMessage(err));
        }
        if (run === null) {
            return emitError(deps.io, 1, "no run to merge in this repository",
                "Run `enigma gate axi run --intent \"<what the user set out to accomplish>\"` first");
        }
        if (run.repoId !== env.repo.id) {
            // The gate database is global, so an id from another checkout resolves
            // here just fine - and the merge would then be aimed at the CURRENT
            // repository, because that is where the provider slug comes from. There
            // is no undoing a PR merged in the wrong repository, so refuse.
            return emitError(deps.io, 1, `run ${run.id} belongs to another repository`,
                "Run `enigma gate axi merge` from that repository's checkout, or drop --run to use this one's run");
        }
        if ((run.prUrl ?? "") === "") {
            return emitError(deps.io, 1, `run ${run.id} has no PR to merge`,
                "A run on the default branch pushes straight to it and opens no PR, so there is nothing to merge");
        }

        let outcome: MergeOutcome;
        try {
            outcome = await mergeRunPR(env.repo, run.prUrl, method, args.force, deps.signal);
        } catch (err) {
            return emitError(deps.io, 1, errMessage(err), `PR: ${run.prUrl}`);
        }

        const settled = (await waitForRunToSettle(env, run.id, deps.signal)) ?? run;
        return emitMergeResult(deps.io, env, settled, outcome);
    } finally {
        env.close();
    }
}
