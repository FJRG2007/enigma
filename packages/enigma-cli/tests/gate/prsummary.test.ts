/**
 * The Pipeline section of a gate PR body. Each step is a <details> block, and GitHub renders no
 * markdown inside <summary>, so the step name's bold has to reach it as HTML or the reader sees
 * literal asterisks.
 */
import { test, expect } from "bun:test";
import type { StepResult } from "@/gate/db";
import { buildPipelineSummary } from "@/gate/pipeline/steps/prsummary";

const step = (stepName: string, status: string): StepResult => ({
    id: stepName, runId: "run", stepName, stepOrder: 0, status, exitCode: 0, durationMs: 1,
    logPath: null, findingsJson: null, error: null, startedAt: 1, completedAt: 2,
} as StepResult);

test("a step summary carries its name in HTML bold, never markdown asterisks", () => {
    const [body] = buildPipelineSummary([step("lint", "passed"), step("test", "skipped")], new Map());
    const summaries = body.match(/<summary>.*<\/summary>/g) ?? [];
    expect(summaries.length).toBe(2);
    for (const line of summaries) expect(line).not.toContain("**");
    expect(summaries[0]).toContain("<b>Lint</b>");
    expect(summaries[1]).toBe("<summary>⏭️ <b>Test</b> - skipped</summary>");
});
