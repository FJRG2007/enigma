/**
 * CI monitoring step: babysits an open PR until it is merged, closed, the run is
 * cancelled, or its configured idle timeout elapses, auto-fixing CI failures and
 * rebasing on merge conflicts. Faithful port of the upstream
 * `internal/pipeline/steps/ci.go`.
 *
 * Go's `context.Context` maps to `sctx.signal`; `time.Ticker`/`time.After` map to
 * the signal-aware `sleep` helper; `(value, error)` returns map to throw. Time is
 * represented as millisecond epochs (`now()` returns a number) and durations are
 * milliseconds, consistent with the rest of the port.
 *
 * Idle-timeout re-arm: `timeoutAnchor` advances to `now()` whenever the upstream
 * default-branch tip advances, while `started` stays fixed so poll-interval and
 * grace-period pacing are unaffected. Re-arming only ever extends the deadline.
 */

import { log } from "@/gate/log";
import { getRun } from "@/gate/db";
import { buildHost } from "./host";
import { autoFixCI } from "./ciFix";
import * as ciChecks from "./ciChecks";
import * as scm from "@/gate/scm/types";
import { DEFAULT_CI_TIMEOUT } from "@/gate/config";
import { type StepName, STEP_CI } from "@/gate/types";
import { resolveDefaultBranchTip } from "./commonGit";
import { type Provider, detectProvider, PROVIDER_UNKNOWN } from "@/gate/scm/host";
import { type Step, type StepContext, type StepOutcome, newStepOutcome } from "../types";

/** Minimum wait (ms) before trusting empty CI checks. */
const DEFAULT_CHECKS_GRACE_PERIOD = 60 * 1000;

/** Window (ms) allotted to resolving the upstream default-branch tip per poll. */
const DEFAULT_BASE_BRANCH_TIP_RESOLVE_WINDOW = 30 * 1000;

// CI monitoring status messages. Surfaced to the user and parsed by the TUI and
// the agent-facing commands to distinguish passed checks from checks still
// running. The canonical strings live in upstream's cimonitor package (not yet
// ported); the literals are mirrored here so producers and consumers agree.
const CI_CHECKS_PASSED_MSG = "all CI checks passed - still monitoring until merged or closed";
const CI_NO_CHECKS_PASSED_MSG = "no CI checks reported - still monitoring until merged or closed";
const CI_CHECKS_RUNNING_MSG = "CI checks running, waiting for results...";

/**
 * What the run is waiting for once CI is green: a person to merge the PR. The step
 * stays `running` through that wait, so without this marker the status bar animates
 * a step that is doing nothing and the user is never told the pipeline is on them.
 */
const CI_MERGE_BLOCK_REASON = "merge the PR";

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Returns the cancel cause carried by an aborted signal, mirroring ctx.Err(). */
function signalError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error && reason.name !== "AbortError") return reason;
    if (typeof reason === "string" && reason !== "") return new Error(reason);
    return new Error("context canceled");
}

/** Resolves after ms unless the signal aborts first, in which case it rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signalError(signal));
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signalError(signal));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** Reports whether the state indicates a known merge conflict. */
function mergeStateConflict(s: scm.MergeableState): boolean {
    return s === scm.MERGEABLE_CONFLICT;
}

/** Reports whether the state is final (MERGEABLE or CONFLICTING). */
function mergeStateResolved(s: scm.MergeableState): boolean {
    return s === scm.MERGEABLE_OK || s === scm.MERGEABLE_CONFLICT;
}

/** Truncates a SHA to its first 12 characters for log readability. */
function shortSHA(sha: string): string {
    if (sha.length <= 12) return sha;
    return sha.slice(0, 12);
}

/**
 * Formats a millisecond duration as Go's `time.Duration.String()` for the
 * timeout log line (e.g. 7 days -> "168h0m0s"). Covers the second-and-above
 * durations the gate uses; sub-second durations render in whole milliseconds.
 */
