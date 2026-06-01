/** Ciphera: avoid string concatenation with `+`; use template literals. */

import ts from "typescript";
import { locate } from "../parse";
import type { Rule, Violation } from "../types";

export const noUselessConcat: Rule = {
    name: "no-useless-concat",
    category: "style",
    severity: "warning",
    check(ctx) {
        const violations: Violation[] = [];
        const { sourceFile } = ctx;

        function isStringConcat(node: ts.Node): node is ts.BinaryExpression {
            return ts.isBinaryExpression(node)
                && node.operatorToken.kind === ts.SyntaxKind.PlusToken
                && (isStringish(node.left) || isStringish(node.right));
        }

        function isStringish(node: ts.Node): boolean {
            return ts.isStringLiteral(node)
                || ts.isNoSubstitutionTemplateLiteral(node)
                || ts.isTemplateExpression(node)
                || isStringConcat(node);
        }

        const visit = (node: ts.Node): void => {
            // Report only the outermost concatenation so `a + b + c` flags once.
            if (isStringConcat(node) && !isStringConcat(node.parent)) {
                const { line, column } = locate(sourceFile, node.getStart(sourceFile));
                violations.push({
                    rule: "no-useless-concat", category: "style", severity: "warning",
                    file: ctx.file, line, column,
                    message: "avoid string concatenation; use a template literal",
                });
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return violations;
    },
};
