/**
 * Push step: force-pushes the worktree state to the configured push remote.
 * Faithful 1:1 port of the upstream `internal/pipeline/steps/push.go`.
 *
 * Go threaded `context.Context`; here the StepContext carries an `AbortSignal`.
 * Go's `(value, error)` pairs become "return value / throw on error". The shared
 * `runStepShellCommand` returned `(output, exitCode, error)` in Go; the ported
 * helper returns `[output, exitCode]` and throws on spawn failure, so the format
 * branch wraps it in try/catch. `gitIgnoresPath`/`dirHasFiles` are package-local
 * helpers from Go's `test.go`/`push.go`, inlined here until test.ts is ported.
 * One deliberate deviation: the subject for leftover agent changes is built with
 * `gateCommitMessage` instead of a fixed string, so `commitEmoji` holds for this
 * commit site too.
 */

import * as git from "@/gate/git";
import { readdirSync } from "node:fs";
import { redact } from "@/gate/safeurl";
import { armGatePushWatch } from "@/ci-watch";
import { normalizedBranchRef } from "./commonGit";
import { runStepShellCommand } from "./commonExec";
import { gateCommitMessage } from "./commitMessage";
import { STEP_PUSH, type StepName } from "@/gate/types";
import { resolveTestEvidenceLocation } from "./evidence";
import { repoPushURL, updateRunHeadSHA } from "@/gate/db";
import { join, relative, sep, isAbsolute } from "node:path";
import { newStepOutcome, type Step, type StepContext, type StepOutcome } from "../types";

/** Prefix of the run-scoped local ref the push target's current tip is fetched into. */
const PUSH_BASE_REF_PREFIX = "refs/enigma/push-bases";

/**
 * Fetches the push target's current tip and reports it with whether it holds commits this
 * run's HEAD does not contain. The ref is scoped to the run, since every run of a repo shares
 * one gate repository, and removed afterwards. A fetch that fails throws: comparing or replaying
 * against a tip that was never fetched would act on someone else's state.
 */
async function inspectRemoteTip(sctx: StepContext, pushURL: string, ref: string, signal: AbortSignal): Promise<{ ahead: boolean; tipSHA: string; }> {
    const baseRef = `${PUSH_BASE_REF_PREFIX}/${sctx.run.id}`;
    try {
        try {
            await git.run(sctx.workDir, ["fetch", "--no-tags", pushURL, `+${ref}:${baseRef}`], signal);
        } catch (err) {
            throw new Error(`fetch ${ref} from the push target: ${errMessage(err)}`);
        }
        const tipSHA = await git.run(sctx.workDir, ["rev-parse", "--verify", `${baseRef}^{commit}`], signal);
        const ancestor = await git.runRaw(sctx.workDir, ["merge-base", "--is-ancestor", tipSHA, "HEAD"], signal);
        if (ancestor.code !== 0 && ancestor.code !== 1) {
            throw new Error(`compare ${tipSHA.slice(0, 12)} with HEAD: exit status ${ancestor.code}: ${ancestor.stderr.trim()}`);
        }
        return { ahead: ancestor.code === 1, tipSHA };
    } finally {
        await git.run(sctx.workDir, ["update-ref", "-d", baseRef], signal).catch(() => "");
    }
}

/** PushStep force-pushes the worktree state to the configured push remote. */
export class PushStep implements Step {
    name(): StepName {
        return STEP_PUSH;
    }

