/** Ciphera: statements that take a semicolon must end with one (no ASI). */

import ts from "typescript";
import { locate } from "../parse";
import type { Rule, Violation } from "../types";

const NEEDS_SEMICOLON = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ExpressionStatement,
    ts.SyntaxKind.VariableStatement,
    ts.SyntaxKind.ReturnStatement,
    ts.SyntaxKind.ThrowStatement,
    ts.SyntaxKind.BreakStatement,
    ts.SyntaxKind.ContinueStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.DebuggerStatement,
    ts.SyntaxKind.ImportDeclaration,
    ts.SyntaxKind.ExportDeclaration,
    ts.SyntaxKind.ExportAssignment,
    ts.SyntaxKind.TypeAliasDeclaration,
]);

export const requireSemicolons: Rule = {
    name: "require-semicolons",
    category: "style",
    severity: "warning",
    check(ctx) {
        const violations: Violation[] = [];
        const { sourceFile } = ctx;

        const visit = (node: ts.Node): void => {
            if (NEEDS_SEMICOLON.has(node.kind) && !node.getText(sourceFile).trimEnd().endsWith(";")) {
                const { line, column } = locate(sourceFile, node.getEnd());
                violations.push({
                    rule: "require-semicolons", category: "style", severity: "warning",
                    file: ctx.file, line, column, message: "missing semicolon",
                });
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return violations;
    },
};
