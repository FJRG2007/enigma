/**
 * Environment construction for spawned agent subprocesses.
 *
 * Faithful port of the Go `internal/agent/env.go`. Agents shell out to git
 * directly (e.g. `git rebase --continue` during conflict resolution), which
 * would otherwise open $EDITOR and hang in a headless subprocess until the
 * agent times out, so the environment forces git into non-interactive mode.
 */

import { nonInteractiveEnv } from "../git";

/**
 * Returns the environment for a spawned agent subprocess with git forced into
 * non-interactive mode. `dir` must match the child's working directory so PWD
 * stays coupled to it (see nonInteractiveEnv).
 */
export function gitSafeEnv(dir: string): NodeJS.ProcessEnv {
    return nonInteractiveEnv(dir);
}
