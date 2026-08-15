/**
 * Source extraction for the native code graph: the per-language, dependency-free reader that
 * turns a file's text into the symbols it defines (with their full line span and signature) and
 * the modules it imports.
 *
 * Split out of codegraph.ts because extraction is its own responsibility: codegraph.ts resolves
 * what is extracted into a graph (edges, references) and persists it, while everything here is a
 * pure text -> facts transform with no I/O beyond reading the tree.
 *
 * Spans matter more than they look. A symbol that knows only its declaration line can be listed,
 * but it cannot own a hit ("which function is this grep match inside?"), cannot be sliced for
 * inlined source, and cannot be skipped when its body is irrelevant. Every retrieval surface
 * (ask / grep / skeleton) is built on the span, so it is computed here for every symbol: brace
 * balancing for the C-family, indentation for the whitespace-scoped languages.
 */

import { extname, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

export type SymbolKind = "function" | "class" | "interface" | "type" | "struct" | "enum" | "trait" | "module" | "method";

export interface CodeSymbol {
    name: string;
    kind: SymbolKind;
    line: number;
    /** Last line of the definition (>= line). Equal to `line` for one-liners and declarations. */
    endLine: number;
    /** The declaration text, trimmed and capped - the API surface without the body. */
    signature: string;
}

/**
 * What a file's import statements actually bring into scope, for the languages whose imports name
 * their bindings. `null` means the language does not, and reference resolution falls back to
 * matching on the module alone.
 */
export interface ImportBindings {
    /** Identifiers bound directly: named, default and destructured-require imports. */
    names: string[];
    /** `[alias, specifier]` for whole-module imports, so `ns.thing` can resolve through `ns`. */
    namespaces: [string, string][];
}

export interface CodeFile {
    path: string;
    lang: string;
    loc: number;
    symbols: CodeSymbol[];
    imports: string[];
    /** Absent for languages whose imports do not name what they bind (see {@link ImportBindings}). */
    bindings?: ImportBindings;
    /** Byte length of the whole file: the "read it all instead" baseline the savings estimate uses. */
    chars: number;
    /** Size and mtime as of the last index - the stat-only drift probe reads these, never the bytes. */
    size: number;
    mtimeMs: number;
}

const IGNORE_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target", "vendor",
    "__pycache__", ".venv", "venv", "coverage", ".cache", ".idea", ".vscode",
    ".turbo", ".parcel-cache", ".svelte-kit", "Pods", ".gradle", ".dart_tool",
]);

/** Source extension -> language key. */
export const LANG_BY_EXT: Record<string, string> = {
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
    ".rb": "ruby", ".php": "php", ".cs": "csharp", ".kt": "kotlin", ".kts": "kotlin",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
};

const MAX_FILES = 8000;
const MAX_FILE_BYTES = 512 * 1024;

/** Languages whose blocks are delimited by braces - everything else is scoped by indentation. */
const BRACE_LANGS = new Set(["ts", "js", "go", "rust", "java", "csharp", "kotlin", "php", "c", "cpp"]);

/**
 * Languages where `#` opens a line comment. Nowhere else may the brace scan stop at one: in TS/JS
 * `#` opens a private class member and in Rust an attribute, so treating it as a comment drops the
 * rest of the line - including the `{` that opens the body, which closes the span a block early.
 */
const HASH_COMMENT_LANGS = new Set(["php"]);

/** Languages where a line whose first non-space character is `#` is a preprocessor directive. */
const PREPROCESSOR_LANGS = new Set(["c", "cpp"]);

/** A regex that captures a symbol name in group 1, tagged with the kind it declares. */
interface SymRule { kind: SymbolKind; re: RegExp; }

