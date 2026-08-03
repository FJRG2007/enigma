/**
 * Lint step: runs the configured lint command and, on failure, reports findings
 * the executor can route to an auto-fix round. When no lint command is
 * configured it asks the agent to detect, run, and fix the project's linters
 * directly, then commits the result. In fix mode it first asks the agent to fix
 * lint issues. Faithful port of the upstream
 * `internal/pipeline/steps/lint.go`.
 *
 * Go threaded `context.Context`; here the StepContext carries an `AbortSignal`,
 * and Go's `(value, error)` returns become throws. The no-command branch reuses
 * `extractCommitSummary` and `commitAgentFixes` from the ported commonFix module,
 * which is where they live in Go's common_fix.go too.
 */

import { findingsSchema } from "./common";
import type { Result } from "@/gate/agent/agent";
import { runStepShellCommand } from "./commonExec";
import { resolveBranchBaseSHA } from "./commonGit";
import { userIntentPromptSection } from "./intentPrompt";
import { roundHistoryPromptSection } from "./roundHistory";
import { sanitizedPreviousFindingsForPrompt } from "./review";
import { executionContextPromptSection } from "./executionContext";
import { newStepOutcome, type Step, type StepContext, type StepOutcome } from "../types";
import { commitAgentFixes, executeFixMode, extractCommitSummary, hasBlockingFindings } from "./commonFix";
import {
    emptyFindings,
    parseFindingsJSON,
    marshalFindingsJSON,
    STEP_LINT,
    type Findings,
    type StepName
} from "@/gate/types";

/** Returns the message of an unknown thrown value, mirroring Go's `%w` wrap. */
function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Runs linters and asks the agent to fix issues. */
export class LintStep implements Step {
    name(): StepName {
        return STEP_LINT;
    }

    async execute(sctx: StepContext): Promise<StepOutcome> {
        const signal = sctx.signal;
        const baseSHA = await resolveBranchBaseSHA(
            signal, sctx.workDir, sctx.run.baseSha, sctx.repo.defaultBranch, sctx.log
        );
        const lintCmd = sctx.config.commands.lint;

        if (lintCmd === "") {
            sctx.log("no lint command configured, asking agent to lint and fix...");
            const reassessHistory =
                executionContextPromptSection() + roundHistoryPromptSection(sctx) + userIntentPromptSection(sctx);
            let prompt = `Detect the linting and formatting tools for this project, run the relevant checks yourself, apply safe fixes, and verify the result.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}

Task:
- Discover the configured linters and formatters for this repository.
- Only lint or format the relevant changed files when possible.
- Apply safe formatter, linter, and static-analysis fixes yourself.
- Re-run the relevant checks after fixing.
- Report only unresolved lint, format, or static-analysis issues as structured findings.
- If everything is clean or fixed, return an empty findings array.

Rules:
- Do not run tests or broader behavioral validation.
- Focus on lint, format, and static-analysis issues only.
- Do not report issues you already fixed.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${reassessHistory}`;
            if (sctx.previousFindings !== "") {
                prompt += `\n\nPrevious lint findings to address:\n${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`;
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
                throw new Error(`agent lint: ${errMessage(err)}`);
            }

            let findings: Findings = emptyFindings();
            if (result.output !== undefined && result.output !== null) {
                try {
                    findings = parseFindingsJSON(JSON.stringify(result.output));
                } catch {
                    sctx.log("could not parse structured output, using text response");
                    findings = { ...emptyFindings(), summary: result.text };
                }
            }
            let summary = "";
            try {
                summary = extractCommitSummary(result);
            } catch (err) {
                sctx.log(`warning: could not parse lint summary: ${errMessage(err)}`);
            }
            await commitAgentFixes(sctx, this.name(), summary, "fix lint issues");

            const needsApproval = hasBlockingFindings(findings.items);
            const findingsJSON = marshalFindingsJSON(findings);
            return newStepOutcome({
                needsApproval,
                autoFixable: false,
                findings: findingsJSON,
                fixSummary: summary
            });
        }

        // In fix mode, ask agent to fix lint issues first.
        let fixSummary = "";
        if (sctx.fixing) {
            const historySection =
                executionContextPromptSection() + roundHistoryPromptSection(sctx) + userIntentPromptSection(sctx);
            let fixPrompt = `Fix the lint issues in this repository. Run the linter, identify all issues, and fix them.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}

Rules:
- Make the smallest correct root-cause fix.
- Do not refactor beyond what is needed for that root-cause fix.
- Do not run tests or broader behavioral validation.
- Re-run the relevant lint or format commands before finishing.
- Return JSON with a single "summary" field when you are done.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}`;
            if (sctx.previousFindings !== "") {
                fixPrompt += `\n\nPrevious lint findings to address:\n${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`;
            }
            fixSummary = await executeFixMode(sctx, this.name(), {
                requirePreviousFindings: false,
                missingFindingsError: "",
                logMessage: "asking agent to fix lint issues...",
                prompt: fixPrompt,
                errorPrefix: "agent fix lint",
                fallbackSummary: "fix lint issues"
            });
        }

        // Run configured lint command.
        sctx.log(`running linter: ${lintCmd}`);
        let output: string;
        let exitCode: number;
        try {
            [output, exitCode] = await runStepShellCommand(sctx, lintCmd);
        } catch (err) {
            throw new Error(`run lint command: ${errMessage(err)}`);
        }

        sctx.log(output);

        if (exitCode !== 0) {
            const findings: Findings = {
                items: [
                    {
                        severity: "warning",
                        description: `linter found issues (exit code ${exitCode})`,
                        action: ""
                    }
                ],
                summary: output,
                riskLevel: "",
                riskRationale: ""
            };
            const findingsJSON = marshalFindingsJSON(findings);
            return newStepOutcome({
                needsApproval: true,
                autoFixable: true,
                findings: findingsJSON,
                exitCode,
                fixSummary
            });
        }

        sctx.log("lint passed");
        return newStepOutcome({ fixSummary });
    }
}

/** Constructs the lint step. */
export function newLintStep(): Step {
    return new LintStep();
}
