/**
 * Extraction for the files around the code: documentation, database schemas and configuration.
 *
 * WHY THEY ARE IN THE GRAPH. An agent asked "where is the users table defined" or "what does the
 * deploy workflow run" used to get nothing from the graph and fell back to grepping, and one asked
 * about a subsystem never saw the note that explains it. Graphify (Graphify-Labs/graphify) indexes
 * docs, SQL and config beside the code for the same reason; this is the native, regex-level subset
 * of that idea, held to the same rule as the code reader: a pure text -> facts transform.
 *
 * What each language contributes, and why it stops there:
 *  - markdown/mdx: one `section` per heading down to level 3, spanning to the next heading of its level or above,
 *    and its relative links as imports - a doc that links a file depends on it. Nothing else is
 *    read as a reference: prose words matching names is coincidence, not wiring.
 *  - sql: `table` for CREATE TABLE/VIEW, `function` for CREATE FUNCTION/PROCEDURE, `type` for
 *    CREATE TYPE, each spanning to the statement's `;` (dollar-quoted bodies skipped). A foreign
 *    key names its table, so references between tables come from the normal identifier pass.
 *  - prisma: `table` per model/view, `enum`, `type`, brace-scoped; a field typed as another model
 *    is a reference by the same pass.
 *  - yaml: top-level keys, plus the entries of the containers that ARE the file's content
 *    (`services`, `jobs`, `steps` is too fine) - a compose service or a CI job is what one asks for.
 *  - toml: one `key` per `[section]`, spanning to the next section.
 */

import type { CodeSymbol } from "./codegraph-extract";

/** Non-code extension -> language key. */
export const DOC_LANG_BY_EXT: Record<string, string> = {
    ".md": "markdown", ".mdx": "markdown",
    ".sql": "sql", ".prisma": "prisma",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
};

/** Language keys extracted by this module. */
export const DOC_LANGS: ReadonlySet<string> = new Set(Object.values(DOC_LANG_BY_EXT));

/**
 * Doc languages whose bodies name other definitions of the same language - a foreign key, a model
 * field typed as another model. The identifier pass runs only for these and for code; for prose and
 * config it would turn every repeated word into an edge.
 */
export const DOC_REFERENCE_LANGS: ReadonlySet<string> = new Set(["sql", "prisma"]);

/** YAML containers whose entries are what the file defines: compose services, CI jobs. */
const YAML_CONTAINERS = new Set(["services", "jobs", "workflows", "volumes", "networks"]);

const MAX_SIGNATURE = 200;

/**
 * Deepest heading that becomes a section. Levels 4-6 are paragraph-sized and doubled the node count
 * of a docs-heavy repo (30k sections over 2.5k files) without answering a question the level-3
 * section around them does not. A deeper heading still belongs to its section's span.
 */
const MAX_HEADING_LEVEL = 3;

function cap(text: string): string {
    const t = text.trim();
    return t.length > MAX_SIGNATURE ? `${t.slice(0, MAX_SIGNATURE)}...` : t;
}

function indentOf(line: string): number {
    let n = 0;
    while (n < line.length && (line[n] === " " || line[n] === "\t")) n++;
    return n;
}

/** Lines inside fenced code blocks, which hold examples rather than headings or links. */
function fencedLines(lines: string[]): Uint8Array {
    const inside = new Uint8Array(lines.length);
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
        if (fence) { inside[i] = 1; if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; continue; }
        if (m) { fence = m[1]; inside[i] = 1; }
    }
    return inside;
}