function formatGoDuration(ms: number): string {
    const neg = ms < 0;
    const u = Math.abs(Math.trunc(ms));
    let out: string;
    if (u < 1000) {
        if (u === 0) return "0s";
        out = `${u}ms`;
    } else {
        const msPart = u % 1000;
        const secs = Math.floor(u / 1000);
        const s = secs % 60;
        const totalMinutes = Math.floor(secs / 60);
        let secField: string;
        if (msPart === 0) {
            secField = `${s}`;
        } else {
            const frac = String(msPart).padStart(3, "0").replace(/0+$/, "");
            secField = `${s}.${frac}`;
        }
        out = `${secField}s`;
        if (totalMinutes > 0) {
            const m = totalMinutes % 60;
            const totalHours = Math.floor(totalMinutes / 60);
            out = `${m}m${out}`;
            if (totalHours > 0) out = `${totalHours}h${out}`;
        }
    }
    return neg ? `-${out}` : out;
}

/** Logs message only when it differs from the previous one; returns message. */
function logCIMonitorStatus(sctx: StepContext, message: string, previous: string): string {
    if (message !== previous) sctx.log(message);
    return message;
}

/**
 * Monitors an open PR until it is merged, closed, or its configured idle timeout
 * elapses, auto-fixing CI failures. The injectable fields mirror the Go struct's
 * test seams (clock, poll wait, base-tip resolver, grace period, poll interval).
 */
export class CIStep implements Step {
    /** Sorted check names from the last fix attempt, to avoid re-fixing. */
    private lastFixedChecks = "";
    /** Failing-check completion times seen before the last fix attempt. */
    private lastFixedCompletedAt: Map<string, Date> | null = null;
    /** Number of CI auto-fix attempts made. */
    private ciFixAttempts = 0;

    /** Minimum wait (ms) before trusting empty CI checks (0 = default 60s). */
    checksGracePeriod = 0;
    /** When >0, overrides the computed poll interval (ms; for testing). */
    pollIntervalOverride = 0;
    /** When set, overrides the signal-aware poll wait (for testing). */
    waitForNextPoll?: (signal: AbortSignal, intervalMS: number) => Promise<void>;
    /** When set, overrides the millisecond-epoch clock (for testing). */
    now?: () => number;
    /**
     * Resolves the current tip SHA of the upstream default branch. The boolean
     * is false when the SHA is a fallback/unknown value and must not re-arm the
     * timeout. Overridable for testing; defaults to fetching the upstream branch.
     */
    baseBranchTip?: (signal: AbortSignal) => Promise<[string, boolean]>;

    name(): StepName {
        return STEP_CI;
    }

    private gracePeriod(): number {
        if (this.checksGracePeriod > 0) return this.checksGracePeriod;
        return DEFAULT_CHECKS_GRACE_PERIOD;
    }

