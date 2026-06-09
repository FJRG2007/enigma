/** Ciphera: statements that take a semicolon must end with one (no ASI). */

import ts from "typescript";
import { locate } from "../parse";
import { JS_TS } from "../languages";
import type { Rule, Violation } from "../types";

// Declarations whose body already terminates them (function/class) are intentionally absent: a
// trailing semicolon there is an empty statement, not required. Function expressions and arrow
// functions assigned to a const/let/var are VariableStatements and are covered.
const NEEDS_SEMICOLON = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ExpressionStatement,      // statements, including "use strict" directives
    ts.SyntaxKind.VariableStatement,        // const / let / var, incl. exported ones
    ts.SyntaxKind.ReturnStatement,
    ts.SyntaxKind.ThrowStatement,
    ts.SyntaxKind.BreakStatement,
    ts.SyntaxKind.ContinueStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.DebuggerStatement,
    ts.SyntaxKind.ImportDeclaration,        // import ... from "..."
    ts.SyntaxKind.ImportEqualsDeclaration,  // import x = require("...")
    ts.SyntaxKind.ExportDeclaration,        // export { ... } / export * from "..."
    ts.SyntaxKind.ExportAssignment,         // export default ... / export = ...
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.PropertyDeclaration,      // class fields
]);

export const requireSemicolons: Rule = {
    name: "require-semicolons",
    category: "style",
    severity: "warning",
    languages: JS_TS,
    check(ctx) {
        const violations: Violation[] = [];
        const sourceFile = ctx.sourceFile!;

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
