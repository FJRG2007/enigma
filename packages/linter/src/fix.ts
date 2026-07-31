/**
 * Safe auto-fixes: the mechanical, formatting-only subset of the rules that can be
 * applied without changing program meaning - trailing whitespace, leading/trailing
 * blank lines, the final newline, collapsing runs of blank lines, reordering
 * contiguous import groups by length (length-sorted-imports, a side-effect-free
 * codemod), and type-member/import-list punctuation. The remaining AST style rules
 * (quotes, statement semicolons) and the audit rules (secrets, URL imports) have no
 * mechanical fix. Container formats are left untouched - their wrapper (JSON, HTML)
 * is owned by the tooling that produced them, and the punctuation pass stands down in
 * a project that already has Prettier as its formatter.
 */

import ts from "typescript";
import { guardedLines } from "./guarded";
import { isTypeMember, parseSource } from "./parse";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
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

/** Config filenames that mark a directory as the root of a Prettier-formatted project. */
const PRETTIER_CONFIGS = new Set([
    ".prettierrc",
    ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml",
    ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts", ".prettierrc.mts", ".prettierrc.cts",
    "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts",
    "prettier.config.mts", "prettier.config.cts",
]);

/** Memoized `usesPrettier` verdict per directory, so a `fixFiles` sweep walks each chain once. */
const prettierDirs = new Map<string, boolean>();

/** What one directory contributes to the upward walk. */
interface DirVerdict {
    /** A Prettier config file, or a `package.json` carrying a `prettier` key, lives here. */
    prettier: boolean;
    /** A `.git` entry lives here, so this directory is the project root and ends the walk. */
    root: boolean;
}

/** Read one directory once and answer both questions the walk asks of it. */
function inspectDir(dir: string): DirVerdict {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return { prettier: false, root: false }; }
    const root = entries.includes(".git");
    if (entries.some((entry) => PRETTIER_CONFIGS.has(entry))) return { prettier: true, root };
    if (!entries.includes("package.json")) return { prettier: false, root };
    try {
        const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        return { prettier: !!pkg && typeof pkg === "object" && "prettier" in pkg, root };
    } catch { return { prettier: false, root }; }
}

/**
 * True when `file` belongs to a project configured with Prettier, found by walking up
 * from its directory. The path is resolved against the working directory first, so the
 * `--fix` sweep (which discovers relative paths) and the auto-lint hook (which passes
 * absolute ones) reach the same verdict; an in-memory name answers for the working
 * directory's project. The walk stops at the first directory holding `.git`, so a stray
 * config in a home directory never disables the fix for an unrelated project. An
 * unreadable directory contributes nothing and never throws.
 */
export function usesPrettier(file: string): boolean {
    const chain: string[] = [];
    let dir = dirname(resolve(file));
    let verdict = false;
    for (;;) {
        const cached = prettierDirs.get(dir);
        if (cached !== undefined) { verdict = cached; break; }
        chain.push(dir);
        const { prettier, root } = inspectDir(dir);
        if (prettier) { verdict = true; break; }
        const parent = dirname(dir);
        if (root || parent === dir) break;
        dir = parent;
    }
    for (const seen of chain) prettierDirs.set(seen, verdict);
    return verdict;
}

/**
 * Terminate every interface/type-literal member with a semicolon (including the last
 * member of a single-line literal, and members a comma separates) and drop the
 * trailing comma from a named import/export list. Punctuation only: TypeScript treats
 * `;`, `,` and nothing as the same type-member separator and ignores a trailing comma
 * in a specifier list, so neither edit can change what the program does.
 *
 * Skipped entirely for a file in a Prettier-formatted project (see `usesPrettier`):
 * Prettier strips a single-line type literal's terminator and re-adds the trailing
 * comma, so applying this here would only make the two formatters flip the same lines
 * on every save. The two matching rules (`require-semicolons` over type members and
 * `no-import-trailing-comma`) go silent there too, so nothing blocks on a finding the
 * fixer has deliberately refused to fix.
 */
function fixPunctuation(file: string, body: string): string {
    if (usesPrettier(file)) return body;
    const sourceFile = parseSource(file, body, extname(file).toLowerCase());
    const edits: Edit[] = [];

    const visit = (node: ts.Node): void => {
        if (isTypeMember(node)) {
            const end = node.getEnd();
            if (body[end - 1] === ",") edits.push({ start: end - 1, end, text: ";" });
            else if (body[end - 1] !== ";") edits.push({ start: end, end, text: ";" });
        } else if ((ts.isNamedImports(node) || ts.isNamedExports(node)) && node.elements.length && node.elements.hasTrailingComma) {
            // The element list ends immediately after its trailing comma, before the
            // close brace's leading trivia - a text scan would hit a comma inside a
            // comment between the last specifier and the real one.
            const comma = node.elements.end - 1;
            if (body[comma] === ",") edits.push({ start: comma, end: comma + 1, text: "" });
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
 * In a Prettier-formatted project the punctuation pass stands down (see
 * `fixPunctuation`), together with the two rules that report it; every other fix
 * still applies and every other rule still reports.
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

    // 2b. Normalize type-member and import-list punctuation (skipped in a Prettier
    //     project), then reorder contiguous import groups by length. Punctuation runs
    //     first so the length sort sees each declaration at its final length.
    if (JS_TS.includes(language)) body = sortImportGroups(file, fixPunctuation(file, body));

    // 3. Drop leading blank lines, and 4. end with exactly one trailing newline.
    body = body.replace(/^(?:[ \t]*\n)+/, "").replace(/[ \t\n]+$/, "");
    return body ? `${body}\n` : "";
}
