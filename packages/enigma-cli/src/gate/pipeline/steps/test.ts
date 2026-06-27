/**
 * Test pipeline step: runs baseline tests, gathers evidence for the user intent,
 * and optionally asks the agent to fix failures. Faithful port of the
 * upstream `internal/pipeline/steps/test.go`.
 *
 * Go's `context.Context` maps to the StepContext's `AbortSignal`; Go
 * `(value, error)` maps to throw, and `json.Marshal(findings)` maps to
 * `marshalFindingsJSON`. `sanitizedPreviousFindingsForPrompt` lives in review.go
 * upstream; it is ported here as a private helper until review.ts is ported.
 */

import * as git from "../../git";
import { mkdirSync } from "node:fs";
import { STEP_TEST } from "../../types";
import { newStepOutcome } from "../types";
import { testFindingsSchema } from "./common";
import type { Result } from "../../agent/agent";
import { detectNewTestFiles } from "./commonDiff";
import { runStepShellCommand } from "./commonExec";
import { resolveBranchBaseSHA } from "./commonGit";
import { sep, relative, isAbsolute } from "node:path";
import type { TestEvidenceLocation } from "./evidence";
import { roundHistoryPromptSection } from "./roundHistory";
import type { StepName, Finding, Findings } from "../../types";
import type { Step, StepContext, StepOutcome } from "../types";
import { executeFixMode, hasBlockingFindings } from "./commonFix";
import { executionContextPromptSection } from "./executionContext";
import { parseFindingsJSON, marshalFindingsJSON } from "../../types";
import { cleanedUserIntent, userIntentPromptSection } from "./intent";
import { resolveTestEvidenceLocation, testEvidenceDir } from "./evidence";
import { sanitizePromptText, sanitizePromptMultilineText } from "./common";

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Converts the OS-native path separator to "/", mirroring filepath.ToSlash. */
function toSlash(path: string): string {
    return path.split(sep).join("/");
}

/** Reports whether `target` (inside `workDir`) is gitignored. */
async function gitIgnoresPath(signal: AbortSignal, workDir: string, target: string): Promise<boolean> {
    const rel = relative(workDir, target);
    if (rel === "." || rel === "" || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return false;
    }
    try {
        await git.run(workDir, ["check-ignore", "--quiet", "--", toSlash(rel)], signal);
        return true;
    } catch {
        return false;
    }
}

/**
 * Sanitizes a previous findings JSON payload for safe embedding into a prompt:
 * each finding field and the summary/risk fields are run through the prompt
 * sanitizers, then re-encoded. Falls back to sanitizing the raw text on a
 * parse/encode failure.
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
        item.severity = sanitizePromptText(item.severity);
        item.file = sanitizePromptText(item.file ?? "");
        item.description = sanitizePromptMultilineText(item.description);
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

/**
 * TestStep runs baseline tests, gathers evidence for user intent, and optionally
 * asks the agent to fix failures.
 */
export class TestStep implements Step {
    name(): StepName {
        return STEP_TEST;
    }

