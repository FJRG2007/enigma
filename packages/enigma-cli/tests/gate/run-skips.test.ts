/**
 * The shape of a run, decided before one starts.
 *
 * `--quick` exists because the caller often knows something the pipeline cannot: that the
 * suite was just run, or that the change is a line of CSS. What it must never do is buy
 * that speed by dropping the step the gate is for.
 */
import { test, expect } from "bun:test";

const { parseRunSkips, QUICK_SKIP_STEPS } = await import("../../src/gate/cli/steps");

test("without --quick, the skips are exactly what was asked for", () => {
    expect(parseRunSkips("", false)).toEqual([]);
    expect(parseRunSkips("lint", false)).toEqual(["lint"]);
    expect(parseRunSkips("push,pr,ci", false)).toEqual(["push", "pr", "ci"]);
});

test("--quick drops test and document, and nothing else", () => {
    expect(parseRunSkips("", true)).toEqual(["test", "document"]);
    expect(QUICK_SKIP_STEPS).toEqual(["test", "document"]);
});

test("--quick is additive: an explicit skip keeps its place and its steps", () => {
    expect(parseRunSkips("lint", true)).toEqual(["lint", "test", "document"]);
    // Asking for one of them twice is one skip, not a duplicate.
    expect(parseRunSkips("test", true)).toEqual(["test", "document"]);
});

test("review is never in a quick run - a fast gate is still a gate", () => {
    expect(parseRunSkips("", true)).not.toContain("review");
    expect(QUICK_SKIP_STEPS).not.toContain("review");
});

test("an unknown step is still refused, quick or not", () => {
    expect(() => parseRunSkips("nonsense", true)).toThrow();
    expect(() => parseRunSkips("nonsense", false)).toThrow();
});
