/**
 * Native code graph (codebase memory): a zero-dependency TypeScript engine that indexes a
 * project's source into a knowledge graph - files, the symbols they define (functions, classes,
 * ...), the modules they import, and cross-file symbol references - then answers structural
 * queries (architecture overview, symbol search, graph schema). STRUCTURAL code memory,
 * complementary to `recall` (session memory).
 *
 * It is fully native to enigma (no external binary, no npx, no third-party package): extraction is
 * deterministic regex-per-language, like recall's deterministic transcript extraction. It does not
 * aim for a compiler-grade AST across every language - it is honest "structural-lite" over the
 * common languages, good enough to map a codebase without any dependency or network.
 *
 * The graph is persisted per project as JSON under ~/.enigma/codegraph (ENIGMA_CODEGRAPH_DIR
 * overrides it), so the CLI, the MCP tools and the dashboard all read the same store.
 */

import { homedir } from "node:os";
import { readConfig } from "./config";
import { createHash } from "node:crypto";
import { basename, extname, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

// --- storage -------------------------------------------------------------------------

/** Root of the on-disk graph store (env-overridable for tests/mirrors). Resolved lazily. */
function storeDir(): string {
    return process.env.ENIGMA_CODEGRAPH_DIR || join(homedir(), ".enigma", "codegraph");
}

function projectsFile(): string { return join(storeDir(), "projects.json"); }
function graphFile(id: string): string { return join(storeDir(), `${id}.json`); }

function readJsonSafe<T>(file: string, fallback: T): T {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : fallback; } catch { return fallback; }
}

function writeJson(file: string, value: unknown): void {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
}

// --- types ---------------------------------------------------------------------------

export type SymbolKind = "function" | "class" | "interface" | "type" | "struct" | "enum" | "trait" | "module" | "method";

export interface CodeSymbol { name: string; kind: SymbolKind; line: number }
export interface CodeFile { path: string; lang: string; loc: number; symbols: CodeSymbol[]; imports: string[] }

export interface CodeGraph {
    id: string;
    name: string;
    root: string;
    indexedAt: number;
    files: CodeFile[];
    /** Resolved intra-project import edges [fromFile, toFile]. */
    importEdges: [string, string][];
    /** symbolName -> inbound cross-file reference count. */
    refs: Record<string, number>;
    /** external module specifier -> usage count. */
    externalModules: Record<string, number>;
}

export interface ProjectEntry { id: string; name: string; root: string; indexedAt: number; files: number; symbols: number }

/** One indexed project as the dashboard/CLI list it. */
export type CodeGraphProject = ProjectEntry;

// --- language extraction -------------------------------------------------------------

const IGNORE_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target", "vendor",
    "__pycache__", ".venv", "venv", "coverage", ".cache", ".idea", ".vscode",
    ".turbo", ".parcel-cache", ".svelte-kit", "Pods", ".gradle", ".dart_tool",
]);

/** Source extension -> language key. */
const LANG_BY_EXT: Record<string, string> = {
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
    ".rb": "ruby", ".php": "php", ".cs": "csharp", ".kt": "kotlin", ".kts": "kotlin",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
};

const MAX_FILES = 8000;
const MAX_FILE_BYTES = 512 * 1024;

/** A regex that captures a symbol name in group 1, tagged with the kind it declares. */
interface SymRule { kind: SymbolKind; re: RegExp }

function symRules(lang: string): SymRule[] {
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

function importSpecs(lang: string, content: string): string[] {
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

/** Build a fast (byte index -> 1-based line) resolver over `content`. */
function lineResolver(content: string): (idx: number) => number {
    const nl: number[] = [];
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) nl.push(i);
    return (idx) => { let lo = 0, hi = nl.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < idx) lo = mid + 1; else hi = mid; } return lo + 1; };
}

/** Extract the symbols and import specifiers declared in one file's content. */
function extractFile(lang: string, content: string): { symbols: CodeSymbol[]; imports: string[] } {
    const lineAt = lineResolver(content);
    const symbols: CodeSymbol[] = [];
    const seen = new Set<string>();
    for (const { kind, re } of symRules(lang)) {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(content))) {
            const name = m[1];
            const key = `${name}@${m.index}`;
            if (!name || seen.has(key)) continue;
            seen.add(key);
            symbols.push({ name, kind, line: lineAt(m.index) });
        }
    }
    return { symbols, imports: importSpecs(lang, content) };
}

// --- scan ----------------------------------------------------------------------------

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