    async execute(sctx: StepContext): Promise<StepOutcome> {
        const signal = sctx.signal;
        const baseSHA = await resolveBranchBaseSHA(signal, sctx.workDir, sctx.run.baseSha, sctx.repo.defaultBranch);

        // In fix mode, ask the agent to fix test failures first.
        let newTestsFromFix: string[] = [];
        let fixSummary = "";
        if (sctx.fixing) {
            const historySection =
                executionContextPromptSection() + roundHistoryPromptSection(sctx) + userIntentPromptSection(sctx);
            let fixPrompt = `Fix the failing tests in this repository. Run the tests, identify failures, and fix either the tests or the code to make them pass.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}

Rules:
- Make the smallest correct root-cause fix.
- Do not refactor beyond what is needed for that root-cause fix.
- If tests fail, determine whether the problem is a real product/code failure, a setup/environment problem you can fix, or a flaky/infrastructure issue.
- Do NOT run linters, formatters, or static analysis tools.
- Re-run the relevant tests before finishing.
- Before finishing, remove any transient artifacts your testing created in the working tree (downloaded models, caches, build outputs, large binaries, or generated data directories) so they are not committed and pushed. Do not remove intentional source or test-file changes.
- Return JSON with a single "summary" field when you are done.
- The summary must be one concise sentence fragment suitable for a git commit subject.
- Keep the summary under 10 words.${historySection}`;
            if (sctx.previousFindings !== "") {
                fixPrompt += `

Previous test findings to address:
${sanitizedPreviousFindingsForPrompt(sctx.previousFindings)}`;
            }
            fixSummary = await executeFixMode(sctx, this.name(), {
                requirePreviousFindings: false,
                missingFindingsError: "",
                logMessage: "asking agent to fix test failures...",
                prompt: fixPrompt,
                errorPrefix: "agent fix tests",
                fallbackSummary: "fix test failures",
                afterAgentRun: async () => {
                    newTestsFromFix = await detectNewTestFiles(signal, sctx.workDir);
                }
            });
        }

        const testCmd = sctx.config.commands.test;
        const tested: string[] = [];
        if (testCmd !== "") {
            sctx.log(`running tests: ${testCmd}`);
            let output: string;
            let exitCode: number;
            try {
                [output, exitCode] = await runStepShellCommand(sctx, testCmd);
            } catch (err) {
                throw new Error(`run test command: ${errMessage(err)}`);
            }
            tested.push(testCmd);

            sctx.log(output);

            if (exitCode !== 0) {
                const findings: Findings = {
                    items: [
                        {
                            severity: "error",
                            description: `tests failed with exit code ${exitCode}`,
                            action: ""
                        }
                    ],
                    summary: output,
                    tested,
                    riskLevel: "",
                    riskRationale: ""
                };
                return newStepOutcome({
                    needsApproval: true,
                    autoFixable: true,
                    findings: marshalFindingsJSON(findings),
                    exitCode,
                    fixSummary
                });
            }
        }

        const useEvidenceAgent = testCmd === "" || cleanedUserIntent(sctx) !== "";
        if (useEvidenceAgent) {
            let evidenceLocation = resolveTestEvidenceLocation(
                sctx.workDir,
                sctx.run.branch,
                sctx.run.id,
                sctx.config.test.evidence
            );
            let evidenceDir = evidenceLocation.dir;
            if (evidenceLocation.storeInRepo && (await gitIgnoresPath(signal, sctx.workDir, evidenceDir))) {
                evidenceLocation = { dir: testEvidenceDir(sctx.run.id), storeInRepo: false } satisfies TestEvidenceLocation;
                evidenceDir = evidenceLocation.dir;
            }
            try {
                mkdirSync(evidenceDir, { recursive: true, mode: 0o755 });
            } catch (err) {
                throw new Error(`create test evidence dir: ${errMessage(err)}`);
            }
            if (testCmd === "") {
                sctx.log("no test command configured, asking agent to run tests...");
            } else {
                sctx.log("user intent available, asking agent to gather test evidence...");
            }
            const reassessHistory =
                executionContextPromptSection() + roundHistoryPromptSection(sctx) + userIntentPromptSection(sctx);
            let evidenceGuidance = `- Write new evidence files into this temporary evidence directory: ${evidenceDir}`;
            if (evidenceLocation.storeInRepo) {
                evidenceGuidance = `- Write new evidence files into this in-repo evidence directory; it is committed and pushed automatically, so artifacts render directly on the PR: ${evidenceDir}`;
            }
            let configuredTestCommand = "";
            if (testCmd !== "") {
                configuredTestCommand = `\nConfigured test command already ran successfully as baseline: \`${testCmd}\`\n`;
            }
            let result: Result;
            try {
                result = await sctx.agent.run(
                    {
                        prompt: `You are validating a code change by testing it. Examine the repository and run the appropriate tests yourself.

Context:
- branch: ${sctx.run.branch}
- base commit: ${baseSHA}
- target commit: ${sctx.run.headSha}
${configuredTestCommand}

Task:
- Understand the user intent before testing it. If extracted user intent is present, use it as the primary hint for what success means.
- Decide what evidence or artifacts would clearly demonstrate the user intent is satisfied. Unit tests passing is not sufficient evidence by itself.
- Demonstrate the user intent working end-to-end in a way consistent with how an end user would actually experience it.
- Prefer product-level artifacts: screenshots, GIFs, videos, rendered UI, CLI transcripts, API responses, persisted database state, generated PR markdown, logs, or other outputs that directly show the intended behavior working.
- For UI, HTML, CSS, Electron renderer, browser, visual layout, or copy-placement changes, attempt to capture reviewer-visible visual evidence.
- Prefer screenshots, images, videos, GIFs, or rendered HTML artifacts that show the actual end-user surface.
- DOM snapshots, selector assertions, and text-only render summaries are not substitutes for visual evidence when a rendered surface is available.
- If a UI-facing change has no screenshot, image, video, GIF, or rendered HTML artifact, state why in testing_summary.
${evidenceGuidance}
- Do not move, commit, or modify source files only to make evidence linkable. Record local evidence file paths exactly where you created them.
- Only use command output as an artifact when that output directly demonstrates the end-user experience or requested behavior. Generic pass/fail, coverage, or clean-worktree output is not sufficient evidence.
- Look for existing tests that would generate sufficient evidence. If they exist, run the smallest relevant set.
- If no existing test produces sufficient evidence, write or improve a test so that it does.
- If automated testing cannot produce the needed evidence, execute manual verification steps and record the evidence-producing steps you performed.
- If sufficient evidence is not possible, report a warning finding explaining what evidence is missing and why the user needs to decide what to do.
- Include a concise "testing_summary" sentence describing what you exercised and the overall result.
- The "testing_summary" must account for the complete test step: baseline commands that already ran, automated tests, manual or evidence-producing checks, artifacts gathered, and the overall result.
- Record the exact tests, manual checks, and evidence-producing steps you ran in a "tested" array. Prefer concrete commands or test selectors wrapped in backticks.
- Always include an "artifacts" array. Leave it empty when you produced no reviewer-visible evidence artifacts. Use artifact path for file artifacts, artifact url for externally visible artifacts, and artifact content for short logs or command output that should be shown directly in the PR.
- If tests fail, determine whether the problem is a real product/code failure, a setup/environment problem you can fix, or a flaky/infrastructure issue.
- If the issue is setup-related and fixable, fix it and retry the tests.

Rules:
- Do NOT run linters, formatters, or static analysis tools.
- Focus on testing and test-related fixes only.
- Before finishing, remove any transient artifacts your testing created in the working tree (downloaded models, caches, build outputs, large binaries, or generated data directories) so they are not committed and pushed. Do not remove intentional source or test-file changes, and leave evidence files in the dedicated evidence directory untouched.
- Keep "testing_summary" high-signal and natural language. Avoid raw logs and noisy counts.
- Always return a non-empty "tested" array describing what you exercised, even when all tests pass.
- Only report actionable findings: test failures, unfixable setup issues, flaky tests you identified, or missing evidence that prevents you from demonstrating the user intent.
- Do NOT report passing tests (whether existing or new), test counts, coverage summaries, or other non-actionable information.
- If all tests pass and there are no issues, return an empty findings array.
- Set action to "ask-user" for missing-evidence warning findings and only otherwise when a test failure seems desired and you question the author's intent of having the test in the first place. Set action to "auto-fix" for objective test failures that can be safely fixed. Set action to "no-op" for informational notes.${reassessHistory}`,
                        cwd: sctx.workDir,
                        jsonSchema: testFindingsSchema,
                        onChunk: sctx.logChunk
                    },
                    signal
                );
            } catch (err) {
                throw new Error(`agent run tests: ${errMessage(err)}`);
            }

            let findings: Findings = { items: [], summary: "", riskLevel: "", riskRationale: "" };
            if (result.output !== undefined && result.output !== null) {
                try {
                    findings = parseFindingsJSON(JSON.stringify(result.output));
                } catch {
                    sctx.log("could not parse structured output, using text response");
                    findings = { items: [], summary: result.text, riskLevel: "", riskRationale: "" };
                }
            }
            if (tested.length > 0) {
                findings.tested = [...tested, ...(findings.tested ?? [])];
            }

            let needsApproval = hasBlockingFindings(findings.items);
            let autoFixable = needsApproval;

            // Check if the agent wrote new test files.
            const newTests = await detectNewTestFiles(signal, sctx.workDir);
            if (newTests.length > 0) {
                needsApproval = true;
                autoFixable = false;
                for (const f of newTests) {
                    findings.items.push({
                        severity: "info",
                        file: f,
                        description: `new test file written by agent: ${f}`,
                        action: ""
                    });
                }
            }

            return newStepOutcome({
                needsApproval,
                autoFixable,
                findings: marshalFindingsJSON(findings),
                fixSummary
            });
        }

        // Check if the agent wrote new test files (fix mode runs the agent before
        // running tests).
        if (sctx.fixing && newTestsFromFix.length > 0) {
            const findings: Findings = {
                items: [],
                summary: "tests passed, but agent wrote new test files",
                tested,
                riskLevel: "",
                riskRationale: ""
            };
            for (const f of newTestsFromFix) {
                findings.items.push({
                    severity: "info",
                    file: f,
                    description: `new test file written by agent: ${f}`,
                    action: ""
                });
            }
            return newStepOutcome({
                needsApproval: true,
                findings: marshalFindingsJSON(findings),
                fixSummary
            });
        }

        sctx.log("all tests passed");
        const passed: Findings = { items: [], summary: "", tested, riskLevel: "", riskRationale: "" };
        return newStepOutcome({ findings: marshalFindingsJSON(passed), fixSummary });
    }
}

/** Returns a new test step. */
export function newTestStep(): Step {
    return new TestStep();
}
