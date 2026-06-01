/** File hygiene: no trailing whitespace, exactly one final newline, no leading blank line. */

import type { Rule, Violation } from "../types";

export const fileHygiene: Rule = {
    name: "file-hygiene",
    category: "style",
    severity: "warning",
    check(ctx) {
        const violations: Violation[] = [];
        const add = (line: number, message: string): void => {
            violations.push({ rule: "file-hygiene", category: "style", severity: "warning", file: ctx.file, line, column: 1, message });
        };

        ctx.lines.forEach((text, i) => {
            if (/[ \t]+$/.test(text)) add(i + 1, "trailing whitespace");
        });

        if (ctx.text.length) {
            if (/^\s*\n/.test(ctx.text)) add(1, "remove the leading blank line");
            if (!ctx.text.endsWith("\n")) add(ctx.lines.length, "file must end with a newline");
            else if (/\n[ \t]*\n$/.test(ctx.text)) add(ctx.lines.length, "remove blank line(s) at end of file");
        }
        return violations;
    },
};
