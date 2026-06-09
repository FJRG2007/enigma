/** Shared types for the linter engine: violations, rule contexts, and rules. */

import type * as ts from "typescript";

export type Severity = "error" | "warning";
export type Category = "style" | "audit";
export type Language = "ts" | "js" | "python" | "rust" | "prisma";

/** A single rule violation at a specific location. */
export interface Violation {
    rule: string;
    category: Category;
    severity: Severity;
    file: string;
    line: number;
    column: number;
    message: string;
}

/** Everything a rule needs to inspect one source file. */
export interface RuleContext {
    file: string;
    text: string;
    lines: string[];
    language: Language;
    /** The parsed TypeScript AST. Only present for JavaScript/TypeScript files. */
    sourceFile?: ts.SourceFile;
}

/** A lint rule: a name, its category, the languages it targets, and a pure check over one file. */
export interface Rule {
    name: string;
    category: Category;
    severity: Severity;
    languages: Language[];
    check(ctx: RuleContext): Violation[];
}
