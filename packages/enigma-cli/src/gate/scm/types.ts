/**
 * Shared SCM contract types consumed by the provider clients (gitlab, bitbucket).
 * Faithful port of the value types and helpers from upstream's `internal/scm`
 * package (scm.go state/bucket enums + host.go PR contract). Provider detection
 * and the GitHub repoSlug helper live in ./host; this module holds the PR, check,
 * capability, and error contract the clients reference as `scm.*` in Go. Go's
 * named string types (PRState, MergeableState, CheckBucket) map to `string`
 * aliases, since Go casts arbitrary strings into them.
 */

import type { Provider } from "./host";

/** PR identifies a pull/merge request on a provider. */
export interface PR {
    number: string;
    url: string;
}

/** PRContent is the title and body for creating or updating a PR. */
export interface PRContent {
    title: string;
    body: string;
}

/** Normalized lifecycle state of a PR. */
export type PRState = string;

/** PR is open and awaiting review or merge. */
export const PR_STATE_OPEN: PRState = "OPEN";

/** PR has been merged. */
export const PR_STATE_MERGED: PRState = "MERGED";

/** PR was closed without merging. */
export const PR_STATE_CLOSED: PRState = "CLOSED";

/** Normalized merge-conflict status of a PR. */
export type MergeableState = string;

/** PR can be merged cleanly. */
export const MERGEABLE_OK: MergeableState = "MERGEABLE";

/** PR has merge conflicts. */
export const MERGEABLE_CONFLICT: MergeableState = "CONFLICTING";

/** Merge status is still being computed. */
export const MERGEABLE_PENDING: MergeableState = "PENDING";

/** Merge status could not be determined. */
export const MERGEABLE_UNKNOWN: MergeableState = "UNKNOWN";

/**
 * How a merge writes the branch's commits onto the base. Named rather than left to
 * the provider's default because most providers refuse a non-interactive merge that
 * does not state one.
 */
export type MergeMethod = "squash" | "merge" | "rebase";

/** The merge methods, for validating a user-supplied value. */
export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

/**
 * The merge method used when the caller names none. Squash, because a gate PR
 * carries the original commits plus however many fix rounds the pipeline pushed,
 * and that history is noise on the base branch.
 */
export const DEFAULT_MERGE_METHOD: MergeMethod = "squash";

/** Reports whether value is a merge method, for validating CLI input. */
export function isMergeMethod(value: string): value is MergeMethod {
    return (MERGE_METHODS as readonly string[]).includes(value);
}

/** Normalized outcome bucket of a CI check. */
export type CheckBucket = string;

/** Check passed. */
export const CHECK_BUCKET_PASS: CheckBucket = "pass";

/** Check failed. */
export const CHECK_BUCKET_FAIL: CheckBucket = "fail";

/** Check is still running or queued. */
export const CHECK_BUCKET_PENDING: CheckBucket = "pending";

/** Check was canceled. */
export const CHECK_BUCKET_CANCEL: CheckBucket = "cancel";

/** Check was skipped or is manual. */
export const CHECK_BUCKET_SKIP: CheckBucket = "skipping";

/** Check is a single CI check result on a PR. */
export interface Check {
    name: string;
    bucket: CheckBucket;
    /** Zero/undefined when unknown; used to detect CI re-runs between polls. */
    completedAt?: Date;
}

/** Capabilities declares which optional Host methods return meaningful data. */
export interface Capabilities {
    mergeableState: boolean;
    failedCheckLogs: boolean;
}

/**
 * Thrown by optional Host methods that the provider cannot fulfil. Callers
 * should gate on Capabilities rather than catching this; implementations throw
 * it as a fallback.
 */
export const ERR_UNSUPPORTED = new Error("operation not supported by this provider");

/**
 * Host is the provider-agnostic interface to a PR-hosting service. Transport
 * (CLI vs HTTP API) is an implementation detail. Go threaded `context.Context`
 * as the first argument; here it is an optional trailing `AbortSignal`. Methods
 * that returned a nil `*PR` with a nil error in Go return `null` here.
 */
export interface Host {
    provider(): Provider;
    capabilities(): Capabilities;
    available(signal?: AbortSignal): Promise<void>;
    findPR(branch: string, base: string, signal?: AbortSignal): Promise<PR | null>;
    createPR(branch: string, base: string, content: PRContent, signal?: AbortSignal): Promise<PR | null>;
    updatePR(pr: PR, content: PRContent, signal?: AbortSignal): Promise<PR | null>;
    getPRState(pr: PR, signal?: AbortSignal): Promise<PRState>;
    getChecks(pr: PR, signal?: AbortSignal): Promise<Check[]>;
    getMergeableState(pr: PR, signal?: AbortSignal): Promise<MergeableState>;
    /**
     * Merges the PR with the given method. Throws when the provider refuses (checks
     * still failing, conflicts, branch protection, no permission) - the message is
     * the provider's, since only it knows which rule stopped the merge.
     */
    mergePR(pr: PR, method: MergeMethod, signal?: AbortSignal): Promise<void>;
    fetchFailedCheckLogs(
        pr: PR,
        branch: string,
        headSHA: string,
        failingNames: string[],
        signal?: AbortSignal
    ): Promise<string>;
}

/**
 * ExtractPRNumber returns the trailing numeric segment from a PR/MR URL.
 * Supports GitHub (/pull/N), GitLab (/-/merge_requests/N), and Bitbucket
 * (/pull-requests/N) URLs; all end in a digit path segment. Throws when the URL
 * has no trailing numeric segment.
 */
export function extractPRNumber(prURL: string): string {
    const trimmed = prURL.replace(/\/+$/, "");
    const parts = trimmed.split("/");
    if (parts.length === 0) throw new Error(`invalid PR URL: ${prURL}`);
    const num = parts[parts.length - 1];
    if (num === "") throw new Error(`invalid PR URL: ${prURL}`);
    if (!/^[+-]?\d+$/.test(num)) throw new Error(`invalid PR number "${num}" in URL: ${prURL}`);
    return num;
}
