/** Ciphera: a named import or export list does not end with a trailing comma. */

import ts from "typescript";
import { locate } from "../parse";
import { JS_TS } from "../languages";
import type { Rule, Violation } from "../types";

export const noImportTrailingComma: Rule = {
    name: "no-import-trailing-comma",
    category: "style",
    severity: "warning",
    languages: JS_TS,
    check(ctx) {
        // Prettier defaults to `trailingComma: "all"` and fixText stands down in its projects,
        // so reporting there would leave a finding nothing is allowed to fix.
        if (ctx.prettier) return [];
        const violations: Violation[] = [];
        const sourceFile = ctx.sourceFile!;

        const visit = (node: ts.Node): void => {
            if ((ts.isNamedImports(node) || ts.isNamedExports(node)) && node.elements.length && node.elements.hasTrailingComma) {
                const { line, column } = locate(sourceFile, node.elements[node.elements.length - 1]!.getEnd());
                violations.push({
                    rule: "no-import-trailing-comma", category: "style", severity: "warning",
                    file: ctx.file, line, column, message: "trailing comma in a named import/export list",
                });
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return violations;
    },
};
