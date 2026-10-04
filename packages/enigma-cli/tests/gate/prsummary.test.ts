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

// Local evidence used to be listed by absolute path - the operator's OS, account name and temp
// layout on a public PR page. The PR names the file and nothing else.
test("local test evidence is referenced by file name, never by its absolute path", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { testEvidenceDir } = await import("@/gate/pipeline/steps/evidence");
    const { buildTestingSummaryForPR } = await import("@/gate/pipeline/steps/prsummary");
    const dir = testEvidenceDir("RUNPRIVACY");
    mkdirSync(dir, { recursive: true });
    const shot = join(dir, "events-list.png");
    writeFileSync(shot, "png");
    const findings = JSON.stringify({ items: [], testingSummary: "Checked the events list.", artifacts: [{ kind: "image", label: "Events list", path: shot }] });
    const testStep = { ...step("test", "passed"), findingsJson: findings } as StepResult;
    const body = buildTestingSummaryForPR([testStep], new Map(), "", "", "");
    expect(body).toContain("events-list.png");
    expect(body).not.toContain(dir);
    expect(body).not.toContain("enigma-gate-evidence");
});
