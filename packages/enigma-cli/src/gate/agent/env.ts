/**
 * Environment construction for spawned agent subprocesses.
 *
 * Faithful port of the Go `internal/agent/env.go`. Agents shell out to git
 * directly (e.g. `git rebase --continue` during conflict resolution), which
 * would otherwise open $EDITOR and hang in a headless subprocess until the
 * agent times out, so the environment forces git into non-interactive mode.
 *
 * It also stamps `GATE_ROLE_ENV_VAR` (upstream's `NO_MISTAKES_GATE`, defined in
 * util.ts so the hooks can read it without importing the gate) to mark the process
 * as a gate step agent - review, fix, document, test, lint, rebase, pr or ci -
 * rather than an interactive session. That marker is defense in depth only: it can
 * be removed, forged, or inherited, so nothing security-relevant depends on it. Two
 * consumers read it: a cooperating orchestration harness in the target repo refuses
 * to let the gate agent act as a fleet operator, and enigma's turn-end completion
 * hook skips itself, because a step agent returns structured JSON rather than a
 * "done" claim the hook could judge, and blocking its stop only forces an extra
 * agent turn. Presence is the whole signal.
 */

import { Paths } from "../paths";
import { existsSync } from "node:fs";
import { nonInteractiveEnv } from "../git";
import { GATE_ROLE_ENV_VAR } from "@/util";

/**
 * Returns the environment for a spawned agent subprocess with git forced into
 * non-interactive mode. `dir` must match the child's working directory so PWD
 * stays coupled to it (see nonInteractiveEnv).
 *
 * GATE_ROLE_ENV_VAR is applied last so it wins over any ambient value.
 */
export function gitSafeEnv(dir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...nonInteractiveEnv(dir), [GATE_ROLE_ENV_VAR]: "1" };
    // A gate worktree is a fresh path per run that is never revisited, so anything an
    // agent keys on its working directory inside the OS temp dir is orphaned the moment
    // the run ends. Handing it a temp dir enigma owns means the run's teardown reclaims
    // that state, whichever backend produced it. Only when the directory really exists:
    // a TEMP pointing at nothing breaks every child that writes a temp file, which is a
    // worse failure than the leak it would prevent.
    const tmp = Paths.resolve().agentTmpDirForWorktree(dir);
    if (tmp !== null && existsSync(tmp)) {
        env.TMPDIR = tmp;
        env.TEMP = tmp;
        env.TMP = tmp;
    }
    return env;
}
