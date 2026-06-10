/**
 * Safe auto-fixes: the mechanical, formatting-only subset of the rules that can be
 * applied without changing program meaning - trailing whitespace, leading/trailing
 * blank lines, the final newline, and collapsing runs of blank lines. The AST style
 * rules (quotes, semicolons, imports) are intentionally NOT auto-fixed: rewriting
 * them safely needs real codemods, and the audit rules (secrets, URL imports) have
 * no mechanical fix. Container formats are left untouched - their wrapper (JSON,
 * HTML) is owned by the tooling that produced them.
 */

import { extname } from "node:path";
import { parseSource } from "./parse";
import { guardedLines } from "./guarded";
import { JS_TS, isContainer, languageFor } from "./languages";

/**
 * Return `text` with the safe formatting fixes applied, or unchanged when the file
 * is a container format or an unknown extension. Idempotent: fixing fixed text is a
 * no-op, so the caller can compare the result to detect whether anything changed.
 */
export function fixText(file: string, text: string): string {
    if (!text || isContainer(file)) return text;
    const language = languageFor(file);
    if (!language) return text;

    // 1. Strip trailing whitespace from every line.
    let body = text.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");

    // 2. Collapse runs of 2+ blank lines into one, skipping blanks guarded by a
    //    string/comment literal (same safety boundary as no-consecutive-blank-lines).
    const sourceFile = JS_TS.includes(language) ? parseSource(file, body, extname(file).toLowerCase()) : undefined;
    const guarded = guardedLines(language, body, sourceFile);
    const lines = body.split("\n");
    const kept: string[] = [];
    let blankRun = 0;
    for (let i = 0; i < lines.length; i++) {
        const isBlank = lines[i]!.trim() === "" && !guarded.has(i + 1);
        if (isBlank && ++blankRun >= 2) continue;
        if (!isBlank) blankRun = 0;
        kept.push(lines[i]!);
    }
    body = kept.join("\n");

    // 3. Drop leading blank lines, and 4. end with exactly one trailing newline.
    body = body.replace(/^(?:[ \t]*\n)+/, "").replace(/[ \t\n]+$/, "");
    return body ? `${body}\n` : "";
}
