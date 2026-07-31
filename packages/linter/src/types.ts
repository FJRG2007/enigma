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
    /** True when `text` is a fragment extracted from a container file (notebook cell, SFC script,
     *  Astro frontmatter), not a whole file. Rules that check file boundaries must skip them. */
    embedded?: boolean;
    /** True when the file belongs to a project configured with Prettier. Rules whose fix stands
     *  down there (the punctuation ones) must stay silent rather than block on an unfixed finding. */
    prettier?: boolean;
}

/** A region of source extracted from a container file, with its lines mapped back to the file. */
export interface EmbeddedBlock {
    language: Language;
    /** The extracted source for this block. */
    text: string;
    /** `lineMap[i]` is the 1-based physical file line of this block's line `i + 1`. */
    lineMap: number[];
}

/** A lint rule: a name, its category, the languages it targets, and a pure check over one file. */
export interface Rule {
    name: string;
    category: Category;
    severity: Severity;
    languages: Language[];
    check(ctx: RuleContext): Violation[];
}
