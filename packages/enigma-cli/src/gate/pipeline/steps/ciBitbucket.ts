/**
 * Bitbucket-specific helpers for the CI step plus the shared CI-log truncation
 * routine. Faithful port of the upstream
 * `internal/pipeline/steps/ci_bitbucket.go`.
 *
 * `resolveBitbucketRepoRef` mirrors the Go helper that `buildHost` relied on;
 * the ported `host.ts` carries its own private copy, so this exported version is
 * the faithful home of the original ci_bitbucket.go function. `trimLogOutput` is
 * consumed by `ciFix.ts` when embedding failed-check logs into the fix prompt.
 */

import { parseRepoRef, type RepoRef } from "../../scm/bitbucket";

/**
 * Parses a Bitbucket repo reference from the upstream URL, falling back to the
 * PR URL when the upstream is not a Bitbucket URL.
 */
export function resolveBitbucketRepoRef(upstreamURL: string, prURL: string | null): RepoRef {
    try {
        return parseRepoRef(upstreamURL);
    } catch {
        // Not a Bitbucket upstream URL; fall back to the PR URL.
    }
    if (prURL !== null && prURL.trim() !== "") {
        return parseRepoRef(prURL);
    }
    throw new Error(`resolve Bitbucket repository from upstream ${JSON.stringify(upstreamURL)}`);
}

/**
 * Truncates log output to the last maxBytes bytes, respecting UTF-8 boundaries
 * at the truncation point. Operates on UTF-8 bytes (via Buffer) to match Go's
 * byte-oriented slicing.
 */
export function trimLogOutput(logOutput: string, maxBytes: number): string {
    const buf = Buffer.from(logOutput, "utf8");
    if (buf.length <= maxBytes) return logOutput;
    const sliced = buf.subarray(buf.length - maxBytes);
    for (let i = 0; i < sliced.length && i < 4; i++) {
        if ((sliced[i] & 0xc0) !== 0x80) {
            return sliced.subarray(i).toString("utf8");
        }
    }
    return sliced.toString("utf8");
}