function markdownSymbols(lines: string[]): CodeSymbol[] {
    const fenced = fencedLines(lines);
    const heads: { level: number; name: string; line: number; }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (fenced[i]) continue;
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
        if (m && m[1].length <= MAX_HEADING_LEVEL) heads.push({ level: m[1].length, name: m[2].replace(/[`*_]/g, "").trim(), line: i + 1 });
    }
    return heads.filter((h) => h.name).map((h, idx) => {
        const next = heads.slice(idx + 1).find((o) => o.level <= h.level);
        return { name: h.name, kind: "section" as const, line: h.line, endLine: next ? next.line - 1 : lines.length, signature: cap(lines[h.line - 1]) };
    });
}

/** Last line of the SQL statement starting at `start`: the first `;` outside a `$$` body. */
function sqlEnd(lines: string[], start: number): number {
    let dollar = false;
    for (let i = start; i < lines.length; i++) {
        const parts = lines[i].replace(/--.*$/, "").split("$$");
        for (let p = 0; p < parts.length; p++) {
            if (p > 0) dollar = !dollar;
            if (!dollar && parts[p].includes(";")) return i + 1;
        }
    }
    return lines.length;
}

const SQL_NAME = String.raw`(?:[\w"\x60\[\]]+\.)?["\x60\[]?([A-Za-z_][\w$]*)["\x60\]]?`;

function sqlSymbols(lines: string[]): CodeSymbol[] {
    const rules: [CodeSymbol["kind"], RegExp][] = [
        ["table", new RegExp(String.raw`^\s*create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?${SQL_NAME}`, "i")],
        ["function", new RegExp(String.raw`^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${SQL_NAME}`, "i")],
        ["type", new RegExp(String.raw`^\s*create\s+type\s+${SQL_NAME}`, "i")],
    ];
    const out: CodeSymbol[] = [];
    for (let i = 0; i < lines.length; i++) {
        for (const [kind, re] of rules) {
            const m = re.exec(lines[i]);
            if (!m) continue;
            out.push({ name: m[1], kind, line: i + 1, endLine: sqlEnd(lines, i), signature: cap(lines[i].replace(/\(.*$/, "")) });
            break;
        }
    }
    return out;
}

function prismaSymbols(lines: string[]): CodeSymbol[] {
    const out: CodeSymbol[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(model|view|enum|type)\s+([A-Za-z_]\w*)\s*\{/.exec(lines[i]);
        if (!m) continue;
        let end = i;
        while (end < lines.length - 1 && !/^\s*\}/.test(lines[end])) end++;
        const kind = m[1] === "enum" ? "enum" : m[1] === "type" ? "type" : "table";
        out.push({ name: m[2], kind, line: i + 1, endLine: end + 1, signature: cap(`${m[1]} ${m[2]}`) });
    }
    return out;
}

/** Last line of the YAML block whose key sits on `start`: before the next line at its indent or less. */
function yamlEnd(lines: string[], start: number): number {
    const base = indentOf(lines[start]);
    let end = start + 1;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        if (indentOf(line) <= base && !line.trimStart().startsWith("- ")) break;
        end = i + 1;
    }
    return end;
}

function yamlSymbols(lines: string[]): CodeSymbol[] {
    const out: CodeSymbol[] = [];
    const KEY = /^(\s*)([A-Za-z0-9_][\w.-]*)\s*:(?:\s|$)/;
    for (let i = 0; i < lines.length; i++) {
        const m = KEY.exec(lines[i]);
        if (!m || m[1].length) continue;
        const end = yamlEnd(lines, i);
        out.push({ name: m[2], kind: "key", line: i + 1, endLine: end, signature: cap(lines[i]) });
        if (!YAML_CONTAINERS.has(m[2])) continue;
        // The container's entries: the keys at the first indentation level under it.
        let childIndent = -1;
        for (let j = i + 1; j < end; j++) {
            const c = KEY.exec(lines[j]);
            if (!c || !c[1].length) continue;
            if (childIndent === -1) childIndent = c[1].length;
            if (c[1].length !== childIndent) continue;
            out.push({ name: c[2], kind: "key", line: j + 1, endLine: yamlEnd(lines, j), signature: cap(`${m[2]}.${c[2]}`) });
        }
    }
    return out;
}

function tomlSymbols(lines: string[]): CodeSymbol[] {
    const heads: { name: string; line: number; }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(lines[i]);
        if (m) heads.push({ name: m[1], line: i + 1 });
    }
    return heads.map((h, idx) => ({
        name: h.name, kind: "key" as const, line: h.line,
        endLine: idx + 1 < heads.length ? heads[idx + 1].line - 1 : lines.length,
        signature: cap(lines[h.line - 1]),
    }));
}

/**
 * Relative links of a markdown file, as import specifiers. Absolute URLs, mail links and pure
 * anchors name nothing in the project; the fragment and query of a file link are dropped.
 */
function markdownLinks(lines: string[]): string[] {
    const fenced = fencedLines(lines);
    const out = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
        if (fenced[i]) continue;
        const re = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lines[i]))) {
            const target = m[1].replace(/[#?].*$/, "");
            if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
            try { out.add(decodeURI(target)); } catch { out.add(target); }
        }
    }
    return [...out];
}

/**
 * Identifiers a markdown file writes as inline code (`likeThis`), outside fenced blocks. They are
 * the doc's explicit mentions of code, which codegraph.ts binds to a definition only when exactly
 * one code symbol carries that name.
 */
export function markdownCodeMentions(content: string): { name: string; line: number; }[] {
    const lines = content.split("\n");
    const fenced = fencedLines(lines);
    const out: { name: string; line: number; }[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (fenced[i]) continue;
        const re = /`([A-Za-z_$][\w$]*)(?:\(\))?`/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lines[i]))) out.push({ name: m[1], line: i + 1 });
    }
    return out;
}

/** Extract the symbols and import specifiers of one documentation, schema or config file. */
export function extractDocFile(lang: string, content: string): { symbols: CodeSymbol[]; imports: string[]; } {
    const lines = content.split("\n");
    const out = ((): { symbols: CodeSymbol[]; imports: string[]; } => {
        switch (lang) {
            case "markdown": return { symbols: markdownSymbols(lines), imports: markdownLinks(lines) };
            case "sql": return { symbols: sqlSymbols(lines), imports: [] };
            case "prisma": return { symbols: prismaSymbols(lines), imports: [] };
            case "yaml": return { symbols: yamlSymbols(lines), imports: [] };
            case "toml": return { symbols: tomlSymbols(lines), imports: [] };
            default: return { symbols: [], imports: [] };
        }
    })();
    // A span ends on its last line with content: the blank lines before the next block (or the
    // file's final newline) are not part of it, and a slice that ends on them reads as padding.
    for (const s of out.symbols) while (s.endLine > s.line && !(lines[s.endLine - 1] ?? "").trim()) s.endLine--;
    return out;
}