// --- resolution + build --------------------------------------------------------------

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".kt"];

/** Resolve a relative import specifier to a project-relative file path, or null. */
function resolveRelative(fromFileAbs: string, spec: string, root: string, known: Set<string>): string | null {
    if (!spec.startsWith(".")) return null;
    const base = resolve(fromFileAbs, "..", spec);
    const toRel = (p: string): string => relative(root, p).split("\\").join("/");
    for (const ext of RESOLVE_EXTS) { const rel = toRel(base + ext); if (known.has(rel)) return rel; }
    for (const ext of RESOLVE_EXTS.filter(Boolean)) { const rel = toRel(join(base, `index${ext}`)); if (known.has(rel)) return rel; }
    return null;
}

/**
 * Walk a directory and extract every source file's symbols and imports, without
 * persisting anything. The read-only half of indexing, shared with the parity checker
 * (verify-parity.ts) so comparing two codebases never writes to the code-graph store.
 */
export function scanFiles(rootDir?: string): { root: string; files: CodeFile[] } {
    const root = resolve(rootDir || process.cwd());
    const files: CodeFile[] = [];
    for (const abs of walk(root)) {
        let size = 0;
        try { size = statSync(abs).size; } catch { continue; }
        if (size > MAX_FILE_BYTES) continue;
        let content: string;
        try { content = readFileSync(abs, "utf8"); } catch { continue; }
        const lang = LANG_BY_EXT[extname(abs).toLowerCase()];
        const { symbols, imports } = extractFile(lang, content);
        const path = relative(root, abs).split("\\").join("/");
        files.push({ path, lang, loc: content ? content.split("\n").length : 0, symbols, imports });
    }
    return { root, files };
}

/** Index a project directory into a graph and persist it. Returns the summary entry. */
export function indexProject(rootDir?: string): ProjectEntry {
    const { root, files } = scanFiles(rootDir);
    const id = createHash("sha1").update(root).digest("hex").slice(0, 12);
    const name = basename(root) || root;

    const known = new Set(files.map((f) => f.path));
    const absByPath = new Map(files.map((f) => [f.path, join(root, f.path)]));
    const importEdges: [string, string][] = [];
    const externalModules: Record<string, number> = {};
    for (const f of files) {
        for (const spec of f.imports) {
            const target = resolveRelative(absByPath.get(f.path)!, spec, root, known);
            if (target) importEdges.push([f.path, target]);
            else externalModules[spec] = (externalModules[spec] || 0) + 1;
        }
    }

    // Cross-file symbol references: an identifier that names a symbol defined in ANOTHER file is
    // an inbound reference to that name (a best-effort call graph without full name resolution).
    const nameToDefiners = new Map<string, Set<string>>();
    for (const f of files) for (const s of f.symbols) {
        if (s.name.length < 3) continue; // skip 1-2 char names: too collision-prone
        let set = nameToDefiners.get(s.name); if (!set) { set = new Set(); nameToDefiners.set(s.name, set); }
        set.add(f.path);
    }
    const refs: Record<string, number> = {};
    for (const f of files) {
        let content = ""; try { content = readFileSync(absByPath.get(f.path)!, "utf8"); } catch { continue; }
        const ids = content.match(/[A-Za-z_$][\w$]*/g);
        if (!ids) continue;
        const usedHere = new Set<string>();
        for (const id2 of ids) {
            if (usedHere.has(id2)) continue;
            const definers = nameToDefiners.get(id2);
            if (!definers) continue;
            let crossFile = false; for (const d of definers) if (d !== f.path) { crossFile = true; break; }
            if (!crossFile) continue;
            usedHere.add(id2);
            refs[id2] = (refs[id2] || 0) + 1;
        }
    }

    const graph: CodeGraph = { id, name, root, indexedAt: Date.now(), files, importEdges, refs, externalModules };
    writeJson(graphFile(id), graph);

    const symbols = files.reduce((n, f) => n + f.symbols.length, 0);
    const entry: ProjectEntry = { id, name, root, indexedAt: graph.indexedAt, files: files.length, symbols };
    writeJson(projectsFile(), [...listProjects().filter((p) => p.id !== id), entry]);
    return entry;
}

// --- queries -------------------------------------------------------------------------

/** All indexed projects (most-recently-indexed first). */
export function listProjects(): ProjectEntry[] {
    return readJsonSafe<ProjectEntry[]>(projectsFile(), []).sort((a, b) => b.indexedAt - a.indexedAt);
}

