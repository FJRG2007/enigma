/**
 * Review step: inspects the branch diff for bugs, security issues, and
 * simplification opportunities, returning structured findings plus a risk
 * assessment. In fix mode it first asks the agent to address prior findings.
 * Faithful port of the upstream `internal/pipeline/steps/review.go`.
 *
 * Go threaded `context.Context`; here the StepContext carries an `AbortSignal`.
 * Go's `(value, error)` returns become throws. The agent's `result.Output` was
 * raw JSON bytes decoded via json.Unmarshal; here `result.output` is already a
 * parsed value, so it is re-encoded and run through parseFindingsJSON to apply
 * the same legacy-aware decoding. The prompt sanitizers live in ./common (the
 * shared home Go declared in review.go); `sanitizedPreviousFindingsForPrompt`
 * stays here, matching Go's file, and is imported by lint.ts.
 */

import * as git from "@/gate/git";
import { executeFixMode } from "./commonFix";
import type { Result } from "@/gate/agent/agent";
import { hasBlockingFindings } from "../findings";
import { resolveBranchBaseSHA } from "./commonGit";
import { userIntentPromptSection } from "./intentPrompt";
import { roundHistoryPromptSection } from "./roundHistory";
import { executionContextPromptSection } from "./executionContext";
import { hasNonIgnoredPath, isIgnoredPath, isTestFile } from "./commonDiff";
import { newStepOutcome, type Step, type StepContext, type StepOutcome } from "../types";
import { reviewFindingsSchema, sanitizePromptText, sanitizePromptMultilineText } from "./common";
import {
    emptyFindings,
    parseFindingsJSON,
    marshalFindingsJSON,
    STEP_REVIEW,
    type Findings,
    type StepName
} from "@/gate/types";

/** Returns the message of an unknown thrown value, mirroring Go's `%w` wrap. */
function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Reviews the diff for bugs, security issues, and doc gaps. */
export class ReviewStep implements Step {
    name(): StepName {
        return STEP_REVIEW;
    }

    async execute(sctx: StepContext): Promise<StepOutcome> {
        const signal = sctx.signal;
        const baseSHA = await resolveBranchBaseSHA(
            signal, sctx.workDir, sctx.run.baseSha, sctx.repo.defaultBranch, sctx.log
        );
        const branch = sctx.run.branch;
        let ignorePatterns = "none";
        if (sctx.config.ignorePatterns.length > 0) {
            ignorePatterns = sctx.config.ignorePatterns.join(", ");
        }

        let reviewScope = `branch changes between ${baseSHA} and ${sctx.run.headSha}`;
        if (sctx.fixing) {
            reviewScope = `current worktree and HEAD changes relative to base commit ${baseSHA} (starting head ${sctx.run.headSha})`;
        }

        // In fix mode, ask the agent to fix issues first.
        let fixSummary = "";
        if (sctx.fixing) {
            const previousFindings = sanitizedPreviousFindingsForPrompt(sctx.previousFindings);
            const historySection =
                executionContextPromptSection() + roundHistoryPromptSection(sctx) + userIntentPromptSection(sctx);
            const fixPrompt = `Investigate previous review findings and address legitimate ones.

Examine the relevant code yourself and apply fixes directly.

Context:
- branch: ${branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
- review scope: ${reviewScope}
- default branch: ${sctx.repo.defaultBranch}
- ignore patterns: ${ignorePatterns}

Rules:
- Always start with double checking whether the findings are legitimate.
- Before changing code, identify whether each finding is a local defect or a symptom of a deeper design, abstraction, validation, ownership, or test-coverage flaw. Prefer the smallest correct root-cause fix within the changed area over patching only the reported line.
- If a narrow fix would leave the same class of bug likely elsewhere, fix the deepest practical cause instead.
- Avoid resolving a finding by removing or reverting the author's intentional code in their original 1st commit. If the original change introduced something on purpose, fix it forward (e.g. add validation, handle edge cases, tighten logic) rather than deleting it. Similarly, if the original change intentionally deleted or simplified code, do not restore or re-add the removed code unless the finding is a legitimate correctness, reliability, or security issue and the smallest reasonable fix happens to reintroduce a small amount of previously deleted logic. When in doubt about whether code is intentional, leave it and report the finding as unresolved.
- Do not add code comments explaining your fixes.
- Verify that the issues are resolved before finishing.
- Return JSON with a single "summary" field when you are done.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}

Previous review findings to address:
${previousFindings}`;
            fixSummary = await executeFixMode(sctx, this.name(), {
                requirePreviousFindings: true,
                missingFindingsError: "review fix requires previous review findings",
                logMessage: "asking agent to fix identified issues...",
                prompt: fixPrompt,
                errorPrefix: "agent fix",
                fallbackSummary: "address review findings"
            });
        }

        // Check whether there are any reviewable changed files after applying ignore patterns.
        // In fix mode the comparison is base against the worktree, so head stays empty.
        let changedFiles: string[];
        try {
            changedFiles = await git.diffNameOnly(
                sctx.workDir,
                baseSHA,
                sctx.fixing ? "" : sctx.run.headSha,
                { signal }
            );
        } catch (err) {
            throw new Error(`get changed files: ${errMessage(err)}`);
        }

        if (!hasNonIgnoredPath(changedFiles, sctx.config.ignorePatterns)) {
            sctx.log("no changes to review");
            const noChangeFindings: Findings = {
                items: [],
                summary: "",
                riskLevel: "low",
                riskRationale: "no reviewable changes"
            };
            const findingsJSON = marshalFindingsJSON(noChangeFindings);
            return newStepOutcome({ findings: findingsJSON, fixSummary });
        }

        // Ask agent to review.
        sctx.log("reviewing changes...");

        const historySection =
            executionContextPromptSection() + roundHistoryPromptSection(sctx) + userIntentPromptSection(sctx);

        const prompt = buildReviewPrompt({
            branch,
            baseSHA,
            headSha: sctx.run.headSha,
            reviewScope,
            defaultBranch: sctx.repo.defaultBranch,
            ignorePatterns,
            uiTouched: touchesUI(changedFiles.filter(path => !isIgnoredPath(path, sctx.config.ignorePatterns))),
            historySection
        });

        let result: Result;
        try {
            result = await sctx.agent.run(
                {
                    prompt,
                    cwd: sctx.workDir,
                    jsonSchema: reviewFindingsSchema,
                    onChunk: sctx.logChunk
                },
                signal
            );
        } catch (err) {
            throw new Error(`agent review: ${errMessage(err)}`);
        }

        // Parse structured findings.
        let findings: Findings = emptyFindings();
        if (result.output !== undefined && result.output !== null) {
            try {
                findings = parseFindingsJSON(JSON.stringify(result.output));
            } catch {
                sctx.log("could not parse structured output, using text response");
                findings = { ...emptyFindings(), summary: result.text };
            }
        }

        const needsApproval = hasBlockingFindings(findings.items, sctx.repo.workingPath);
        const findingsJSON = marshalFindingsJSON(findings);

        return newStepOutcome({
            needsApproval,
            autoFixable: findings.items.length > 0,
            findings: findingsJSON,
            fixSummary
        });
    }
}