export function symRules(lang: string): SymRule[] {
    switch (lang) {
        case "ts": case "js": return [
            { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm },
            { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
            { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
            { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm },
            { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm },
            { kind: "function", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/gm },
        ];
        case "python": return [
            { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm },
            { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/gm },
        ];
        case "go": return [
            { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
            { kind: "struct", re: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/gm },
            { kind: "interface", re: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/gm },
        ];
        case "rust": return [
            { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm },
            { kind: "struct", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm },
            { kind: "enum", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm },
            { kind: "trait", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm },
        ];
        case "java": case "csharp": case "kotlin": return [
            { kind: "class", re: /^\s*(?:[\w@]+\s+)*(?:class|record)\s+([A-Za-z_]\w*)/gm },
            { kind: "interface", re: /^\s*(?:[\w@]+\s+)*interface\s+([A-Za-z_]\w*)/gm },
            { kind: "enum", re: /^\s*(?:[\w@]+\s+)*enum\s+([A-Za-z_]\w*)/gm },
            { kind: "struct", re: /^\s*(?:[\w@]+\s+)*struct\s+([A-Za-z_]\w*)/gm },
            { kind: "function", re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|suspend|open|fun)\s+)+[A-Za-z_][\w<>\[\],. ]*?\s+([A-Za-z_]\w*)\s*\(/gm },
        ];
        case "ruby": return [
            { kind: "function", re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/gm },
            { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/gm },
            { kind: "module", re: /^\s*module\s+([A-Za-z_]\w*)/gm },
        ];
        case "php": return [
            { kind: "function", re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)/gm },
            { kind: "class", re: /^\s*(?:(?:abstract|final)\s+)*class\s+([A-Za-z_]\w*)/gm },
            { kind: "interface", re: /^\s*interface\s+([A-Za-z_]\w*)/gm },
            { kind: "trait", re: /^\s*trait\s+([A-Za-z_]\w*)/gm },
        ];
        case "c": case "cpp": return [
            { kind: "struct", re: /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/gm },
            { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/gm },
            { kind: "enum", re: /^\s*enum\s+(?:class\s+)?([A-Za-z_]\w*)/gm },
            { kind: "function", re: /^[A-Za-z_][\w\s*&:<>]*?\b([A-Za-z_]\w*)\s*\([^;{)]*\)\s*\{/gm },
        ];
        default: return [];
    }
}

export function importSpecs(lang: string, content: string): string[] {
    const out = new Set<string>();
    const push = (re: RegExp): void => { let m: RegExpExecArray | null; while ((m = re.exec(content))) if (m[1]) out.add(m[1]); };
    switch (lang) {
        case "ts": case "js":
            push(/^\s*import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/gm);
            push(/^\s*import\s+["']([^"']+)["']/gm);
            push(/^\s*export\s+[\s\S]*?\s+from\s+["']([^"']+)["']/gm);
            push(/\brequire\(\s*["']([^"']+)["']\s*\)/g);
            break;
        case "python":
            push(/^\s*import\s+([A-Za-z_][\w.]*)/gm);
            push(/^\s*from\s+([A-Za-z_.][\w.]*)\s+import\b/gm);
            break;
        case "go": {
            push(/^\s*import\s+"([^"]+)"/gm);
            const block = /import\s*\(([\s\S]*?)\)/g; let b: RegExpExecArray | null;
            while ((b = block.exec(content))) { const q = /"([^"]+)"/g; let m: RegExpExecArray | null; while ((m = q.exec(b[1]))) out.add(m[1]); }
            break;
        }
        case "rust": push(/^\s*use\s+([A-Za-z_][\w:]*)/gm); break;
        case "java": case "kotlin": push(/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)/gm); break;
        case "csharp": push(/^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)/gm); break;
        case "ruby": push(/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm); break;
        case "php": push(/^\s*use\s+([A-Za-z_\\][\w\\]*)/gm); break;
        case "c": case "cpp": push(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm); break;
    }
    return [...out];
}

/**
 * The identifiers a file's imports actually bind, when the language says so.
 *
 * This is what separates a real cross-file reference from a coincidence. Knowing only that a file
 * imports some module, every local variable in it that happens to share a name with something that
 * module exports looks like a reference to it - which is how a local `one` or `out` ends up
 * outranking the function half the codebase depends on. Knowing the bound names, it does not.
 */
export function importBindings(lang: string, content: string): ImportBindings | null {
    if (lang !== "ts" && lang !== "js" && lang !== "python") return null;
    const names = new Set<string>();
    const namespaces: [string, string][] = [];
    const addClause = (clause: string): void => {
        for (const part of clause.split(",")) {
            const alias = part.trim().split(/\s+as\s+/).pop();
            if (alias && /^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
        }
    };

    if (lang === "python") {
        let m: RegExpExecArray | null;
        const from = /^\s*from\s+[\w.]+\s+import\s+\(?([^)\n]+)\)?/gm;
        while ((m = from.exec(content))) addClause(m[1].replace(/\*/g, ""));
        return { names: [...names], namespaces };
    }

    let m: RegExpExecArray | null;
    const star = /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/gm;
    while ((m = star.exec(content))) namespaces.push([m[1], m[2]]);
    const requireStar = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = requireStar.exec(content))) namespaces.push([m[1], m[2]]);
    const named = /^\s*(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["'][^"']+["']/gm;
    while ((m = named.exec(content))) {
        const clause = m[1];
        if (clause.includes("*")) continue; // namespace form, already captured above
        const braced = /\{([\s\S]*?)\}/.exec(clause);
        if (braced) addClause(braced[1]);
        const bare = clause.replace(/\{[\s\S]*?\}/g, "").replace(/,/g, " ").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare);
    }
    const requireNamed = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/g;
    while ((m = requireNamed.exec(content))) addClause(m[1].replace(/:/g, " as "));
    return { names: [...names], namespaces };
}

