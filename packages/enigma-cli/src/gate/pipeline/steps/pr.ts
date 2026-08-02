/**
 * PR step: creates or updates a pull request via the resolved SCM Host. It drafts
 * the title/body with the agent (falling back to a deterministic summary on
 * failure), appends the generated Risk/Testing/Pipeline sections, prepends the
 * user-intent section, finds an existing PR or creates one (fork --head routing
 * handled inside the Host), and persists the PR URL on the outcome and the run.
 * Faithful port of the upstream `internal/pipeline/steps/pr.go`.
 *
 * Go threaded `context.Context`; here the StepContext carries an `AbortSignal`.
 * Go's `(value, error)` returns become throws or local try/catch. The agent's
 * `result.Output` was raw JSON bytes decoded via json.Unmarshal; here
 * `result.output` is already a parsed value, decoded with the same object/string
 * strictness so a non-object payload falls through to the deterministic fallback.
 */

import { log } from "@/gate/log";
import * as git from "@/gate/git";
import { buildHost } from "./host";
import type { Result } from "@/gate/agent/agent";
import { detectProvider } from "@/gate/scm/host";
import { resolveBranchBaseSHA } from "./commonGit";
import type { PR, PRContent } from "@/gate/scm/types";
import { STEP_PR, type StepName } from "@/gate/types";
import { executionContextPromptSection } from "./executionContext";
import { RELEASE_TYPE_RULE, tightenTitle } from "@/gate/conventional";
import { userIntentPromptSection, cleanedUserIntent } from "./intentPrompt";
import { buildPipelineSummary, buildTestingSummaryForPR } from "./prsummary";
import { newStepOutcome, type Step, type StepContext, type StepOutcome } from "../types";
import {
    getStepsByRun,
    getRoundsByStep,
    updateRunPRURL,
    type StepResult,
    type StepRound
} from "@/gate/db";

/** Returns the message of an unknown thrown value, mirroring Go's `%v`. */
function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Inline JSON Schema constraining the agent's PR title/body output. */
const prContentSchema: unknown = {
    type: "object",
    properties: {
        title: { type: "string", description: "Conventional commit PR title, e.g. fix(scope): short description" },
        body: {
            type: "string",
            description: "GitHub-flavored markdown body starting with ## What Changed. Plain text, NOT JSON."
        }
    },
    required: ["title", "body"]
};

/**
 * Decodes the agent's parsed output into a PR title/body, mirroring Go's
 * `json.Unmarshal` into `struct{Title, Body string}`: requires a JSON object and
 * rejects non-string title/body values. Missing fields default to "".
 */
function decodePRContent(output: unknown): PRContent | null {
    if (output === undefined || output === null) return null;
    if (typeof output !== "object" || Array.isArray(output)) return null;
    const obj = output as Record<string, unknown>;
    const title = obj.title;
    const body = obj.body;
    if (title !== undefined && typeof title !== "string") return null;
    if (body !== undefined && typeof body !== "string") return null;
    return {
        title: typeof title === "string" ? title : "",
        body: typeof body === "string" ? body : ""
    };
}

/** Creates or updates a pull request via the provider CLI or API. */
export class PRStep implements Step {
    name(): StepName {
        return STEP_PR;
    }

    async execute(sctx: StepContext): Promise<StepOutcome> {
        const signal = sctx.signal;

        let branch = sctx.run.branch;
        if (branch.startsWith("refs/heads/")) {
            branch = branch.slice("refs/heads/".length);
        }
        if (branch === sctx.repo.defaultBranch) {
            sctx.log(`skipping PR creation on default branch ${branch}`);
            return newStepOutcome({ skipped: true });
        }
        const provider = detectProvider(sctx.repo.upstreamUrl);
        const [host, skipReason] = buildHost(sctx, provider);
        if (host === null) {
            sctx.log(`skipping PR creation: ${skipReason}`);
            return newStepOutcome({ skipped: true });
        }
        try {
            await host.available(signal);
        } catch (err) {
            sctx.log(`skipping PR creation: ${errMessage(err)}`);
            return newStepOutcome({ skipped: true });
        }

        // Resolve the branch base so PR summaries cover the full branch delta.
        const baseSHA = await resolveBranchBaseSHA(signal, sctx.workDir, sctx.run.baseSha, sctx.repo.defaultBranch);
        const content = await this.buildPRContent(sctx, branch, baseSHA);

        sctx.log(`checking for existing pull request on branch ${branch}...`);
        const existing = await host.findPR(branch, sctx.repo.defaultBranch, signal);
        if (existing !== null) {
            sctx.log(`pull request already exists: ${describePR(existing)}, updating...`);
            let updated: PR | null;
            try {
                updated = await host.updatePR(existing, content, signal);
            } catch (err) {
                sctx.log(`warning: failed to update PR: ${errMessage(err)}`);
                updated = existing;
            }
            if (updated !== null && updated.url !== "") {
                try {
                    updateRunPRURL(sctx.db, sctx.run.id, updated.url);
                } catch (err) {
                    log.warn("failed to persist PR URL", "run", sctx.run.id, "url", updated.url, "err", errMessage(err));
                }
                return newStepOutcome({ prUrl: updated.url });
            }
            return newStepOutcome({});
        }

        sctx.log("creating pull request...");
        const created = await host.createPR(branch, sctx.repo.defaultBranch, content, signal);
        if (created === null || created.url.trim() === "") {
            return newStepOutcome({});
        }
        sctx.log(`created pull request: ${created.url}`);
        try {
            updateRunPRURL(sctx.db, sctx.run.id, created.url);
        } catch (err) {
            log.warn("failed to persist PR URL", "run", sctx.run.id, "url", created.url, "err", errMessage(err));
        }
        return newStepOutcome({ prUrl: created.url });
    }