/** dashboard/CLI-facing project list (alias of listProjects with the compat shape). */
export function codeGraphProjects(): CodeGraphProject[] {
    return listProjects();
}

/** Resolve a project by id, exact name, or root path; else the most recent. */
function resolveProject(project?: string): ProjectEntry | null {
    const all = listProjects();
    if (!all.length) return null;
    if (!project) return all[0];
    return all.find((p) => p.id === project || p.name === project || p.root === project) || null;
}

function loadGraph(project?: string): CodeGraph | null {
    const entry = resolveProject(project);
    if (!entry) return null;
    return readJsonSafe<CodeGraph | null>(graphFile(entry.id), null);
}

export interface Architecture {
    project: string;
    languages: Record<string, number>;
    files: number;
    symbols: number;
    importEdges: number;
    entryPoints: string[];
    hotspots: { name: string; refs: number }[];
    packages: Record<string, number>;
    externalModules: { name: string; count: number }[];
}

/** Architecture overview for a project (languages, entry points, hotspots, packages, deps). */
export function codeGraphArchitecture(project?: string): Architecture | null {
    const g = loadGraph(project);
    if (!g) return null;
    const languages: Record<string, number> = {};
    const packages: Record<string, number> = {};
    for (const f of g.files) {
        languages[f.lang] = (languages[f.lang] || 0) + 1;
        const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : ".";
        packages[top] = (packages[top] || 0) + 1;
    }
    const imported = new Set(g.importEdges.map(([, to]) => to));
    const entryPoints = g.files
        .filter((f) => !imported.has(f.path) || /(^|\/)(main|index|cli|app|server|bin)\.\w+$/.test(f.path))
        .map((f) => f.path)
        .filter((p, i, a) => a.indexOf(p) === i)
        .slice(0, 15);
    const hotspots = Object.entries(g.refs).map(([name, refs]) => ({ name, refs })).sort((a, b) => b.refs - a.refs).slice(0, 15);
    const externalModules = Object.entries(g.externalModules).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 20);
    const symbols = g.files.reduce((n, f) => n + f.symbols.length, 0);
    return { project: g.name, languages, files: g.files.length, symbols, importEdges: g.importEdges.length, entryPoints, hotspots, packages, externalModules };
}

export interface GraphSchema { nodes: Record<string, number>; edges: Record<string, number> }

/** Node/edge label counts for a project's graph. */
export function codeGraphSchema(project?: string): GraphSchema | null {
    const g = loadGraph(project);
    if (!g) return null;
    const nodes: Record<string, number> = { File: g.files.length };
    for (const f of g.files) for (const s of f.symbols) {
        const label = s.kind.charAt(0).toUpperCase() + s.kind.slice(1);
        nodes[label] = (nodes[label] || 0) + 1;
    }
    const totalRefs = Object.values(g.refs).reduce((a, b) => a + b, 0);
    return { nodes, edges: { IMPORTS: g.importEdges.length, REFERENCES: totalRefs } };
}

export interface SymbolHit { name: string; kind: SymbolKind; file: string; line: number }

/** Search a project's symbols by name (regex or substring) and optional kind. */
export function searchGraph(project: string | undefined, opts: { name?: string; kind?: string; limit?: number } = {}): SymbolHit[] {
    const g = loadGraph(project);
    if (!g) return [];
    let re: RegExp | null = null;
    if (opts.name) { try { re = new RegExp(opts.name, "i"); } catch { re = new RegExp(opts.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); } }
    const out: SymbolHit[] = [];
    const limit = opts.limit ?? 50;
    for (const f of g.files) for (const s of f.symbols) {
        if (opts.kind && s.kind !== opts.kind) continue;
        if (re && !re.test(s.name)) continue;
        out.push({ name: s.name, kind: s.kind, file: f.path, line: s.line });
        if (out.length >= limit) return out;
    }
    return out;
}

/** Delete every indexed project graph (used by tests and a manual reset). */
export function resetCodeGraph(): void {
    try { rmSync(storeDir(), { recursive: true, force: true }); } catch { /* best-effort */ }
}

// --- status (native: always available) -----------------------------------------------

/** The engine is native, so it is always available. */
export function codeGraphAvailable(): boolean { return true; }

/** Compact state for the dashboard "Enigma Systems" panel. */
export function codeGraphStatus(): { enabled: boolean; available: boolean; projects: number } {
    return { enabled: readConfig().config.codeGraph, available: true, projects: listProjects().length };
}