    async execute(sctx: StepContext): Promise<StepOutcome> {
        const signal = sctx.signal;
        let newHeadSHA = "";

        // Run format command if configured (before committing, so changes are formatted).
        const fmtCmd = sctx.config.commands.format;
        if (fmtCmd !== "") {
            sctx.log(`running formatter: ${fmtCmd}`);
            try {
                const [output, exitCode] = await runStepShellCommand(sctx, fmtCmd);
                if (exitCode !== 0) {
                    sctx.log(`warning: format command exited with code ${exitCode}: ${output}`);
                }
            } catch (err) {
                sctx.log(`warning: format command failed: ${errMessage(err)}`);
            }
        }

        // Commit any uncommitted changes from agent fixes.
        await this.stageInRepoEvidence(sctx);
        let status = "";
        try {
            status = await git.run(sctx.workDir, ["status", "--porcelain"], signal);
        } catch {
            status = "";
        }
        if (status.trim() !== "") {
            sctx.log("committing agent changes...");
            try {
                await git.run(sctx.workDir, ["add", "-A"], signal);
            } catch (err) {
                throw new Error(`stage agent changes: ${errMessage(err)}`);
            }
            try {
                const message = gateCommitMessage(sctx.repo.workingPath, STEP_PUSH, "apply agent fixes");
                await git.run(sctx.workDir, ["commit", "-m", message], signal);
            } catch (err) {
                throw new Error(`commit agent changes: ${errMessage(err)}`);
            }
            let headSHA: string;
            try {
                headSHA = await git.headSHA(sctx.workDir, signal);
            } catch (err) {
                throw new Error(`resolve head after commit: ${errMessage(err)}`);
            }
            newHeadSHA = headSHA;
        }

        const ref = normalizedBranchRef(sctx.run.branch);

        const pushURL = repoPushURL(sctx.repo);
        let pushTarget = "upstream";
        if (sctx.repo.forkUrl.trim() !== "") {
            pushTarget = "fork";
            sctx.log(`pushing to fork ${redact(pushURL)} (${ref})...`);
        } else {
            sctx.log(`pushing to ${redact(pushURL)} (${ref})...`);
        }

        // Query the push target for current ref SHA to enable safe --force-with-lease.
        // Without an explicit SHA, --force-with-lease offers no protection when
        // pushing to a URL (no remote tracking refs), silently degrading to --force.
        let upstreamSHA: string;
        try {
            upstreamSHA = await git.lsRemote(sctx.workDir, pushURL, ref, signal);
        } catch (err) {
            throw new Error(`ls-remote ${pushTarget}: ${errMessage(err)}`);
        }
        if (upstreamSHA !== "") {
            // A lease taken from what the remote holds RIGHT NOW protects nothing: anything that
            // landed while the run was in flight is exactly what it would overwrite. Measured on
            // the default branch: a bot commit pushed during a run was silently replaced by the
            // run's push. So first ask whether the remote holds work this run lacks.
            let remote: { ahead: boolean; tipSHA: string; };
            try {
                remote = await inspectRemoteTip(sctx, pushURL, ref, signal);
            } catch (err) {
                throw new Error(`inspect ${pushTarget} ${ref}: ${errMessage(err)}`);
            }
            const remoteAhead = remote.ahead;
            const onDefault = ref === normalizedBranchRef(sctx.repo.defaultBranch);
            if (remoteAhead && onDefault) {
                // The default branch is never force-pushed: replay this run's commits onto what
                // landed meanwhile, then push as a fast-forward. A conflict stops the step rather
                // than choosing a side.
                try {
                    await git.run(sctx.workDir, ["rebase", remote.tipSHA], signal);
                    sctx.log(`${sctx.repo.defaultBranch} moved on the remote during the run; replayed this run's commits onto ${remote.tipSHA.slice(0, 12)}`);
                } catch (err) {
                    await git.run(sctx.workDir, ["rebase", "--abort"], signal).catch(() => "");
                    throw new Error(`${sctx.repo.defaultBranch} moved on the remote during the run (now ${remote.tipSHA.slice(0, 12)}) and this run's commits do not replay onto it cleanly - pull, resolve, and run the gate again: ${errMessage(err)}`);
                }
                newHeadSHA = await git.headSHA(sctx.workDir, signal);
            }
            try {
                if (remoteAhead && !onDefault) {
                    // A working branch the run rewrote (rebase, fix rounds) still needs the force,
                    // leased on the SHA just inspected.
                    await git.push(sctx.workDir, pushURL, ref, remote.tipSHA, true, signal);
                } else {
                    await git.push(sctx.workDir, pushURL, ref, "", false, signal);
                }
            } catch (err) {
                throw new Error(`push to ${pushTarget}: ${errMessage(err)}`);
            }
        } else {
            // New branch: regular push (no force needed).
            try {
                await git.push(sctx.workDir, pushURL, ref, "", false, signal);
            } catch (err) {
                throw new Error(`push to ${pushTarget}: ${errMessage(err)}`);
            }
        }

        if (newHeadSHA !== "") {
            try {
                await git.run(sctx.workDir, ["update-ref", ref, newHeadSHA], signal);
            } catch (err) {
                throw new Error(`update local branch ref: ${errMessage(err)}`);
            }
        }

        let headSHA: string;
        try {
            headSHA = await git.headSHA(sctx.workDir, signal);
        } catch (err) {
            throw new Error(`resolve HEAD after push: ${errMessage(err)}`);
        }
        if (headSHA !== sctx.run.headSha) {
            sctx.run.headSha = headSHA;
            updateRunHeadSHA(sctx.db, sctx.run.id, headSHA);
        }

        sctx.log("pushed successfully");
        // A push to the default branch opens no PR, so no CI step will watch its build: hand it
        // to the CI notifier, which tells the agent in the user's checkout if it breaks.
        armGatePushWatch({ repoPath: sctx.repo.workingPath, ref, defaultBranch: sctx.repo.defaultBranch, forkUrl: sctx.repo.forkUrl, sha: headSHA });
        return newStepOutcome();
    }

    private async stageInRepoEvidence(sctx: StepContext): Promise<void> {
        const signal = sctx.signal;
        const location = resolveTestEvidenceLocation(
            sctx.workDir,
            sctx.run.branch,
            sctx.run.id,
            sctx.config.test.evidence
        );
        if (!location.storeInRepo) return;
        if (await gitIgnoresPath(signal, sctx.workDir, location.dir)) return;
        if (!dirHasFiles(location.dir)) return;
        const rel = relative(sctx.workDir, location.dir);
        if (rel === "." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
        try {
            await git.run(sctx.workDir, ["add", "-f", "--", toSlash(rel)], signal);
        } catch (err) {
            throw new Error(`stage test evidence: ${errMessage(err)}`);
        }
    }
}

/** Constructs a new PushStep. */
export function newPushStep(): PushStep {
    return new PushStep();
}

/** Reports whether the path is gitignored relative to the worktree. */
async function gitIgnoresPath(signal: AbortSignal, workDir: string, target: string): Promise<boolean> {
    const rel = relative(workDir, target);
    if (rel === "." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    try {
        await git.run(workDir, ["check-ignore", "--quiet", "--", toSlash(rel)], signal);
        return true;
    } catch {
        return false;
    }
}

/** Reports whether dir contains at least one non-directory entry (recursively). */
function dirHasFiles(dir: string): boolean {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (dirHasFiles(join(dir, entry.name))) return true;
        } else {
            return true;
        }
    }
    return false;
}

/** Converts the OS path separator to forward slashes (filepath.ToSlash). */
function toSlash(p: string): string {
    return sep === "/" ? p : p.split(sep).join("/");
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