    private async buildPRContent(sctx: StepContext, branch: string, baseSHA: string): Promise<PRContent> {
        const signal = sctx.signal;
        let commitLog = "";
        try {
            commitLog = await git.log(sctx.workDir, baseSHA, sctx.run.headSha, signal);
        } catch {
            commitLog = "";
        }
        let diffStat = "";
        try {
            diffStat = await git.run(sctx.workDir, ["diff", "--stat", `${baseSHA}..${sctx.run.headSha}`], signal);
        } catch {
            diffStat = "";
        }

        // Build the deterministic sections from step rounds.
        const [pipelineMD, riskLine, testingMD] = this.buildPipelineSection(sctx);

        // Build pipeline context for the agent prompt so it can reference findings in the summary.
        let pipelineContext = "";
        if (pipelineMD !== "") {
            pipelineContext = `\nPipeline results (reference these naturally in the summary if relevant):\n${pipelineMD}`;
        }

        const prompt = `Draft a pull request title and summary for the full branch delta.

Context:
- branch: ${branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
- default branch: ${sctx.repo.defaultBranch}

Rules:
- Cover the full branch delta, not just the latest commit.
- Title must use conventional commit format: "type(scope): description" or "type: description". Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Scope is optional. Do not capitalize the type. Do not use the raw branch name.
${RELEASE_TYPE_RULE}
- When including a scope, it MUST be a real package/module name that exists in the codebase (for example, a directory under internal/, cmd/, or the equivalent top-level grouping for this project), identified by inspecting the changed paths. Pick the primary module affected by the change, not a secondary or incidental one.
- Keep the scope at a coarse level, not too granular: a codebase typically has fewer than 10 distinct scopes in use across its history. Prefer a broad module name (e.g. "daemon", "pipeline", "cli") over a narrow file or sub-feature name. If you cannot confidently identify a real primary module, omit the scope and use "type: description".
- Body: a "## What Changed" section in GitHub-flavored markdown. 1-3 concise bullet points describing the concrete changes in this branch (what code/behavior shifted), not the user's motivation. Do not include Intent, Risk Assessment, Testing, or Pipeline sections - those are prepended/appended separately. The body value must be plain markdown text, never a JSON object or serialized JSON string.
- Do not invent tests or behavior.

Commit history:
${commitLog}

Diff stat:
${diffStat}${pipelineContext}${userIntentPromptSection(sctx)}${executionContextPromptSection()}`;

        let result: Result;
        try {
            result = await sctx.agent.run(
                { prompt, cwd: sctx.workDir, jsonSchema: prContentSchema, onChunk: sctx.logChunk },
                signal
            );
        } catch (err) {
            log.warn("agent failed for PR content, using fallback", "error", errMessage(err));
            return fallbackPRContent(sctx, branch, commitLog, riskLine, testingMD, pipelineMD);
        }

        const content = decodePRContent(result.output);
        if (content !== null) {
            content.title = content.title.trim();
            content.body = content.body.trim();
            content.body = unwrapNestedPRBody(content.body);
            content.body = stripGeneratedSections(content.body);
            if (content.title !== "" && content.body !== "") {
                const originalTitle = content.title;
                content.title = tightenTitle(content.title);
                if (content.title !== originalTitle) {
                    log.warn("tightened agent PR title type", "from", originalTitle, "to", content.title);
                }
                content.body = appendGeneratedSections(content.body, riskLine, testingMD, pipelineMD);
                content.body = prependIntentSection(content.body, sctx);
                return content;
            }
        }

        return fallbackPRContent(sctx, branch, commitLog, riskLine, testingMD, pipelineMD);
    }