/** Build a fast (byte index -> 1-based line) resolver over `content`. */
export function lineResolver(content: string): (idx: number) => number {
    const nl: number[] = [];
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) nl.push(i);
    return (idx) => { let lo = 0, hi = nl.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < idx) lo = mid + 1; else hi = mid; } return lo + 1; };
}

/** Leading-whitespace width of a line, tabs counted as one column (only relative depth matters). */
function indentOf(line: string): number {
    let n = 0;
    while (n < line.length && (line[n] === " " || line[n] === "\t")) n++;
    return n;
}

/** A line with its trailing line-comment removed, so `) {  // note` still reads as opening a body. */
function withoutTrailingComment(line: string): string {
    const slash = line.indexOf("//");
    return (slash === -1 ? line : line.slice(0, slash)).trimEnd();
}

/**
 * Last line of a brace-delimited definition.
 *
 * The body opens at the LAST brace of the first line that ENDS in one - not at the first brace
 * seen. That distinction is the whole trick: a default parameter value (`opts: Options = {}`) or
 * an inline object in the signature opens and closes a brace right there on the declaration line,
 * and a naive balance would call the definition one line long. From that opening brace the count
 * runs to zero, skipping strings and comments so a brace inside a message cannot unbalance it.
 *
 * A declaration with no such line within `LOOKAHEAD_LINES` is a prototype, an abstract member, or
 * a single-expression arrow, and spans its own line only.
 */
function braceEnd(lines: string[], startIdx: number, lang: string): number {
    const LOOKAHEAD_LINES = 3;
    let openLine = -1;
    for (let i = startIdx; i <= Math.min(startIdx + LOOKAHEAD_LINES, lines.length - 1); i++) {
        if (withoutTrailingComment(lines[i]).endsWith("{")) { openLine = i; break; }
    }
    if (openLine === -1) return startIdx + 1;

    const hashComment = HASH_COMMENT_LANGS.has(lang);
    const preprocessor = PREPROCESSOR_LANGS.has(lang);
    let depth = 0;
    let inBlockComment = false;
    for (let i = openLine; i < lines.length; i++) {
        const line = lines[i];
        const hashEndsLine = hashComment || (preprocessor && line.trimStart().startsWith("#"));
        const from = i === openLine ? line.lastIndexOf("{") : 0;
        let inString: string | null = null;
        for (let c = from; c < line.length; c++) {
            const ch = line[c];
            if (inBlockComment) { if (ch === "*" && line[c + 1] === "/") { inBlockComment = false; c++; } continue; }
            if (inString) {
                if (ch === "\\") { c++; continue; }
                if (ch === inString) inString = null;
                continue;
            }
            if (ch === "/" && line[c + 1] === "/") break;
            if (ch === "#" && hashEndsLine && line[c + 1] !== "{") break;
            if (ch === "/" && line[c + 1] === "*") { inBlockComment = true; c++; continue; }
            if (ch === "\"" || ch === "'" || ch === "`") { inString = ch; continue; }
            if (ch === "{") { depth++; continue; }
            if (ch === "}" && --depth <= 0) return i + 1;
        }
    }
    return lines.length;
}

/**
 * Last line of an indentation-scoped definition: the final line before the first non-blank line
 * indented at or below the declaration. Comment lines at the boundary are excluded, so a
 * docstring-style comment introducing the NEXT definition is not swallowed into this one.
 */
function indentEnd(lines: string[], startIdx: number): number {
    const base = indentOf(lines[startIdx]);
    let end = startIdx + 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (indentOf(line) <= base) break;
        end = i + 1;
    }
    return end;
}

/**
 * No definition may run past the next one declared at its own nesting level or shallower.
 *
 * Brace counting has one blind spot a regex reader cannot close: a brace inside a regex literal
 * (`[^;{)]`, `\{`) is a brace as far as the scan is concerned, so one such definition swallows
 * every definition after it and its span becomes a lie the retrieval layer then repeats. Sibling
 * clamping bounds the damage without touching legitimate nesting - a method sits deeper than its
 * class, so a class still ends after its methods.
 */
function clampToSiblings(symbols: CodeSymbol[], lines: string[]): void {
    const indentAt = (line: number): number => indentOf(lines[line - 1] ?? "");
    for (let i = 0; i < symbols.length; i++) {
        const s = symbols[i];
        for (let j = i + 1; j < symbols.length; j++) {
            const next = symbols[j];
            if (next.line <= s.line) continue;
            if (indentAt(next.line) > indentAt(s.line)) continue;
            s.endLine = Math.max(s.line, Math.min(s.endLine, next.line - 1));
            break;
        }
    }
}

