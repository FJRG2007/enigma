/**
 * Gate findings algebra and step order: parse/marshal round-trips (incl. legacy
 * `items` + `requires_human_review` wire keys), filter/exclude/auto-fix/merge,
 * and the fixed 9-step pipeline order. Pure - no filesystem or runtime state.
 */
import { test, expect } from "bun:test";
import * as types from "../../src/gate/types";

test("allSteps is the fixed 9-step order", () => {
    expect(types.allSteps()).toEqual(["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"]);
    expect(types.stepOrder("review")).toBe(3);
    expect(types.stepOrder("ci")).toBe(9);
    expect(types.stepOrder("unknown" as never)).toBe(0);
});

test("parseFindingsJSON accepts legacy items key and requires_human_review", () => {
    const f = types.parseFindingsJSON(
        "{\"items\":[{\"severity\":\"warning\",\"description\":\"choice\",\"requires_human_review\":true},{\"severity\":\"error\",\"description\":\"bug\",\"requires_human_review\":false}]}"
    );
    expect(f.items.length).toBe(2);
    expect(f.items[0].action).toBe(types.ACTION_ASKUSER);
    expect(f.items[1].action).toBe(types.ACTION_AUTOFIX);
});

test("autoFixableFindings keeps auto-fix (and empty action), drops ask-user/no-op", () => {
    const f = types.parseFindingsJSON(
        "{\"findings\":[{\"id\":\"f1\",\"severity\":\"error\",\"description\":\"bug\",\"action\":\"auto-fix\"},{\"id\":\"f2\",\"severity\":\"warning\",\"description\":\"choice\",\"action\":\"ask-user\"},{\"id\":\"f3\",\"severity\":\"info\",\"description\":\"note\",\"action\":\"no-op\"},{\"id\":\"f4\",\"severity\":\"error\",\"description\":\"empty\"}]}"
    );
    const fixable = types.autoFixableFindings(f);
    expect(fixable.items.map(i => i.id)).toEqual(["f1", "f4"]);
});

test("hasActionableFindings is false only for all-no-op/empty", () => {
    expect(types.hasActionableFindings(types.parseFindingsJSON("{\"findings\":[{\"severity\":\"x\",\"description\":\"d\",\"action\":\"no-op\"}]}"))).toBe(false);
    expect(types.hasActionableFindings(types.parseFindingsJSON("{\"findings\":[]}"))).toBe(false);
    expect(types.hasActionableFindings(types.parseFindingsJSON("{\"findings\":[{\"severity\":\"x\",\"description\":\"d\",\"action\":\"ask-user\"}]}"))).toBe(true);
});

test("filterFindings keeps selected and rewrites summary; preserves risk fields", () => {
    const f = types.parseFindingsJSON(
        "{\"findings\":[{\"id\":\"a\",\"severity\":\"error\",\"description\":\"x\"},{\"id\":\"b\",\"severity\":\"warn\",\"description\":\"y\"}],\"risk_level\":\"medium\",\"risk_rationale\":\"r\"}"
    );
    const sel = types.filterFindings(f, ["a"]);
    expect(sel.items.map(i => i.id)).toEqual(["a"]);
    expect(sel.riskLevel).toBe("medium");
    expect(sel.summary).toBe("1 selected finding");
});

test("mergeUserOverrides attaches instructions and appends user findings with user-N ids", () => {
    const f = types.parseFindingsJSON("{\"findings\":[{\"id\":\"review-1\",\"severity\":\"error\",\"description\":\"bug\"}]}");
    const merged = types.mergeUserOverrides(f, { "review-1": "only parser.go" }, [
        { severity: "warning", description: "also logger", action: "" }
    ]);
    expect(merged.items[0].userInstructions).toBe("only parser.go");
    expect(merged.items[1].id).toBe("user-1");
    expect(merged.items[1].source).toBe(types.FINDING_SOURCE_USER);
    expect(merged.items[1].action).toBe(types.ACTION_AUTOFIX);
    // Original not mutated.
    expect(f.items[0].userInstructions ?? "").toBe("");
});

test("no-op constant is the informational action", () => {
    expect(types.ACTION_NOOP).toBe("no-op");
});
