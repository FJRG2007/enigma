/**
 * Safe auto-fixes: the mechanical, formatting-only subset of the rules that can be
 * applied without changing program meaning - trailing whitespace, leading/trailing
 * blank lines, the final newline, collapsing runs of blank lines, reordering
 * contiguous import groups by length (length-sorted-imports, a side-effect-free
 * codemod), and type-member/import-list punctuation. The remaining AST style rules
 * (quotes, statement semicolons) and the audit rules (secrets, URL imports) have no
 * mechanical fix. Container formats are left untouched - their wrapper (JSON, HTML)
 * is owned by the tooling that produced them.
 */

import ts from "typescript";
import { extname } from "node:path";
import { guardedLines } from "./guarded";
import { isTypeMember, parseSource } from "./parse";
import { JS_TS, isContainer, languageFor } from "./languages";

/** A replacement of `[start, end)` in the source with `text` (an insertion when start === end). */
interface Edit {
    start: number;
    end: number;
    text: string;
}

/** Apply non-overlapping edits, last one first so the earlier offsets stay valid. */
function applyEdits(body: string, edits: Edit[]): string {
    let out = body;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return out;
}

/**
 * Reorder each contiguous block of import declarations by full declaration length,
 * shortest first (length-sorted-imports). Only a block whose span is exactly its
 * imports separated by single newlines is touched - any interleaved comment or
 * blank line makes it ambiguous, so it is left for manual review. Reordering
 * side-effect-free named/type imports never changes program meaning.
 */
function sortImportGroups(file: string, body: string): string {
    const sourceFile = parseSource(file, body, extname(file).toLowerCase());
    if (!sourceFile) return body;
    const groups: ts.ImportDeclaration[][] = [];
    let group: ts.ImportDeclaration[] = [];
    for (const stmt of sourceFile.statements) {
        if (ts.isImportDeclaration(stmt)) {
            group.push(stmt);
        } else if (group.length) {
            groups.push(group);
            group = [];
        }
    }
    if (group.length) groups.push(group);

    const edits: Edit[] = [];
    for (const g of groups) {
        if (g.length < 2) continue;
        const start = g[0]!.getStart(sourceFile);
        const end = g[g.length - 1]!.getEnd();
        const span = body.slice(start, end);
        const texts = g.map((d) => d.getText(sourceFile));
        if (span !== texts.join("\n")) continue; // comments/blank lines: leave alone
        const sorted = [...texts].sort((a, b) => a.length - b.length).join("\n");
        if (sorted !== span) edits.push({ start, end, text: sorted });
    }
    return applyEdits(body, edits);
}

/**
 * Terminate every interface/type-literal member with a semicolon (including the last
 * member of a single-line literal, and members a comma separates) and drop the
 * trailing comma from a named import/export list. Punctuation only: TypeScript treats
 * `;`, `,` and nothing as the same type-member separator and ignores a trailing comma
 * in a specifier list, so neither edit can change what the program does.
 */
function fixPunctuation(file: string, body: string): string {
    const sourceFile = parseSource(file, body, extname(file).toLowerCase());
    const edits: Edit[] = [];

    const visit = (node: ts.Node): void => {
        if (isTypeMember(node)) {
            const end = node.getEnd();
            if (body[end - 1] === ",") edits.push({ start: end - 1, end, text: ";" });
            else if (body[end - 1] !== ";") edits.push({ start: end, end, text: ";" });
        } else if ((ts.isNamedImports(node) || ts.isNamedExports(node)) && node.elements.length && node.elements.hasTrailingComma) {
            const comma = body.indexOf(",", node.elements[node.elements.length - 1]!.getEnd());
            if (comma !== -1 && comma < node.getEnd()) edits.push({ start: comma, end: comma + 1, text: "" });
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return applyEdits(body, edits);
}

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

    // 2b. Reorder contiguous import groups by length (length-sorted-imports), then
    //     normalize type-member and import-list punctuation.
    if (JS_TS.includes(language)) body = fixPunctuation(file, sortImportGroups(file, body));

    // 3. Drop leading blank lines, and 4. end with exactly one trailing newline.
    body = body.replace(/^(?:[ \t]*\n)+/, "").replace(/[ \t\n]+$/, "");
    return body ? `${body}\n` : "";
}
