/** Shared types for the linter engine: violations, rule contexts, and rules. */

import type * as ts from "typescript";

export type Severity = "error" | "warning";
export type Category = "style" | "audit";

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
    sourceFile: ts.SourceFile;
}

/** A lint rule: a name, its category, and a pure check over one file. */
export interface Rule {
    name: string;
    category: Category;
    severity: Severity;
    check(ctx: RuleContext): Violation[];
}
