/**
 * Document step: updates project documentation to reflect code changes. Faithful
 * 1:1 port of the upstream `internal/pipeline/steps/document.go`.
 *
 * Go threaded `context.Context`; here the StepContext carries an `AbortSignal`.
 * Go's `result.Output` was raw JSON bytes decoded per call; the ported
 * `Result.output` is already the parsed structured value, so the document
 * helpers inspect that value directly instead of unmarshaling bytes.
 *
 * `commitAgentFixes` is the package-shared helper from Go's `common_fix.go`,
 * imported from the ported commonFix module. `sanitizedPreviousFindingsForPrompt`
 * is Go's review.go helper, inlined until review.ts is ported.
 */

import * as git from "@/gate/git";
import { commitAgentFixes } from "./commonFix";
import type { Result } from "@/gate/agent/agent";
import { hasNonIgnoredPath } from "./commonDiff";
import { hasBlockingFindings } from "../findings";
import { resolveBranchBaseSHA } from "./commonGit";
import { userIntentPromptSection } from "./rebase";
import { roundHistoryPromptSection } from "./roundHistory";
import { executionContextPromptSection } from "./executionContext";
import { newStepOutcome, type Step, type StepContext, type StepOutcome } from "../types";
import { findingsSchema, sanitizePromptText, sanitizePromptMultilineText } from "./common";
import {
    STEP_DOCUMENT,
    ACTION_ASKUSER,
    type StepName,
    type Findings,
    parseFindingsJSON,
    marshalFindingsJSON
} from "@/gate/types";

/** DocumentStep updates project documentation to reflect code changes. */
export class DocumentStep implements Step {
    name(): StepName {
        return STEP_DOCUMENT;
    }

    async execute(sctx: StepContext): Promise<StepOutcome> {
        const signal = sctx.signal;
        const baseSHA = await resolveBranchBaseSHA(
            signal, sctx.workDir, sctx.run.baseSha, sctx.repo.defaultBranch, sctx.log
        );

        let ignorePatterns = "none";
        if (sctx.config.ignorePatterns.length > 0) {
            ignorePatterns = sctx.config.ignorePatterns.join(", ");
        }

        // Skip entirely when nothing the agent would document has changed.
        let changedFiles: string[];
        try {
            changedFiles = await git.diffNameOnly(sctx.workDir, baseSHA, sctx.run.headSha, { signal });
        } catch (err) {
            throw new Error(`get changed files: ${errMessage(err)}`);
        }
        if (!hasNonIgnoredPath(changedFiles, sctx.config.ignorePatterns)) {
            sctx.log("no changes to document");
            return newStepOutcome();
        }

        sctx.log("updating documentation...");

        const historySection =
            executionContextPromptSection() + roundHistoryPromptSection(sctx) + userIntentPromptSection(sctx);
        let prompt = `Bring the project documentation fully in sync with the code changes. Discover every documentation gap, fix all of them yourself, verify your edits, and report only what you could not resolve.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
- default branch: ${sctx.repo.defaultBranch}
- ignore patterns: ${ignorePatterns}

Task:

1. Understand the change
   - Read the diff and changed files to understand what was added, modified, or removed.
   - Identify the intent and scope of the change (new feature, API change, config change, behavioral change, etc.).

2. Find every documentation gap
   - Look for existing documentation across the project: README.md, docs/, doc comments, config examples, etc.
   - Be exhaustive. Enumerate all docs affected by the change before you start editing. Common cases:
     - New or changed public APIs - update API docs, doc comments, or usage examples
     - New features or behaviors - update README or relevant guide
     - Changed configuration - update config docs or examples
     - Removed functionality - remove or update stale references
   - Do not stop after the first documentation gap. Keep scanning the rest of the affected docs until you have found every gap you can substantiate.

3. Fix all of them yourself
   - Update each affected documentation file or doc comment directly. Keep edits minimal and match the existing documentation style.
   - After editing, re-read the docs you changed to verify they now reflect the code.
   - This is a single pass with no follow-up round. Do not defer a known gap; resolve every gap you can in this run.

4. Report only what remains
   - Return a finding only for documentation gaps you could not resolve yourself, or that need a human judgment call (e.g. ambiguous intent or conflicting docs).
   - Do not report gaps you already fixed.
   - If you fixed everything and no documentation work remains, return an empty findings array.

Rules:
- Only edit documentation files or doc comments. Do not change executable behavior or tests.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}`;
        if (sctx.previousFindings !== "") {
            prompt += `

Previous documentation findings to address:
${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`;
        }

        let result: Result;
        try {
            result = await sctx.agent.run(
                {
                    prompt,
                    cwd: sctx.workDir,
                    jsonSchema: findingsSchema,
                    onChunk: sctx.logChunk
                },
                signal
            );
        } catch (err) {
            throw new Error(`agent document: ${errMessage(err)}`);
        }

        // Commit whatever documentation the agent edited, regardless of how
        // trustworthy its structured output turns out to be.
        const commitSummary = extractDocumentSummary(result.output, "");
        await commitAgentFixes(sctx, this.name(), commitSummary, "update documentation");

        // Without trustworthy structured output we cannot confirm the agent
        // resolved every gap, so surface it for human review.
        if (result.output === undefined || result.output === null) {
            const summary = fallbackDocumentSummary(result.text);
            sctx.log("missing structured output, requiring approval");
            return documentApprovalOutcome(summary);
        }
        let findings: Findings;
        try {
            findings = unmarshalRequiredFindings(result.output);
        } catch {
            const summary = fallbackDocumentSummary(extractDocumentSummary(result.output, result.text));
            sctx.log("could not parse structured output, requiring approval");
            return documentApprovalOutcome(summary);
        }

        const needsApproval = hasBlockingFindings(findings.items, sctx.repo.workingPath);
        const findingsJSON = marshalFindingsJSON(findings);

        sctx.log(`document findings: ${findings.items.length} unresolved items`);

        return newStepOutcome({
            needsApproval,
            autoFixable: false,
            findings: findingsJSON,
            fixSummary: findings.summary
        });
    }
}