    async execute(sctx: StepContext): Promise<StepOutcome> {
        const signal = sctx.signal;
        if (signal.aborted) throw signalError(signal);

        let provider: Provider = detectProvider(sctx.repo.upstreamUrl);
        if (provider === PROVIDER_UNKNOWN && sctx.run.prUrl !== null) {
            provider = detectProvider(sctx.run.prUrl);
        }
        const [host, skipReason] = buildHost(sctx, provider);
        if (host === null) {
            sctx.log(`skipping CI: ${skipReason}`);
            return newStepOutcome({ skipped: true });
        }
        try {
            await host.available(signal);
        } catch (err) {
            sctx.log(`skipping CI: ${errMessage(err)}`);
            return newStepOutcome({ skipped: true });
        }

        // Get PR URL from run record.
        let prURL = "";
        if (sctx.run.prUrl !== null) prURL = sctx.run.prUrl;
        if (prURL === "") {
            // Try to refresh from DB in case the PR step set it.
            const run = getRun(sctx.db, sctx.run.id);
            if (run !== null && run.prUrl !== null) {
                prURL = run.prUrl;
                sctx.run.prUrl = run.prUrl;
            }
        }
        if (prURL === "") {
            sctx.log("no PR URL found, skipping CI");
            return newStepOutcome({ skipped: true });
        }

        let prNumber: string;
        try {
            prNumber = scm.extractPRNumber(prURL);
        } catch (err) {
            throw new Error(`extract PR number: ${errMessage(err)}`);
        }
        const pr: scm.PR = { number: prNumber, url: prURL };

        // CITimeout semantics: <0 means never self-terminate; 0 means the value
        // was never configured, so fall back to the default; >0 is an explicit
        // finite idle timeout.
        let timeout = sctx.config.ciTimeout;
        const unlimited = timeout < 0;
        if (timeout === 0) timeout = DEFAULT_CI_TIMEOUT;

        if (unlimited) {
            sctx.log(`monitoring CI for PR #${prNumber} (no timeout, until merged or closed)...`);
        } else {
            sctx.log(`monitoring CI for PR #${prNumber} (timeout: ${formatGoDuration(timeout)})...`);
        }

        const now = this.now ?? ((): number => Date.now());
        const baseBranchTip =
            this.baseBranchTip ??
            ((sig: AbortSignal): Promise<[string, boolean]> =>
                resolveDefaultBranchTip(
                    sig,
                    sctx.workDir,
                    sctx.repo.upstreamUrl,
                    sctx.run.baseSha,
                    sctx.repo.defaultBranch
                ));
        const waitForNextPoll =
            this.waitForNextPoll ?? ((sig: AbortSignal, intervalMS: number): Promise<void> => sleep(intervalMS, sig));

        const started = now();
        // timeoutAnchor is the point the idle timeout is measured from. It re-arms
        // to now() whenever the base branch advances, while started stays fixed so
        // poll-interval and grace-period pacing are unaffected by re-arming.
        let timeoutAnchor = started;
        let lastBaseTip = "";
        let manualFixAttempted = false;
        let mergeabilityBlockedReason = "";
        let timeoutFailingChecks: string[] = [];
        let timeoutMergeConflict = false;
        let lastMonitorLog = "";
        const timeoutOutcome = (): StepOutcome => {
            sctx.log("CI timeout reached");
            if (timeoutFailingChecks.length > 0 || timeoutMergeConflict) {
                return ciChecks.ciFailureOutcome(
                    timeoutFailingChecks,
                    timeoutMergeConflict,
                    "CI timed out with known failures still present"
                );
            }
            if (mergeabilityBlockedReason !== "") {
                return ciChecks.ciMergeabilityOutcome("mergeability check timed out", mergeabilityBlockedReason);
            }
            return ciChecks.ciMonitoringTimeoutOutcome();
        };

        for (;;) {
            if (signal.aborted) throw signalError(signal);

            // Set once per poll, from what this poll actually observed: green checks
            // on an open PR mean the pipeline is waiting on a human merge. Anything
            // else - failures, re-running checks, an unreadable PR - is the pipeline's
            // own work again, so the marker clears.
            let waitingOnMerge = false;

            if (!unlimited && now() - timeoutAnchor >= timeout) {
                return timeoutOutcome();
            }

            // Re-arm the timeout whenever the base branch advances.
            if (!unlimited) {
                let resolveWindow = DEFAULT_BASE_BRANCH_TIP_RESOLVE_WINDOW;
                const remaining = timeout - (now() - timeoutAnchor);
                if (remaining <= 0) {
                    return timeoutOutcome();
                } else if (remaining < resolveWindow) {
                    resolveWindow = remaining;
                }
                const tipSignal = AbortSignal.any([signal, AbortSignal.timeout(resolveWindow)]);
                // The resolve window is this loop's own deadline: expiring it aborts
                // the lookup, which is a skipped poll, not a run failure.
                let tip = "";
                let resolved = false;
                try {
                    [tip, resolved] = await baseBranchTip(tipSignal);
                } catch (err) {
                    if (signal.aborted) throw signalError(signal);
                    log.warn("resolve base branch tip", "err", errMessage(err));
                }
                if (resolved && tip !== "") {
                    if (lastBaseTip === "") {
                        lastBaseTip = tip;
                    } else if (tip !== lastBaseTip) {
                        sctx.log(
                            `base branch advanced (${shortSHA(lastBaseTip)}..${shortSHA(tip)}), re-arming CI monitor timeout`
                        );
                        timeoutAnchor = now();
                        lastBaseTip = tip;
                    }
                }
            }

            const elapsed = now() - started;
            if (!unlimited && now() - timeoutAnchor >= timeout) {
                return timeoutOutcome();
            }

            // Check PR state (merged/closed -> exit).
            let prStateKnown = true;
            try {
                const state: scm.PRState = await host.getPRState(pr, signal);
                if (state === scm.PR_STATE_MERGED) {
                    sctx.log("PR has been merged!");
                    return newStepOutcome({});
                } else if (state === scm.PR_STATE_CLOSED) {
                    sctx.log("PR has been closed");
                    return newStepOutcome({});
                }
            } catch (err) {
                sctx.log(`warning: could not check PR state: ${errMessage(err)}`);
                prStateKnown = false;
            }

            // Check mergeable state if the provider supports it.
            let mergeConflict = false;
            let mergeabilityKnown = true;
            if (host.capabilities().mergeableState) {
                try {
                    const mergeState: scm.MergeableState = await host.getMergeableState(pr, signal);
                    mergeConflict = mergeStateConflict(mergeState);
                    mergeabilityKnown = mergeStateResolved(mergeState);
                    if (!mergeabilityKnown) {
                        sctx.log(`mergeable state still pending: ${mergeState}`);
                        mergeabilityBlockedReason = `PR mergeability remained unresolved before timeout: ${mergeState}`;
                    } else {
                        mergeabilityBlockedReason = "";
                        timeoutMergeConflict = mergeConflict;
                    }
                } catch (err) {
                    sctx.log(`warning: could not check mergeable state: ${errMessage(err)}`);
                    mergeabilityBlockedReason = "";
                    mergeabilityKnown = false;
                }
            }

            // Check CI status - wait for all checks to complete before fixing.
            const ciFixLimit = sctx.config.autoFix.ci;
            let checks: scm.Check[] | null = null;
            try {
                checks = await host.getChecks(pr, signal);
            } catch (err) {
                lastMonitorLog = "";
                sctx.log(`warning: could not check CI: ${errMessage(err)}`);
            }
            if (checks !== null) {
                const pending = ciChecks.hasPendingChecks(checks);
                const failing = ciChecks.failingCheckNames(checks);
                failing.sort();
                const hasFailures = failing.length > 0;
                const hasIssues = hasFailures || mergeConflict;
                timeoutFailingChecks = failing.slice();

                // If a failing check completed after our last fix push, CI has
                // already re-run since we pushed (possibly too fast to observe as
                // pending between polls). Treat this as a new iteration so the
                // retry path can fire rather than looping on "fix already
                // attempted" until timeout.
                if (ciChecks.failingCheckCompletedAfter(checks, this.lastFixedCompletedAt)) {
                    this.lastFixedChecks = "";
                    this.lastFixedCompletedAt = null;
                }

                if (hasIssues && pending) {
                    lastMonitorLog = "";
                    if (ciChecks.pendingCheckMatchesLastFixed(checks, this.lastFixedChecks)) {
                        this.lastFixedChecks = "";
                        this.lastFixedCompletedAt = null;
                    }
                    sctx.log("issues detected but checks still pending, waiting for all checks to complete...");
                } else if (hasIssues) {
                    lastMonitorLog = "";
                    // All checks done, issues present - fix or report.
                    const fixKey = ciChecks.encodeLastFixedChecks(failing, mergeConflict);
                    const fixCompletedAt = ciChecks.failingCheckCompletionTimes(checks);
                    let issueDesc = failing.join(", ");
                    if (mergeConflict) {
                        if (issueDesc !== "") {
                            issueDesc += " + merge conflict";
                        } else {
                            issueDesc = "merge conflict";
                        }
                    }
                    if (sctx.fixing && !manualFixAttempted) {
                        manualFixAttempted = true;
                        sctx.log(`issues detected: ${issueDesc} - manual fix requested...`);
                        const previousHeadSHA = sctx.run.headSha;
                        let pushed = false;
                        let fixErr: unknown = null;
                        try {
                            pushed = await autoFixCI(sctx, host, pr, failing, mergeConflict);
                        } catch (err) {
                            fixErr = err;
                        }
                        if (fixErr !== null) {
                            sctx.log(`warning: CI manual fix failed: ${errMessage(fixErr)}`);
                        } else if (pushed || sctx.run.headSha !== previousHeadSHA) {
                            this.lastFixedChecks = fixKey;
                            this.lastFixedCompletedAt = fixCompletedAt;
                        } else {
                            sctx.log("CI fix produced no changes, returning for manual intervention...");
                            return ciChecks.ciFailureOutcome(
                                failing,
                                mergeConflict,
                                "CI fix produced no changes - failures require manual intervention"
                            );
                        }
                    } else if (sctx.fixing && fixKey === this.lastFixedChecks) {
                        sctx.log("fix already attempted for these issues, waiting for CI re-run...");
                    } else if (ciFixLimit <= 0) {
                        sctx.log(
                            `issues detected: ${issueDesc} - auto-fix disabled, waiting for manual intervention...`
                        );
                        return ciChecks.ciFailureOutcome(failing, mergeConflict, "CI failures require manual intervention");
                    } else if (this.ciFixAttempts >= ciFixLimit) {
                        sctx.log(
                            `issues detected: ${issueDesc} - max auto-fix attempts (${ciFixLimit}) reached, waiting for manual intervention...`
                        );
                        return ciChecks.ciFailureOutcome(
                            failing,
                            mergeConflict,
                            "CI failures still present after auto-fix attempts"
                        );
                    } else if (fixKey === this.lastFixedChecks) {
                        sctx.log("fix already attempted for these issues, waiting for CI re-run...");
                    } else {
                        this.ciFixAttempts++;
                        sctx.log(
                            `issues detected: ${issueDesc} - auto-fixing (attempt ${this.ciFixAttempts}/${ciFixLimit})...`
                        );
                        const previousHeadSHA = sctx.run.headSha;
                        let pushed = false;
                        let fixErr: unknown = null;
                        try {
                            pushed = await autoFixCI(sctx, host, pr, failing, mergeConflict);
                        } catch (err) {
                            fixErr = err;
                        }
                        if (fixErr !== null) {
                            sctx.log(`warning: CI auto-fix failed: ${errMessage(fixErr)}`);
                        } else if (pushed || sctx.run.headSha !== previousHeadSHA) {
                            this.lastFixedChecks = fixKey;
                            this.lastFixedCompletedAt = fixCompletedAt;
                        } else {
                            // No changes produced - don't set lastFixedChecks so the
                            // next poll treats this as a new failure and retries if
                            // attempts remain.
                            sctx.log("CI fix produced no changes, will retry if attempts remain...");
                        }
                    }
                } else {
                    this.lastFixedChecks = "";
                    this.lastFixedCompletedAt = null;
                    if (!prStateKnown || !mergeabilityKnown) {
                        lastMonitorLog = "";
                    } else if (pending) {
                        // Checks are (re-)running with no failures yet. Surface this
                        // so a PR that passed checks and starts re-running clears the
                        // previous passed-checks signal instead of looking stale.
                        lastMonitorLog = logCIMonitorStatus(sctx, CI_CHECKS_RUNNING_MSG, lastMonitorLog);
                    } else if (checks.length === 0 && elapsed < this.gracePeriod()) {
                        // CI checks may not be registered yet, keep polling.
                        lastMonitorLog = "";
                        sctx.log("no CI checks reported yet, waiting for checks to register...");
                    } else if (checks.length === 0) {
                        waitingOnMerge = true;
                        lastMonitorLog = logCIMonitorStatus(sctx, CI_NO_CHECKS_PASSED_MSG, lastMonitorLog);
                    } else {
                        waitingOnMerge = true;
                        lastMonitorLog = logCIMonitorStatus(sctx, CI_CHECKS_PASSED_MSG, lastMonitorLog);
                    }
                }
            }

            sctx.setBlocked(waitingOnMerge ? CI_MERGE_BLOCK_REASON : "");

            // Sleep for the poll interval.
            let interval = this.pollIntervalOverride;
            if (interval === 0) interval = ciChecks.pollInterval(now() - started);
            if (!unlimited) {
                const remaining = timeout - (now() - timeoutAnchor);
                if (remaining < interval) interval = remaining;
            }
            await waitForNextPoll(signal, interval);
        }
    }
}

/** Returns a new CI monitoring step. */
export function newCIStep(): CIStep {
    return new CIStep();
}