/** Constructs the review step. */
export function newReviewStep(): Step {
    return new ReviewStep();
}

/** Extensions whose files render user-facing UI or its copy. */
const UI_EXTENSIONS = [".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".mdx"];

/**
 * Reports whether a changed-file list contains user-facing UI (markup, styles, components, site
 * pages). Test files never count, so a `.test.tsx` alone keeps the styling rule strict.
 */
export function touchesUI(paths: string[]): boolean {
    return paths.some(path => {
        const lower = path.toLowerCase();
        return UI_EXTENSIONS.some(ext => lower.endsWith(ext)) && !isTestFile(path);
    });
}

/** Inputs of the review prompt, already resolved by the step. */
export interface ReviewPromptInput {
    branch: string;
    baseSHA: string;
    headSha: string;
    reviewScope: string;
    defaultBranch: string;
    ignorePatterns: string;
    uiTouched: boolean;
    historySection: string;
}

/**
 * The copy and design lens, appended only when the diff touches UI files. Findings stay in the
 * existing wire shape: the tell, its quoted line and confidence go in the description.
 */
const UI_LENS_SECTION = `

UI lens (the diff touches user-facing UI files, so review the changed copy and visual design too):
- Copy describes the user's outcome or decision, never the mechanism: "At least 12 characters", not "Hashed with Argon2id". Test each clause with "would a user act differently knowing this?"; if not, it is a finding.
- Copy tells: one or two examples instead of the full list of supported items; no "powered by", "built with" or "inspired by"; no AI vocabulary (delve, seamless, robust, leverage, elevate, unlock, pivotal, showcase); no "It's not X, it's Y", forced triads, "Let's dive in", "simply"/"just", chat residue ("I hope this helps", "[Your Company]"), Title Case headings, or typographic dashes; errors say what happened and how to fix it, with no "Oops" or raw codes; buttons name the action, never "Submit" or "Click here".
- Design tells: a card inside a card; more than one boundary treatment on one edge (space first, then a background tone, then a border only where it carries information); a shadow on something not raised; default purple/indigo gradients or gradient text; a generic sparkles icon for "AI" or a second icon library; emoji as icons or bullets; a badge pill or eyebrow above every heading; a colored left-border stripe on a rounded card; decorative glow, blobs or glass; fade-up or bounce on every section; centered multi-line text; grey text on a colored background.
- Report only tells present in the changed lines. Use severity "info" or "warning" ("error" only when copy misleads the user about what happened or a control becomes unusable) and action "auto-fix", or "ask-user" when the user intent asked for that look or wording. Taste without a named tell is not a finding.`;

/** Builds the review prompt. Exported so the prompt contract can be tested without an agent. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
    const stylingRule = input.uiTouched
        ? "- Do NOT report formatting, linting, compilation, or type-checking issues. Report styling and copy only through the UI lens below."
        : "- Do NOT report styling, formatting, linting, compilation, or type-checking issues.";
    const uiLens = input.uiTouched ? UI_LENS_SECTION : "";
    return `Review the code changes and return structured findings with a risk assessment.

Context:
- branch: ${input.branch}
- base commit: ${input.baseSHA}
- target commit: ${input.headSha}
- review scope: ${input.reviewScope}
- default branch: ${input.defaultBranch}
- ignore patterns: ${input.ignorePatterns}

Task:
- Read the relevant history and diff yourself.
- Start with a scope-drift pre-pass: compare what the diff changes against the user intent below (or, when none is stated, what the commits say they set out to do). Changed code that does something the intent did not ask for (an unrelated refactor, a feature nobody requested, files outside the stated scope) is one "ask-user" finding; so is a stated ask the diff leaves undone. Supporting changes the intent needs (tests, docs, a helper it calls) are not drift.
- Focus findings on risks introduced by changed code, but inspect surrounding code, call sites, shared helpers, tests, and invariants when needed to understand root cause.
- Do NOT run tests during review. The pipeline has a dedicated test step after review.
- Analyze for bugs, risks, and code simplification opportunities.
- "Simplification" means reducing code complexity through non-functional refactoring (e.g. deduplication, clearer control flow). It does NOT mean removing features, changing product behavior, or stripping intentional user-facing output.
- Treat security issues, performance regressions, breaking changes, and insufficient error handling as risks.
- Do a full review pass before returning. Do not stop after the first valid finding. Continue inspecting the rest of the changed code until you have enumerated all material issues you can substantiate.

Rules:
- Anchor every finding to a specific file and one-indexed line number in the changed code when possible.
- Every finding carries its evidence: quote the offending line (or the smallest fragment that shows the problem) verbatim in the description, and end the description with "Confidence: high" or "Confidence: medium". Drop any finding you would rate low confidence or cannot back with a quoted line. Never pad the list to look thorough.
- Use severity "error" for problems that should absolutely not get merged, "warning" for things that are worth addressing but can be done in a follow up, and "info" for things that are nice to have.
- Be concise and actionable. No generic advice like "add more tests".
- Only comment on things that genuinely matter.
${stylingRule}
- If the change is clean, return an empty findings array, and make risk_rationale name the dimensions you checked (for example correctness, error handling, security, scope against intent${input.uiTouched ? ", copy and design" : ""}), so a clean result shows what it covered.
- For each finding, set the action field to one of:
  - "ask-user": fixing it would go against the stated user intent - it questions whether a deliberate choice should stand, changes agreed product behavior, or calls for a redesign rather than a repair. Examples: "this feature seems unnecessary", "this hardcoded value should be configurable", "this deletion looks wrong".
  - "auto-fix": the finding is a defect whose fix serves the stated intent (correctness, error handling, security, performance, mechanical code quality). Being user-visible does not make it "ask-user": a bug that defeats what the author set out to do is "auto-fix", because the only question it raises is one the intent already answered.
  - When in doubt, ask whether the fix would contradict the author's intent: if it would, use "ask-user"; if it would carry that intent out, use "auto-fix". When no user intent is stated below, infer it from the change itself (its commits, its diff, what it plainly set out to do); if the change gives no signal either way, the doubt is unresolved and the finding is "ask-user".
  - "no-op": the finding is informational and does not require any action (e.g. noting a pattern, acknowledging a tradeoff).${uiLens}

Risk assessment (after listing all findings):
- Set risk_level to "low" if the change is well-bounded, mostly cosmetic, or straightforward with little ambiguity.
- Set risk_level to "medium" if the change has room to improve but is safe to merge first with concerns addressed as follow-ups.
- Set risk_level to "high" if the change should not be merged without explicit human approval - it is fundamental, risky, ambiguous, or has strong negative signals.
- Provide a one-sentence risk_rationale explaining why you chose that risk level.${input.historySection}`;
}

/**
 * Returns the previous findings JSON re-encoded with every text field sanitized,
 * so untrusted prior-finding content embedded in a fix prompt cannot inject
 * structure. Falls back to the sanitized raw text when the JSON cannot be decoded
 * or re-encoded. Declared here (Go's review.go) and reused by lint.ts.
 */
export function sanitizedPreviousFindingsForPrompt(raw: string): string {
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
