/**
 * Directory removal for gate teardown.
 *
 * Every tree the gate deletes is one an agent subprocess, a git child or the OS
 * indexer may still hold a handle on, which surfaces as EBUSY/EPERM - routinely on
 * Windows, which is the reason teardown deletes a worktree directly at all. `rmSync`
 * defaults to no retries, so a bare call loses the very race the fallback exists to
 * win and leaves the tree behind. Node retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM
 * with a linear backoff when `maxRetries` is set and `recursive` is true.
 */

import { rmSync } from "node:fs";

/** Long enough to outlast a subprocess on its way out, short enough not to stall teardown. */
const REMOVE_RETRIES = 5;
const REMOVE_RETRY_DELAY_MS = 100;

/**
 * Removes a directory tree, waiting out the locks a departing subprocess holds.
 * A path that is already gone counts as removed; anything still locked after the
 * last retry throws, so the caller decides whether that is fatal or a warning.
 */
export function removeDirTree(path: string): void {
    rmSync(path, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_DELAY_MS });
}
