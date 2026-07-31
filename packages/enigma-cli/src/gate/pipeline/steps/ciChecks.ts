/**
 * CI check status aggregation: poll-interval pacing, failing/pending bucket
 * helpers, last-fixed-issue encoding, and the StepOutcome builders for CI
 * failures, mergeability stalls, and monitoring timeouts. Faithful port of the
 * upstream `internal/pipeline/steps/ci_checks.go`.
 *
 * Go's `Check.Failing()`/`Check.Pending()` and `time.Time` zero/`After` semantics
 * map to the `checkFailing`/`checkPending` helpers here and to `Date | undefined`
 * (undefined == the zero time). Durations are milliseconds (consistent with the
 * rest of the port).
 */

import { type StepOutcome, newStepOutcome } from "../types";
import { type Check, CHECK_BUCKET_FAIL, CHECK_BUCKET_PENDING } from "../../scm/types";
import { type Finding, type Findings, ACTION_ASKUSER, marshalFindingsJSON } from "../../types";

/** Decoded form of an encoded last-fixed-issues key. */
interface LastFixedIssues {
    checks: string[];
    mergeConflict: boolean;
}

/** Reports whether the check is in a failed bucket. */
export function checkFailing(c: Check): boolean {
    return c.bucket === CHECK_BUCKET_FAIL;
}

/** Reports whether the check is still running or queued. */
export function checkPending(c: Check): boolean {
    return c.bucket === CHECK_BUCKET_PENDING;
}

/**
 * Returns the polling interval (ms) based on elapsed time since CI monitoring
 * started: 5s for the first 30s, 10s up to 2min, 30s up to 5min, 60s for 5-15min,
 * 120s after.
 *
 * DIVERGENCE from upstream's `pollInterval`, which starts flat at 30s. The monitor
 * polls first and sleeps after, so the interval is also the detection lag on the
 * transition that ends the wait; a short pipeline whose checks settle in the first
 * minutes paid up to 30s of pure sleep for it. The ramp only shortens the early
 * window - the 5-15min and steady-state tiers stay exactly as upstream sets them,
 * so long monitoring keeps the same API-call profile. Provider calls in the shortened
 * window are `gh`/`glab` reads, cheap and un-metered by tokens.
 */
export function pollInterval(elapsedMS: number): number {
    if (elapsedMS < 30 * 1000) return 5 * 1000;
    if (elapsedMS < 2 * 60 * 1000) return 10 * 1000;
    if (elapsedMS < 5 * 60 * 1000) return 30 * 1000;
    if (elapsedMS < 15 * 60 * 1000) return 60 * 1000;
    return 120 * 1000;
}

/** Returns true if any CI check is in the fail bucket. */
export function hasFailingChecks(checks: Check[]): boolean {
    return checks.some(checkFailing);
}

/** Returns true if any CI check is still running or queued. */
export function hasPendingChecks(checks: Check[]): boolean {
    return checks.some(checkPending);
}

/** Returns the names of failing checks. */
export function failingCheckNames(checks: Check[]): string[] {
    const names: string[] = [];
    for (const c of checks) {
        if (checkFailing(c)) names.push(c.name);
    }
    return names;
}

/**
 * Returns the latest completion time per failing check, or null when no failing
 * check carries a known completion time.
 */
export function failingCheckCompletionTimes(checks: Check[]): Map<string, Date> | null {
    const completedAt = new Map<string, Date>();
    for (const c of checks) {
        if (!checkFailing(c)) continue;
        if (c.completedAt === undefined) continue;
        const previous = completedAt.get(c.name);
        if (previous === undefined || c.completedAt.getTime() > previous.getTime()) {
            completedAt.set(c.name, c.completedAt);
        }
    }
    if (completedAt.size === 0) return null;
    return completedAt;
}

/**
 * Reports whether any failing check completed after the recorded time, meaning
 * CI has re-run since the last fix push.
 */