/** Constructs a new DocumentStep. */
export function newDocumentStep(): DocumentStep {
    return new DocumentStep();
}

/**
 * Builds a single ask-user finding for cases where the agent's structured output
 * is missing or unparsable, so a human can confirm the documentation state
 * instead of silently trusting an opaque response.
 */
function documentApprovalOutcome(summary: string): StepOutcome {
    const findings: Findings = {
        items: [
            {
                severity: "warning",
                description: summary,
                action: ACTION_ASKUSER
            }
        ],
        summary,
        riskLevel: "",
        riskRationale: ""
    };
    return newStepOutcome({
        needsApproval: true,
        autoFixable: false,
        findings: marshalFindingsJSON(findings),
        fixSummary: summary
    });
}

function fallbackDocumentSummary(text: string): string {
    const cleaned = text.trim();
    if (cleaned === "") return "agent returned no structured output";
    return cleaned;
}

/** Extracts the `summary` field from parsed structured output, or the fallback. */
function extractDocumentSummary(raw: unknown, fallback: string): string {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const summary = (raw as Record<string, unknown>).summary;
        if (typeof summary === "string" && summary.trim() !== "") return summary;
    }
    return fallback;
}

/**
 * Validates that the parsed structured output carries a findings/items array, a
 * non-empty summary, and complete fields on every finding. Throws when any
 * requirement is unmet, so the caller can fall back to manual approval.
 */
function unmarshalRequiredFindings(raw: unknown): Findings {
    const parsed = parseFindingsJSON(JSON.stringify(raw));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("missing findings array");
    }
    const payload = raw as Record<string, unknown>;
    const hasFindings = payload.findings !== undefined && payload.findings !== null;
    const hasItems = payload.items !== undefined && payload.items !== null;
    if (!hasFindings && !hasItems) {
        throw new Error("missing findings array");
    }
    const summary = payload.summary;
    if (typeof summary !== "string" || summary.trim() === "") {
        throw new Error("missing summary");
    }
    parsed.items.forEach((item, i) => {
        if ((item.severity ?? "").trim() === "") throw new Error(`finding ${i} missing severity`);
        if ((item.description ?? "").trim() === "") throw new Error(`finding ${i} missing description`);
        if ((item.action ?? "").trim() === "") throw new Error(`finding ${i} missing action`);
    });
    return parsed;
}

/**
 * Sanitizes a prior findings JSON blob for safe embedding in the agent prompt,
 * neutralizing untrusted text in every field. Falls back to a multiline-
 * sanitized copy of the raw input when the JSON cannot be parsed or re-encoded.
 */
function sanitizedPreviousFindingsForPrompt(raw: string): string {
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return sanitizePromptMultilineText(raw);
    }
    for (const item of findings.items) {
        item.id = sanitizePromptText(item.id ?? "");
        item.severity = sanitizePromptText(item.severity ?? "");
        item.file = sanitizePromptText(item.file ?? "");
        item.description = sanitizePromptMultilineText(item.description ?? "");
        item.source = sanitizePromptText(item.source ?? "");
        item.userInstructions = sanitizePromptMultilineText(item.userInstructions ?? "");
    }
    findings.summary = sanitizePromptMultilineText(findings.summary);
    findings.riskLevel = sanitizePromptText(findings.riskLevel);
    findings.riskRationale = sanitizePromptMultilineText(findings.riskRationale);
    try {
        return marshalFindingsJSON(findings);
    } catch {
        return sanitizePromptMultilineText(raw);
    }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
