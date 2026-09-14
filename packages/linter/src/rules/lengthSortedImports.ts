/** Ciphera: imports must be ordered by line length, shortest first. */

import { JS_TS } from "../languages";
import type { Rule, Violation } from "../types";
import { locate, singleLineImportRuns } from "../parse";

export const lengthSortedImports: Rule = {
    name: "length-sorted-imports",
    category: "style",
    severity: "warning",
    languages: JS_TS,
    check(ctx) {
        const violations: Violation[] = [];
        const sourceFile = ctx.sourceFile!;

        // Each contiguous run of single-line imports is ordered independently; a multi-line
        // import ends a run rather than joining it (see singleLineImportRuns).
        for (const run of singleLineImportRuns(sourceFile)) {
            for (let i = 1; i < run.length; i++) {
                const prev = run[i - 1]!.getText(sourceFile).length;
                const curr = run[i]!.getText(sourceFile).length;
                if (curr >= prev) continue;
                const { line, column } = locate(sourceFile, run[i]!.getStart(sourceFile));
                violations.push({
                    rule: "length-sorted-imports", category: "style", severity: "warning",
                    file: ctx.file, line, column,
                    message: "imports should be sorted by line length, shortest first",
                });
            }
        }
        return violations;
    },
};
