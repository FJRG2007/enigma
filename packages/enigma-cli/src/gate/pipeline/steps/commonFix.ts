/**
 * Fix-mode execution shared by the auto-fixable pipeline steps: run the fix
 * agent, commit any resulting changes with a deterministic message, and advance
 * the run's HEAD. Faithful port of the upstream
 * `internal/pipeline/steps/common_fix.go`.
 *
 * The Go `commitSummarySchema` was a `json.RawMessage`; here it is a parsed JS
 * object, matching `agent.RunOpts.jsonSchema`. Go decoded `result.Output` via
 * json.Unmarshal; here `result.output` is already the parsed structured value.
 * The subject itself comes from `gateCommitMessage` rather than being formatted
 * here, since every commit site in the pipeline shares that one convention.
 */

import * as git from "@/gate/git";
import type { StepContext } from "../types";
import { updateRunHeadSHA } from "@/gate/db";
import type { StepName } from "@/gate/types";
import type { Result } from "@/gate/agent/agent";
import { normalizedBranchRef } from "./commonGit";
import { gateCommitMessage } from "./commitMessage";

/** Options driving a single executeFixMode invocation. */
export interface FixExecutionOptions {
    requirePreviousFindings: boolean;
    missingFindingsError: string;
    logMessage: string;
    prompt: string;
    errorPrefix: string;
    fallbackSummary: string;
    afterAgentRun?: (result: Result) => void | Promise<void>;
}

/** JSON Schema for the one-line commit summary returned by a fix agent. */
export const commitSummarySchema = {
    type: "object",
    properties: {
        summary: { type: "string" }
    },
    required: ["summary"]
};

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Trims any of the cutset characters from both ends of a string (strings.Trim). */
function trimCutset(s: string, cutset: string): string {
    const set = new Set(cutset);
    let start = 0;
    let end = s.length;
    while (start < end && set.has(s[start])) start++;
    while (end > start && set.has(s[end - 1])) end--;
    return s.slice(start, end);
}

/**
 * Stages, commits, and advances the run HEAD for any working-tree changes the
 * agent produced; no-ops when the tree is clean. Every commit the pipeline makes
 * on the agent's behalf goes through here, so `gateCommitMessage` stays the one
 * place the subject convention is applied.
 */
export async function commitAgentFixes(
    sctx: StepContext,
    stepName: StepName,
    summary: string,
    fallbackSummary: string
): Promise<void> {
    const signal = sctx.signal;
    let status = "";
    try {
        status = await git.run(sctx.workDir, ["status", "--porcelain"], signal);
    } catch {
        status = "";
    }
    if (status.trim() === "") {
        sctx.log("no agent changes to commit");
        return;
    }
    try {
        await git.run(sctx.workDir, ["add", "-A"], signal);
    } catch (err) {
        throw new Error(`stage ${stepName} changes: ${errMessage(err)}`);
    }
    if (summary === "") summary = fallbackSummary;
    const commitMessage = gateCommitMessage(sctx.repo.workingPath, stepName, summary);
    try {
        await git.run(sctx.workDir, ["commit", "-m", commitMessage], signal);
    } catch (err) {
        throw new Error(`commit ${stepName} changes: ${errMessage(err)}`);
    }
    let headSHA: string;
    try {
        headSHA = await git.headSHA(sctx.workDir, signal);
    } catch (err) {
        throw new Error(`resolve head after ${stepName} commit: ${errMessage(err)}`);
    }
    const ref = normalizedBranchRef(sctx.run.branch);
    try {
        await git.run(sctx.workDir, ["update-ref", ref, headSHA], signal);
    } catch (err) {
        throw new Error(`update local branch ref: ${errMessage(err)}`);
    }
    sctx.run.headSha = headSHA;
    updateRunHeadSHA(sctx.db, sctx.run.id, headSHA);
    sctx.log(`committed agent fixes: ${commitMessage}`);
}

/**
 * Extracts the one-line commit summary from a fix agent's structured output.
 * Throws when the agent returned no decodable summary.
 */
export function extractCommitSummary(result: Result): string {
    if (result.output === undefined || result.output === null) {
        throw new Error("agent returned no structured summary");
    }
    const out = result.output;
    if (typeof out !== "object" || Array.isArray(out)) {
        throw new Error("parse commit summary: cannot decode structured summary");
    }
    const raw = (out as Record<string, unknown>).summary;
    if (raw !== undefined && typeof raw !== "string") {
        throw new Error("parse commit summary: summary is not a string");
    }
    const summary = typeof raw === "string" ? raw : "";
    let cleaned = summary.split(/\s+/).filter(part => part !== "").join(" ");
    cleaned = trimCutset(cleaned, " \t\r\n\"'.;:,-");
    return cleaned;
}

/**
 * Runs the fix agent and commits any resulting changes. Returns the agent's
 * one-line fix summary (empty when the agent returned nothing parseable), which
 * the caller should place on StepOutcome.fixSummary so the executor can persist
 * it on the round record.
 */
export async function executeFixMode(
    sctx: StepContext,
    stepName: StepName,
    opts: FixExecutionOptions
): Promise<string> {
    if (!sctx.fixing) return "";
    if (opts.requirePreviousFindings && sctx.previousFindings === "") {
        throw new Error(opts.missingFindingsError);
    }
    if (opts.logMessage !== "") sctx.log(opts.logMessage);
    let result: Result;
    try {
        result = await sctx.agent.run(
            {
                prompt: opts.prompt,
                cwd: sctx.workDir,
                jsonSchema: commitSummarySchema,
                onChunk: sctx.logChunk
            },
            sctx.signal
        );
    } catch (err) {
        throw new Error(`${opts.errorPrefix}: ${errMessage(err)}`);
    }
    if (opts.afterAgentRun) {
        await opts.afterAgentRun(result);
    }
    let summary = "";
    try {
        summary = extractCommitSummary(result);
    } catch (err) {
        sctx.log(`warning: could not parse fix summary: ${errMessage(err)}`);
    }
    await commitAgentFixes(sctx, stepName, summary, opts.fallbackSummary);
    return summary;
}
