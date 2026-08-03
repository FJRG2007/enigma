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
import { normalizedBranchRef } from "./commonGit";
import { runStepShellCommand } from "./commonExec";
import { gateCommitMessage } from "./commitMessage";
import { STEP_PUSH, type StepName } from "@/gate/types";
import { resolveTestEvidenceLocation } from "./evidence";
import { repoPushURL, updateRunHeadSHA } from "@/gate/db";
import { join, relative, sep, isAbsolute } from "node:path";
import { newStepOutcome, type Step, type StepContext, type StepOutcome } from "../types";

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
            // Existing branch: force-with-lease with explicit expected SHA.
            try {
                await git.push(sctx.workDir, pushURL, ref, upstreamSHA, true, signal);
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