    /**
     * Queries step results and rounds from the DB and produces the deterministic
     * pipeline, risk, and testing sections.
     */
    private buildPipelineSection(sctx: StepContext): [string, string, string] {
        let steps: StepResult[];
        try {
            steps = getStepsByRun(sctx.db, sctx.run.id);
        } catch (err) {
            log.warn("failed to query step results for pipeline summary", "error", errMessage(err));
            return ["", "", ""];
        }

        const rounds = new Map<string, StepRound[]>();
        for (const sr of steps) {
            let r: StepRound[];
            try {
                r = getRoundsByStep(sctx.db, sr.id);
            } catch (err) {
                log.warn("failed to query rounds for step", "step", sr.stepName, "error", errMessage(err));
                continue;
            }
            rounds.set(sr.id, r);
        }

        const [pipelineMD, riskLine] = buildPipelineSummary(steps, rounds);
        const testingMD = buildTestingSummaryForPR(steps, rounds, sctx.repo.upstreamUrl, sctx.run.headSha, sctx.workDir);
        return [pipelineMD, riskLine, testingMD];
    }
}

function describePR(pr: PR | null): string {
    if (pr === null) return "";
    if (pr.url !== "") return pr.url;
    if (pr.number !== "") return `#${pr.number}`;
    return "";
}

/**
 * Detects when the agent returned the body as a serialized prContent JSON string
 * and extracts the real markdown body.
 */
function unwrapNestedPRBody(body: string): string {
    if (body.length === 0 || body[0] !== "{") return body;
    let nested: unknown;
    try {
        nested = JSON.parse(body);
    } catch {
        return body;
    }
    const decoded = decodePRContent(nested);
    if (decoded === null) return body;
    if (decoded.body.trim() !== "") {
        log.warn("agent returned nested JSON in PR body, unwrapping");
        return decoded.body.trim();
    }
    return body;
}

/** Appends the deterministic sections after the agent's body. */
function appendGeneratedSections(body: string, riskLine: string, testingMD: string, pipelineMD: string): string {
    body = stripGeneratedSections(body);
    if (riskLine !== "") {
        body += `\n\n## Risk Assessment\n\n${riskLine}`;
    }
    if (testingMD !== "") {
        body += `\n\n${testingMD}`;
    }
    if (pipelineMD !== "") {
        body += `\n\n${pipelineMD}`;
    }
    return body;
}

function stripGeneratedSections(body: string): string {
    if (body === "") return "";

    const lines = body.split("\n");
    const out: string[] = [];
    let skipping = false;

    for (const raw of lines) {
        const line = raw.trim();

        if (skipping) {
            if (line.startsWith("## ")) {
                if (isGeneratedSectionHeading(line)) continue;
                skipping = false;
            } else {
                continue;
            }
        }

        if (isGeneratedSectionHeading(line)) {
            skipping = true;
            continue;
        }

        out.push(raw);
    }

    return out.join("\n").trim();
}

function isGeneratedSectionHeading(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith("##")) return false;

    let heading = trimmed.slice(2).trim();
    heading = trimRightChars(heading, ":.!? ");
    heading = heading.toLowerCase();

    switch (heading) {
        case "intent":
        case "risk assessment":
        case "testing":
        case "tests":
        case "pipeline":
            return true;
        default:
            return false;
    }
}

/** Trims trailing characters in `cutset` from `s` (Go strings.TrimRight). */
function trimRightChars(s: string, cutset: string): string {
    let end = s.length;
    while (end > 0 && cutset.includes(s[end - 1])) end--;
    return s.slice(0, end);
}

/**
 * Prepends a "## Intent" section sourced from the already-extracted user intent,
 * reused verbatim after the same secret/adversarial scrubbing. Returns body
 * unchanged when no intent is available.
 */
function prependIntentSection(body: string, sctx: StepContext): string {
    const cleaned = cleanedUserIntent(sctx);
    if (cleaned === "") return body;
    const section = `## Intent\n\n${cleaned}`;
    if (body.trim() === "") return section;
    return `${section}\n\n${body}`;
}

function fallbackPRContent(
    sctx: StepContext,
    branch: string,
    commitLog: string,
    riskLine: string,
    testingMD: string,
    pipelineMD: string
): PRContent {
    let title = "";
    for (const rawLine of commitLog.split("\n")) {
        const line = rawLine.trim();
        if (line === "") continue;
        const idx = line.indexOf(" ");
        if (idx >= 0 && idx + 1 < line.length) {
            title = line.slice(idx + 1).trim();
        }
        break;
    }
    if (title === "") {
        title = branch.trim();
    }
    if (title === "") {
        title = "chore: update pull request";
    } else {
        title = tightenTitle(title);
    }
    let body = `## What Changed\n\n${commitLog.trim()}`;
    if (body === "## What Changed\n\n") {
        body = `## What Changed\n\n- ${title}`;
    }
    body = appendGeneratedSections(body, riskLine, testingMD, pipelineMD);
    body = prependIntentSection(body, sctx);
    return { title, body };
}
