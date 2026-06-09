/** Ciphera: collapse runs of 2+ blank lines into one, ignoring strings and block comments. */

import { guardedLines } from "../guarded";
import { ALL_LANGUAGES } from "../languages";
import type { Rule, Violation } from "../types";

const BLANK = /^\s*$/;

export const noConsecutiveBlankLines: Rule = {
    name: "no-consecutive-blank-lines",
    category: "style",
    severity: "warning",
    languages: ALL_LANGUAGES,
    check(ctx) {
        const violations: Violation[] = [];
        const guarded = guardedLines(ctx.language, ctx.text, ctx.sourceFile);
        const { lines } = ctx;

        // 1-based line where the current blank run started, or -1 when not in a run.
        let runStart = -1;
        const flush = (endLine: number): void => {
            // endLine is the content line that closed the run, so it ran for `endLine - runStart` blanks.
            if (runStart !== -1 && endLine - runStart >= 2) {
                violations.push({
                    rule: "no-consecutive-blank-lines", category: "style", severity: "warning",
                    file: ctx.file, line: runStart + 1, column: 1,
                    message: "collapse consecutive blank lines into a single one",
                });
            }
            runStart = -1;
        };

        for (let i = 0; i < lines.length; i++) {
            const lineNo = i + 1;
            const isBlank = BLANK.test(lines[i]) && !guarded.has(lineNo);
            if (isBlank) {
                if (runStart === -1) runStart = lineNo;
            } else flush(lineNo);
        }
        // A run reaching end of file is trailing whitespace; file-hygiene owns it, so it is left unflushed.
        return violations;
    },
};
