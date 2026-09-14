/** TypeScript AST parsing helpers shared by the AST-based rules. */

import ts from "typescript";

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
    ".ts": ts.ScriptKind.TS,
    ".tsx": ts.ScriptKind.TSX,
    ".mts": ts.ScriptKind.TS,
    ".cts": ts.ScriptKind.TS,
    ".js": ts.ScriptKind.JS,
    ".jsx": ts.ScriptKind.JSX,
    ".mjs": ts.ScriptKind.JS,
    ".cjs": ts.ScriptKind.JS,
};

/** Parse source text into a TypeScript AST. Tolerant of syntax errors. */
export function parseSource(file: string, text: string, ext: string): ts.SourceFile {
    const kind = SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS;
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * True for a member of an interface or type literal - the nodes Ciphera terminates
 * with a semicolon. The parent check is load-bearing: `ts.isTypeElement` also accepts
 * a class or object-literal accessor, whose body already terminates it.
 */
export function isTypeMember(node: ts.Node): node is ts.TypeElement {
    return ts.isTypeElement(node) && !!node.parent && (ts.isInterfaceDeclaration(node.parent) || ts.isTypeLiteralNode(node.parent));
}

/**
 * Contiguous runs of SINGLE-LINE import declarations, in source order.
 *
 * A multi-line import has no line length to sort by. Measuring its whole declaration text
 * makes it longer than every neighbour, which flagged each import that followed it as out of
 * order with no ordering that could satisfy the rule, and made the autofix push it to the end
 * of the block. So a multi-line declaration ends the current run and never joins one: the
 * ladder is enforced within each run of single-line imports, and multi-line blocks stay put.
 *
 * Shared by the rule and the fixer so the two can never disagree about what a group is.
 */
export function singleLineImportRuns(sourceFile: ts.SourceFile): ts.ImportDeclaration[][] {
    const runs: ts.ImportDeclaration[][] = [];
    let run: ts.ImportDeclaration[] = [];
    const flush = (): void => { if (run.length) runs.push(run); run = []; };
    for (const stmt of sourceFile.statements) {
        if (ts.isImportDeclaration(stmt) && !stmt.getText(sourceFile).includes("\n")) run.push(stmt);
        else flush();
    }
    flush();
    return runs;
}

/** Convert a source position to a 1-based line/column. */
export function locate(sourceFile: ts.SourceFile, pos: number): { line: number; column: number; } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, column: character + 1 };
}
