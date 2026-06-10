/**
 * Guarded lines: the 1-based line numbers whose blank lines must be left untouched
 * because they sit inside a multi-line string or comment. Computed per language so the
 * no-consecutive-blank-lines rule never collapses blanks that belong to a literal.
 */

import ts from "typescript";
import type { Language } from "./types";
import { lineOf, computeLineStarts } from "./lines";

/** Guarded line numbers for a file, dispatched by language. */
export function guardedLines(language: Language, text: string, sourceFile?: ts.SourceFile): Set<number> {
    switch (language) {
        case "ts": case "js": return sourceFile ? tsGuardedLines(sourceFile, text) : new Set();
        case "python": return scanGuarded(text, PYTHON_MATCHERS);
        case "rust": return scanGuarded(text, RUST_MATCHERS);
        case "prisma": return new Set(); // Prisma has only line comments and single-line strings.
    }
}

// --- JavaScript / TypeScript: reuse the TypeScript parser and scanner. ---

/** Strings, templates (from the AST) and block comments (from the scanner) of a JS/TS file. */
function tsGuardedLines(sourceFile: ts.SourceFile, text: string): Set<number> {
    const guarded = new Set<number>();
    const mark = (start: number, end: number): void => {
        const from = sourceFile.getLineAndCharacterOfPosition(start).line;
        const to = sourceFile.getLineAndCharacterOfPosition(end).line;
        for (let line = from; line <= to; line++) guarded.add(line + 1);
    };

    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) mark(node.getStart(sourceFile), node.getEnd());
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (token === ts.SyntaxKind.MultiLineCommentTrivia) mark(scanner.getTokenPos(), scanner.getTextPos());
    }
    return guarded;
}

// --- Generic lexer for languages without a TypeScript AST. ---

/** Matches a token starting at `i`; returns the exclusive end offset, or null when it does not apply. */
type Matcher = (text: string, i: number) => number | null;

/**
 * Walk the source, letting each matcher consume whole string/comment tokens, and record every line
 * their spans cover. Only multi-line tokens contribute blank lines; single-line ones are consumed so
 * their inner quotes cannot trip the scanner.
 */
function scanGuarded(text: string, matchers: Matcher[]): Set<number> {
    const guarded = new Set<number>();
    const lineStarts = computeLineStarts(text);
    for (let i = 0; i < text.length;) {
        let end: number | null = null;
        for (const match of matchers) {
            end = match(text, i);
            if (end !== null && end > i) break;
            end = null;
        }
        if (end === null) { i++; continue; }
        const from = lineOf(i, lineStarts);
        const to = lineOf(end - 1, lineStarts);
        for (let line = from; line <= to; line++) guarded.add(line);
        i = end;
    }
    return guarded;
}

/** A `//`/`#`-style comment running to the end of its line. */
function lineComment(prefix: string): Matcher {
    return (text, i) => {
        if (!text.startsWith(prefix, i)) return null;
        const newline = text.indexOf("\n", i);
        return newline === -1 ? text.length : newline;
    };
}

/** A `/* ... *\/`-style block comment, optionally nesting (as in Rust). */
function blockComment(open: string, close: string, nested: boolean): Matcher {
    return (text, i) => {
        if (!text.startsWith(open, i)) return null;
        let depth = 1;
        let j = i + open.length;
        while (j < text.length) {
            if (nested && text.startsWith(open, j)) { depth++; j += open.length; continue; }
            if (text.startsWith(close, j)) { depth--; j += close.length; if (depth === 0) return j; continue; }
            j++;
        }
        return text.length; // unterminated: guard to end of file
    };
}

/** A quoted string. `escape` honors backslash escapes; `multiline` allows it to span newlines. */
function quotedString(quote: string, escape: boolean, multiline: boolean): Matcher {
    return (text, i) => {
        if (text[i] !== quote) return null;
        for (let j = i + 1; j < text.length; j++) {
            const char = text[j];
            if (escape && char === "\\") { j++; continue; }
            if (char === quote) return j + 1;
            if (!multiline && char === "\n") return j;
        }
        return text.length;
    };
}

const IDENTIFIER = /[A-Za-z0-9_]/;

/** True when the character before `i` is part of an identifier (so a prefix is not a token boundary). */
function joinedToIdentifier(text: string, i: number): boolean {
    const before = text[i - 1];
    return before !== undefined && IDENTIFIER.test(before);
}

/**
 * Python strings: optional `r`/`b`/`f`/`u` prefixes, then a triple-quoted (multi-line) or single-line
 * string. Single-line strings are still consumed so an embedded triple quote cannot be mis-detected.
 */
function pythonString(): Matcher {
    const PREFIX = "rbfuRBFU";
    return (text, i) => {
        let k = i;
        while (k < i + 2 && PREFIX.includes(text[k] ?? "")) k++;
        const quote = text[k];
        if (quote !== "\"" && quote !== "'") return null;
        if (k > i && joinedToIdentifier(text, i)) return null; // a variable name ending in r/b/f/u
        const raw = /[rR]/.test(text.slice(i, k));
        const triple = text.startsWith(quote.repeat(3), k);
        const delimiter = triple ? quote.repeat(3) : quote;
        for (let j = k + delimiter.length; j < text.length; j++) {
            if (!raw && text[j] === "\\") { j++; continue; }
            if (text.startsWith(delimiter, j)) return j + delimiter.length;
            if (!triple && text[j] === "\n") return j;
        }
        return text.length;
    };
}

/** Rust raw strings: optional `b`, then `r`, then N `#`, then `"..."` closed by `"` and N `#`. */
function rustRawString(): Matcher {
    return (text, i) => {
        if (joinedToIdentifier(text, i)) return null;
        let k = i;
        if (text[k] === "b") k++;
        if (text[k] !== "r") return null;
        k++;
        let hashes = 0;
        while (text[k] === "#") { hashes++; k++; }
        if (text[k] !== "\"") return null;
        const close = `"${"#".repeat(hashes)}`;
        const end = text.indexOf(close, k + 1);
        return end === -1 ? text.length : end + close.length;
    };
}

/** Rust char literals like `'a'` or `'\n'`. Returns null for lifetimes (`'a`) so they are not consumed. */
function rustChar(): Matcher {
    return (text, i) => {
        if (text[i] !== "'") return null;
        if (text[i + 1] === "\\") {
            for (let j = i + 2; j < text.length && text[j] !== "\n"; j++) if (text[j] === "'") return j + 1;
            return null;
        }
        return text[i + 2] === "'" ? i + 3 : null;
    };
}

const PYTHON_MATCHERS: Matcher[] = [
    lineComment("#"),
    pythonString(),
];

const RUST_MATCHERS: Matcher[] = [
    lineComment("//"),
    blockComment("/*", "*/", true),
    rustRawString(),
    rustChar(),
    quotedString("\"", true, true),
];
