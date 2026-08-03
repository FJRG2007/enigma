/**
 * Conventional-title helpers, and the emoji rule that sits between them.
 *
 * The regression this pins: gate and agent commits carry a leading type emoji
 * whenever `commitEmoji` is on, and `tightenTitle` reads that emoji as a missing
 * type - so a PR title built from such a subject came out as
 * `chore: <emoji> fix(...): ...` instead of staying plain text.
 *
 * Must run under Bun: bun test tests/gate/conventional.test.ts
 */
import { test, expect } from "bun:test";
import { isTitle, stripSubjectEmoji, tightenTitle } from "@/gate/conventional";

test("a leading type emoji is dropped, the rest of the subject is untouched", () => {
    expect(stripSubjectEmoji("🐛 fix(gate): tighten skip detection")).toBe("fix(gate): tighten skip detection");
    expect(stripSubjectEmoji("✅ test: cover the empty diff")).toBe("test: cover the empty diff");
    expect(stripSubjectEmoji("♻️ refactor(gate): share the commit helper")).toBe(
        "refactor(gate): share the commit helper"
    );
    expect(stripSubjectEmoji("🔧 enigma(push): apply agent fixes")).toBe("enigma(push): apply agent fixes");
});

test("a subject without an emoji survives unchanged", () => {
    expect(stripSubjectEmoji("feat(gate): add the run ledger")).toBe("feat(gate): add the run ledger");
    expect(stripSubjectEmoji("update the docs")).toBe("update the docs");
    expect(stripSubjectEmoji("")).toBe("");
});

test("stripping first keeps tightenTitle from prefixing a type onto the emoji", () => {
    const subject = "🐛 fix(gate): honor commit-emoji in pipeline commit subjects";
    expect(tightenTitle(subject)).toBe(`chore: ${subject}`);
    expect(tightenTitle(stripSubjectEmoji(subject))).toBe("fix(gate): honor commit-emoji in pipeline commit subjects");
    expect(isTitle(stripSubjectEmoji(subject))).toBe(true);
});

test("a subject that is only an emoji strips to empty so the caller can fall back", () => {
    expect(stripSubjectEmoji("🔧")).toBe("");
});
