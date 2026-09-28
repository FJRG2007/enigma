/**
 * The review prompt: the scope-drift pre-pass, evidence and confidence per finding, a clean
 * result that names what it checked, and a copy/design lens that exists only for UI diffs. The
 * wire contract with the parser must not move.
 */
import { test, expect } from "bun:test";
import { parseFindingsJSON } from "@/gate/types";
import { reviewFindingsSchema } from "@/gate/pipeline/steps/common";
import { buildReviewPrompt, touchesUI, type ReviewPromptInput } from "@/gate/pipeline/steps/review";

const input = (uiTouched: boolean): ReviewPromptInput => ({
    branch: "feature/x", baseSHA: "base", headSha: "head", reviewScope: "branch changes",
    defaultBranch: "main", ignorePatterns: "none", uiTouched, historySection: "",
});

test("touchesUI counts markup, styles and components, never tests or backend files", () => {
    expect(touchesUI(["src/server.ts", "README.md", "src/app.go"])).toBe(false);
    expect(touchesUI(["src/Button.test.tsx", "src/view.spec.jsx"])).toBe(false);
    expect(touchesUI(["src/server.ts", "src/components/Card.tsx"])).toBe(true);
    expect(touchesUI(["apps/web/src/pages/index.astro"])).toBe(true);
    expect(touchesUI(["styles/Theme.CSS"])).toBe(true);
    expect(touchesUI([])).toBe(false);
});

test("a non-UI diff keeps the strict no-styling rule and gets no UI lens", () => {
    const prompt = buildReviewPrompt(input(false));
    expect(prompt).toContain("- Do NOT report styling, formatting, linting, compilation, or type-checking issues.");
    expect(prompt).not.toContain("UI lens");
    expect(prompt).not.toContain("copy and design");
});

test("a UI diff swaps the styling rule for the copy and design lens", () => {
    const prompt = buildReviewPrompt(input(true));
    expect(prompt).not.toContain("Do NOT report styling");
    expect(prompt).toContain("Report styling and copy only through the UI lens below.");
    expect(prompt).toContain("UI lens (the diff touches user-facing UI files");
    expect(prompt).toContain("\"At least 12 characters\", not \"Hashed with Argon2id\"");
    expect(prompt).toContain("a card inside a card");
    expect(prompt).toContain("Taste without a named tell is not a finding.");
    expect(prompt.indexOf("UI lens")).toBeLessThan(prompt.indexOf("Risk assessment"));
});

test("every prompt carries the scope-drift pre-pass, evidence rule and clean-result coverage", () => {
    for (const ui of [false, true]) {
        const prompt = buildReviewPrompt(input(ui));
        expect(prompt).toContain("Start with a scope-drift pre-pass");
        expect(prompt).toContain("quote the offending line");
        expect(prompt).toContain("\"Confidence: high\" or \"Confidence: medium\"");
        expect(prompt).toContain("Drop any finding you would rate low confidence");
        expect(prompt).toContain("make risk_rationale name the dimensions you checked");
    }
});

test("the prompt ends with the history section so the user intent stays last", () => {
    const prompt = buildReviewPrompt({ ...input(false), historySection: "\n\nUSER-INTENT-MARKER" });
    expect(prompt.endsWith("\n\nUSER-INTENT-MARKER")).toBe(true);
});

test("the wire contract is unchanged: no new required fields, evidence rides in the description", () => {
    expect(reviewFindingsSchema.required).toEqual(["findings", "risk_level", "risk_rationale"]);
    expect(reviewFindingsSchema.properties.findings.items.required).toEqual(["severity", "description", "action"]);
    const findings = parseFindingsJSON(JSON.stringify({
        findings: [{
            severity: "warning", file: "src/Login.tsx", line: 12, action: "auto-fix",
            description: "Hint leaks the mechanism: `Hashed with Argon2id`. Confidence: high",
        }],
        risk_level: "low",
        risk_rationale: "Checked correctness, error handling, security, scope against intent, copy and design.",
    }));
    expect(findings.items).toHaveLength(1);
    expect(findings.items[0].description).toContain("Confidence: high");
    expect(findings.riskRationale).toContain("scope against intent");
});
