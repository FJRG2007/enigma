/**
 * The post-edit lint step reports only what the edit introduced. Before this, every edit to a
 * legacy file came back as a blocking error listing warnings on lines the edit never touched.
 */
import { test, expect } from "bun:test";
import { textBeforeEdit, introducedViolations } from "../src/post-edit-hook";

const warn = (line: number, rule = "no-useless-concat") => ({ line, column: 1, severity: "warning", rule, message: "m" });

test("rebuilds the file before an Edit, a replace_all Edit and a MultiEdit", () => {
    expect(textBeforeEdit("a\nNEW\nc\n", { old_string: "b", new_string: "NEW" })).toBe("a\nb\nc\n");
    expect(textBeforeEdit("X X\n", { old_string: "y", new_string: "X", replace_all: true })).toBe("y y\n");
    const edits = [{ old_string: "a", new_string: "A1" }, { old_string: "A1b", new_string: "B" }];
    expect(textBeforeEdit("B\n", { edits })).toBe("ab\n");
    // `$&` in the old text is literal, not a replacement pattern.
    expect(textBeforeEdit("z\n", { old_string: "$&", new_string: "z" })).toBe("$&\n");
});

test("cannot rebuild a Write, a deletion or text the fixer changed, so reports everything", () => {
    expect(textBeforeEdit("a\n", { content: "a\n" } as never)).toBeNull();
    expect(textBeforeEdit("a\n", { old_string: "b", new_string: "" })).toBeNull();
    expect(textBeforeEdit("a\n", { old_string: "b", new_string: "gone" })).toBeNull();
    expect(introducedViolations([warn(1)], "x\n", null, null)).toHaveLength(1);
});

test("drops findings the file already had, even when the edit shifted their line", () => {
    const before = "const a = b + \"c\";\n";
    const after = "// new\n// lines\nconst a = b + \"c\";\nconst d = e + \"f\";\n";
    const kept = introducedViolations([warn(3), warn(4)], after, [warn(1)], before);
    expect(kept.map((v) => v.line)).toEqual([4]);
});

test("a second copy of an old finding still reports", () => {
    const before = "x + \"a\";\n";
    const after = "x + \"a\";\nx + \"a\";\n";
    expect(introducedViolations([warn(1), warn(2)], after, [warn(1)], before)).toHaveLength(1);
});

test("the same line under a different rule is a new finding", () => {
    const text = "const q = `a`;\n";
    expect(introducedViolations([warn(1, "prefer-double-quotes")], text, [warn(1)], text)).toHaveLength(1);
});
