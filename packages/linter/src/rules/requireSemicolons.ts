/**
 * Ciphera: statements that take a semicolon must end with one (no ASI), and every
 * member of an interface or type literal is terminated with one - including the last
 * member of a single-line literal (`{ url?: string; }`) and members a comma separates.
 */

import ts from "typescript";
import { JS_TS } from "../languages";
import { locate, isTypeMember } from "../parse";
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
        // Prettier owns type-member punctuation where it is the project's formatter, and
        // fixText stands down there, so reporting it would only block on an unfixed finding.
        // Statement semicolons are not in dispute: Prettier defaults to writing them.
        const typeMembers = !ctx.prettier;

        const visit = (node: ts.Node): void => {
            if (NEEDS_SEMICOLON.has(node.kind) || (typeMembers && isTypeMember(node))) {
                const text = node.getText(sourceFile).trimEnd();
                if (!text.endsWith(";")) {
                    const { line, column } = locate(sourceFile, node.getEnd());
                    violations.push({
                        rule: "require-semicolons", category: "style", severity: "warning",
                        file: ctx.file, line, column,
                        message: text.endsWith(",") ? "type members are separated by a semicolon, not a comma" : "missing semicolon",
                    });
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return violations;
    },
};
