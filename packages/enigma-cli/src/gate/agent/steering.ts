/**
 * Worktree-steering wrapper for pipeline agents.
 *
 * Faithful 1:1 port of the Go `internal/agent/steering.go`: a preamble prepended
 * to every agent prompt that confines writes to the git worktree and steers the
 * agent away from mutating system state (system packages, /Applications, global
 * config) - the writes that trigger macOS App-Management prompts. This is soft
 * prompt steering, not enforcement. Wrapping is idempotent.
 *
 * Rebranded to enigma gate (evidence temp dir `enigma-gate-evidence`), matching
 * the rest of the ported gate package.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Result, RunOpts } from "./agent";

/** Prepended to every pipeline agent prompt to keep writes inside the worktree. */
export const WORKTREE_STEERING = `Workspace boundary (important):
- Confine source, project, user-data, and system file changes to the current working directory, which is a git worktree. Do not intentionally create, modify, move, or delete those files anywhere outside it.
- Do not modify system state outside the worktree. In particular, do not install or upgrade system packages (for example brew install/upgrade, or other system package managers), do not modify applications under /Applications, and do not change global or user-level tool configuration.
- This is prompt steering, not true enforcement: treat the worktree boundary as a soft boundary you must follow.
- The only allowed out-of-worktree writes are test evidence files under ${join(tmpdir(), "enigma-gate-evidence")} when a testing prompt explicitly asks for them.
- Ephemeral temp/cache writes that are incidental side effects of running the project development toolchain are allowed outside the worktree for tests, linters, formatters, builds, and manual verification commands.
- You may read files outside the worktree and run read-only commands, but every other intentional write must stay inside the worktree.

`;

/** Wraps an Agent and prepends WORKTREE_STEERING to each prompt. */
class SteeredAgent implements Agent {
    constructor(private readonly inner: Agent) {}

    name(): string {
        return this.inner.name();
    }

    /** Prepends the steering preamble, then delegates with all other opts intact. */
    run(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        return this.inner.run({ ...opts, prompt: WORKTREE_STEERING + opts.prompt }, signal);
    }

    close(): Promise<void> {
        return this.inner.close();
    }
}

/**
 * Wraps an agent so every invocation keeps writes inside the worktree. Wrapping
 * is idempotent: an already-steered agent is returned unchanged, and a nullish
 * agent passes through (mirroring Go's nil handling).
 */
export function withSteering(a: Agent | null | undefined): Agent | null {
    if (!a) return null;
    if (a instanceof SteeredAgent) return a;
    return new SteeredAgent(a);
}
