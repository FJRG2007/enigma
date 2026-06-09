/** Ciphera: prefer double quotes; template literals only for interpolation. */

import ts from "typescript";
import { locate } from "../parse";
import { JS_TS } from "../languages";
import type { Rule, Violation } from "../types";

export const preferDoubleQuotes: Rule = {
    name: "prefer-double-quotes",
    category: "style",
    severity: "warning",
    languages: JS_TS,
    check(ctx) {
        const violations: Violation[] = [];
        const sourceFile = ctx.sourceFile!;

        const add = (pos: number, message: string): void => {
            const { line, column } = locate(sourceFile, pos);
            violations.push({ rule: "prefer-double-quotes", category: "style", severity: "warning", file: ctx.file, line, column, message });
        };

        const visit = (node: ts.Node): void => {
            if (ts.isStringLiteral(node)) {
                // A single-quoted string is only justified when its content contains a double quote.
                if (node.getText(sourceFile).startsWith("'") && !node.text.includes("\"")) {
                    add(node.getStart(sourceFile), "use double quotes for strings");
                }
            } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
                // A backtick string with no interpolation and no newline should be a double-quoted string.
                if (!node.text.includes("\n") && !node.text.includes("`")) {
                    add(node.getStart(sourceFile), "use double quotes instead of a template literal with no interpolation");
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return violations;
    },
};