export function failingCheckCompletedAfter(checks: Check[], after: Map<string, Date> | null): boolean {
    if (after === null || after.size === 0) return false;
    for (const c of checks) {
        if (!checkFailing(c) || c.completedAt === undefined) continue;
        const previous = after.get(c.name);
        if (previous !== undefined && c.completedAt.getTime() > previous.getTime()) {
            return true;
        }
    }
    return false;
}

/**
 * Reports whether a pending check matches the issues from the last fix attempt,
 * indicating CI is re-running the same checks we just pushed a fix for.
 */
export function pendingCheckMatchesLastFixed(checks: Check[], lastFixedChecks: string): boolean {
    const [issues, ok] = decodeLastFixedChecks(lastFixedChecks);
    if (!ok) return false;

    const failedNames = new Set<string>();
    for (const name of issues.checks) {
        if (name === "") continue;
        failedNames.add(name);
    }
    if (failedNames.size === 0) {
        return issues.mergeConflict && hasPendingChecks(checks);
    }

    for (const c of checks) {
        if (!checkPending(c)) continue;
        if (failedNames.has(c.name)) return true;
    }

    return false;
}

/** Encodes the failing checks and merge-conflict flag into a stable JSON key. */
export function encodeLastFixedChecks(failing: string[], mergeConflict: boolean): string {
    if (failing.length === 0 && !mergeConflict) return "";
    const issues: { checks?: string[]; mergeConflict?: boolean; } = {};
    if (failing.length > 0) issues.checks = failing;
    if (mergeConflict) issues.mergeConflict = true;
    try {
        return JSON.stringify(issues);
    } catch {
        return "";
    }
}

/** Decodes a last-fixed-issues key, returning [issues, ok]. */
export function decodeLastFixedChecks(raw: string): [LastFixedIssues, boolean] {
    const empty: LastFixedIssues = { checks: [], mergeConflict: false };
    if (raw === "") return [empty, false];
    let parsed: { checks?: string[]; mergeConflict?: boolean; };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [empty, false];
    }
    const issues: LastFixedIssues = {
        checks: Array.isArray(parsed.checks) ? parsed.checks : [],
        mergeConflict: parsed.mergeConflict === true
    };
    if (issues.checks.length === 0 && !issues.mergeConflict) return [empty, false];
    return [issues, true];
}

/** Builds the needs-approval outcome reported when CI failures remain. */
export function ciFailureOutcome(failing: string[], mergeConflict: boolean, summary: string): StepOutcome {
    const items: Finding[] = [];
    for (const name of failing) {
        items.push({ severity: "warning", description: `CI check failing: ${name}`, action: "" });
    }
    if (mergeConflict) {
        items.push({
            severity: "warning",
            description: "PR has merge conflicts with the base branch",
            action: ""
        });
    }
    const findings: Findings = { items, summary, riskLevel: "", riskRationale: "" };
    return newStepOutcome({ needsApproval: true, findings: marshalFindingsJSON(findings) });
}

/** Builds the needs-approval outcome reported when mergeability never resolved. */
export function ciMergeabilityOutcome(summary: string, description: string): StepOutcome {
    const findings: Findings = {
        summary,
        items: [{ severity: "warning", description, action: ACTION_ASKUSER }],
        riskLevel: "",
        riskRationale: ""
    };
    return newStepOutcome({ needsApproval: true, findings: marshalFindingsJSON(findings) });
}

/** Builds the needs-approval outcome reported when CI monitoring timed out. */
export function ciMonitoringTimeoutOutcome(): StepOutcome {
    const findings: Findings = {
        summary: "CI monitoring timed out before PR was merged or closed",
        items: [
            {
                severity: "warning",
                description: "PR was still open when CI monitoring timed out",
                action: ACTION_ASKUSER
            }
        ],
        riskLevel: "",
        riskRationale: ""
    };
    return newStepOutcome({ needsApproval: true, findings: marshalFindingsJSON(findings) });
}
