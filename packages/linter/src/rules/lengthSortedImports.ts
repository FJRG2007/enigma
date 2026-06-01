/** Ciphera: imports must be ordered by line length, shortest first. */

import ts from "typescript";
import { locate } from "../parse";
import type { Rule, Violation } from "../types";

export const lengthSortedImports: Rule = {
    name: "length-sorted-imports",
    category: "style",
    severity: "warning",
    check(ctx) {
        const violations: Violation[] = [];
        const { sourceFile } = ctx;
        let group: ts.ImportDeclaration[] = [];

        const flush = (): void => {
            for (let i = 1; i < group.length; i++) {
                const prev = group[i - 1]!.getText(sourceFile).length;
                const curr = group[i]!.getText(sourceFile).length;
                if (curr < prev) {
                    const { line, column } = locate(sourceFile, group[i]!.getStart(sourceFile));
                    violations.push({
                        rule: "length-sorted-imports", category: "style", severity: "warning",
                        file: ctx.file, line, column,
                        message: "imports should be sorted by line length, shortest first",
                    });
                }
            }
            group = [];
        };

        // Check each contiguous block of imports independently.
        for (const stmt of sourceFile.statements) {
            if (ts.isImportDeclaration(stmt)) group.push(stmt);
            else flush();
        }
        flush();
        return violations;
    },
};