/** The declaration text an agent reads instead of the body: up to the block opener, capped. */
function signatureOf(line: string): string {
    const MAX_SIGNATURE = 200;
    let sig = line.trim();
    const brace = sig.indexOf("{");
    if (brace > 0) sig = sig.slice(0, brace).trim();
    if (sig.endsWith(":")) sig = sig.slice(0, -1).trim();
    return sig.length > MAX_SIGNATURE ? `${sig.slice(0, MAX_SIGNATURE)}...` : sig;
}

/** Extract the symbols and import specifiers declared in one file's content. */
export function extractFile(lang: string, content: string): { symbols: CodeSymbol[]; imports: string[]; } {
    const lineAt = lineResolver(content);
    const lines = content.split("\n");
    const braced = BRACE_LANGS.has(lang);
    const symbols: CodeSymbol[] = [];
    const seen = new Set<string>();
    for (const { kind, re } of symRules(lang)) {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(content))) {
            const name = m[1];
            if (!name) continue;
            // The line is taken from where the NAME sits, not where the match began. A rule's
            // leading `\s*` can swallow the preceding newline, so a match after a blank line
            // starts on that blank line - which would file the symbol one line too early and put
            // an empty string in its signature, then propagate that offset into every span, grep
            // attribution and inlined source slice built on it.
            const nameIdx = m.index + m[0].lastIndexOf(name);
            const key = `${name}@${nameIdx}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const line = lineAt(nameIdx);
            const startIdx = line - 1;
            const endLine = braced ? braceEnd(lines, startIdx, lang) : indentEnd(lines, startIdx);
            symbols.push({ name, kind, line, endLine: Math.max(line, endLine), signature: signatureOf(lines[startIdx] ?? "") });
        }
    }
    symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    if (braced) clampToSiblings(symbols, lines);
    return { symbols, imports: importSpecs(lang, content) };
}

function walk(root: string): string[] {
    const files: string[] = [];
    const stack = [root];
    while (stack.length && files.length < MAX_FILES) {
        const dir = stack.pop()!;
        let entries: import("node:fs").Dirent[];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (files.length >= MAX_FILES) break;
            if (e.isDirectory()) { if (!e.name.startsWith(".") && !IGNORE_DIRS.has(e.name)) stack.push(join(dir, e.name)); continue; }
            if (!e.isFile()) continue;
            if (LANG_BY_EXT[extname(e.name).toLowerCase()]) files.push(join(dir, e.name));
        }
    }
    return files;
}

/** Repo-relative, forward-slashed path - the one path form every stored id and query uses. */
export function relPath(root: string, abs: string): string {
    return relative(root, abs).split("\\").join("/");
}

/**
 * Walk a directory and extract every source file's symbols and imports, without persisting
 * anything. The read-only half of indexing, shared with the parity checker (verify-parity.ts) so
 * comparing two codebases never writes to the code-graph store.
 */
export function scanFiles(rootDir?: string): { root: string; files: CodeFile[]; truncated: boolean; } {
    const root = resolve(rootDir || process.cwd());
    const files: CodeFile[] = [];
    // Both caps are reported, not just applied: a caller that compares two trees (the parity
    // check) would otherwise score an unread module as absent-free and call a port complete.
    let truncated = false;
    const walked = walk(root);
    for (const abs of walked) {
        let size = 0;
        let mtimeMs = 0;
        try { const st = statSync(abs); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
        if (size > MAX_FILE_BYTES) { truncated = true; continue; }
        let content: string;
        try { content = readFileSync(abs, "utf8"); } catch { continue; }
        const lang = LANG_BY_EXT[extname(abs).toLowerCase()];
        const { symbols, imports } = extractFile(lang, content);
        files.push({
            path: relPath(root, abs), lang, loc: content ? content.split("\n").length : 0,
            symbols, imports, bindings: importBindings(lang, content) ?? undefined,
            chars: content.length, size, mtimeMs,
        });
    }
    // Measured on what walk() RETURNED, not on what survived per-file drops: a tree that hit
    // the cap and also had one unreadable file would otherwise report full coverage.
    if (walked.length >= MAX_FILES) truncated = true;
    return { root, files, truncated };
}

/** Every source file currently on disk with its stat, for the drift probe (no reads, no parsing). */
export function statSourceFiles(root: string): Map<string, { size: number; mtimeMs: number; }> {
    const out = new Map<string, { size: number; mtimeMs: number; }>();
    for (const abs of walk(root)) {
        try {
            const st = statSync(abs);
            if (st.size > MAX_FILE_BYTES) continue;
            out.set(relPath(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished between walk and stat - the next probe sees it */ }
    }
    return out;
}
