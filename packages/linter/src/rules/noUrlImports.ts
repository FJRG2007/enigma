/** Ciphera: import from a package name, never a remote URL / CDN. */

import ts from "typescript";
import { locate } from "../parse";
import { JS_TS } from "../languages";
import type { Rule, Violation } from "../types";

const URL_SPECIFIER = /^(https?:)?\/\//i;

export const noUrlImports: Rule = {
    name: "no-url-imports",
    category: "style",
    severity: "error",
    languages: JS_TS,
    check(ctx) {
        const violations: Violation[] = [];
        const sourceFile = ctx.sourceFile!;

        const visit = (node: ts.Node): void => {
            const specifier = moduleSpecifier(node);
            if (specifier && URL_SPECIFIER.test(specifier.text)) {
                const { line, column } = locate(sourceFile, specifier.getStart(sourceFile));
                violations.push({
                    rule: "no-url-imports", category: "style", severity: "error",
                    file: ctx.file, line, column,
                    message: "do not import from a URL/CDN; depend on a package name",
                });
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return violations;
    },
};

/** The module specifier string of an import/export-from declaration, if any. */
function moduleSpecifier(node: ts.Node): ts.StringLiteral | undefined {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier;
    return undefined;
}
