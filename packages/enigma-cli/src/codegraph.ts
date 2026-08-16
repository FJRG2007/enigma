/**
 * Native code graph (codebase memory): a zero-dependency TypeScript engine that indexes a
 * project's source into a knowledge graph - files, the symbols they define (functions, classes,
 * ...), the modules they import, and the symbol-to-symbol wiring between them - then answers
 * structural queries. STRUCTURAL code memory, complementary to `recall` (session memory).
 *
 * It is fully native to enigma (no external binary, no npx, no third-party package): extraction is
 * deterministic regex-per-language (codegraph-extract.ts), like recall's deterministic transcript
 * extraction. It does not aim for a compiler-grade AST across every language - it is honest
 * "structural-lite" over the common languages, good enough to map a codebase without any
 * dependency or network.
 *
 * This module owns resolution and storage: turning extracted facts into typed edges (contains,
 * imports, calls, references, extends, implements) and persisting the graph per project as JSON
 * under ~/.enigma/codegraph (ENIGMA_CODEGRAPH_DIR overrides it), so the CLI, the MCP tools and the
 * dashboard all read the same store. The retrieval layer built on those edges - ask, callers,
 * skeleton, map, grep - lives in codegraph-query.ts.
 */

import { homedir } from "node:os";
import { readConfig } from "./config";
import { createHash } from "node:crypto";
import { tokenize } from "./codegraph-rank";
import { basename, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { WALK_RELATIONS, type BodyIndex, type CodeEdge, type EdgeRelation, type GraphNode } from "./codegraph-types";
import { relPath, scanFiles, statSourceFiles, type CodeFile, type CodeSymbol, type SymbolKind } from "./codegraph-extract";

export { scanFiles } from "./codegraph-extract";
export { WALK_RELATIONS } from "./codegraph-types";
export type { CodeFile, CodeSymbol, SymbolKind } from "./codegraph-extract";
export type { BodyIndex, CodeEdge, EdgeRelation, GraphNode } from "./codegraph-types";

// --- storage -------------------------------------------------------------------------

/** Root of the on-disk graph store (env-overridable for tests/mirrors). Resolved lazily. */
function storeDir(): string {
    return process.env.ENIGMA_CODEGRAPH_DIR || join(homedir(), ".enigma", "codegraph");
}

function projectsFile(): string { return join(storeDir(), "projects.json"); }
function graphFile(id: string): string { return join(storeDir(), `${id}.json`); }
function bodyIndexFile(id: string): string { return join(storeDir(), `${id}.bodies.json`); }

function readJsonSafe<T>(file: string, fallback: T): T {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : fallback; } catch { return fallback; }
}

function writeJson(file: string, value: unknown): void {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
}

// --- types ---------------------------------------------------------------------------

/** Bumped when the stored shape changes; an older graph is re-indexed instead of misread. */
export const GRAPH_VERSION = 3;

export interface CodeGraph {
    version: number;
    id: string;
    name: string;
    root: string;
    indexedAt: number;
    files: CodeFile[];
    /** Resolved intra-project import edges [fromFile, toFile]. */
    importEdges: [string, string][];
    /** Typed wiring, symbol ids on both ends except imports (file ids) and unresolved targets. */
    edges: CodeEdge[];
    /** symbolName -> inbound reference count. Kept as the architecture view's hotspot ranking. */
    refs: Record<string, number>;
    /** external module specifier -> usage count. */
    externalModules: Record<string, number>;
    /**
     * The scan hit a cap (too many files, or a file over the size limit), so the graph does not
     * cover the whole tree. Carried, never inferred: a surface that reads as exhaustive - grep
     * above all - has to be able to say when it is not.
     */
    truncated: boolean;
}

export interface ProjectEntry { id: string; name: string; root: string; indexedAt: number; files: number; symbols: number; truncated: boolean; }

/** One indexed project as the dashboard/CLI list it. */
export type CodeGraphProject = ProjectEntry;

// --- resolution + build --------------------------------------------------------------

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".kt"];

/** Names shorter than this collide across unrelated files far more often than they resolve. */
const MIN_REF_NAME = 3;

/** Hard ceiling on wiring edges: a pathological tree degrades to a smaller graph, never a hang. */
const MAX_EDGES = 400_000;

/** Directory entry points, in the order a module path falls back through them. */
const INDEX_NAMES = ["index", "__init__", "mod"];

/**
 * Where a language's absolute module path may be rooted. `""` is the project root; the rest are
 * the conventional source roots a package name is written relative to, so `src.utils.basics`
 * finds `src/utils/basics.py` and `com.acme.Thing` finds `src/main/java/com/acme/Thing.java`.
 */
const MODULE_ROOTS = ["", "src", "lib", "app", "source", "src/main/java", "src/main/kotlin", "src/test/java"];

/** Languages whose module path is dotted (`a.b.c`), and the separator each one writes it with. */
const MODULE_SEPARATOR: Record<string, string> = { python: ".", java: ".", kotlin: ".", csharp: ".", php: "\\", rust: "::" };

/**
 * Does a project-relative module path (no extension) name a file in this project? Every candidate
 * is checked against the real file set, which is what makes non-relative resolution safe: a
 * spelling that matches nothing resolves to nothing, so a guess can never become an edge.
 */
function verifyModule(base: string, known: Set<string>): string | null {
    if (!base || base.startsWith("..")) return null;
    for (const ext of RESOLVE_EXTS) if (known.has(base + ext)) return base + ext;
    for (const name of INDEX_NAMES) {
        for (const ext of RESOLVE_EXTS) if (ext && known.has(`${base}/${name}${ext}`)) return `${base}/${name}${ext}`;
    }
    return null;
}

/** The module path of a Go project, read from go.mod - the only non-guessy way to tell its own packages from the ecosystem's. */
function goModulePath(root: string): string | null {
    try { return /^\s*module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"))?.[1] ?? null; } catch { return null; }
}

/**
 * Resolve import specifiers to the project files they name.
 *
 * A relative specifier is only how JS spells it. Python writes `src.utils.basics`, Go writes the
 * module path from go.mod, Java and C# write a dotted namespace, PHP a backslashed one, Rust
 * `crate::a::b`, and a bundler-aliased TS import writes `@/lib/x` - none of which start with a dot.
 * Resolving only the dotted-path form left every one of those projects with an import graph of
 * zero edges: no ranking signal, no blast radius across files, and its own modules listed as
 * third-party dependencies.
 *
 * Returns a list because one import can name a whole package: a Go import binds the directory,
 * which is every `.go` file in it.
 */
function createImportResolver(root: string, known: Set<string>): (fromRel: string, lang: string, spec: string) => string[] {
    const goModule = goModulePath(root);
    let goByDir: Map<string, string[]> | null = null;

    const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
    const joinRel = (dir: string, rest: string[]): string => [...(dir ? [dir] : []), ...rest].join("/");
    const underRoots = (segments: string[]): string | null => {
        for (const base of MODULE_ROOTS) {
            const hit = verifyModule(joinRel(base, segments), known);
            if (hit) return hit;
        }
        return null;
    };
    const relative = (fromRel: string, spec: string): string | null => {
        const abs = resolve(join(root, fromRel), "..", spec);
        return verifyModule(relPath(root, abs), known);
    };

    return (fromRel, lang, spec) => {
        if (lang === "go") {
            if (!goModule || (spec !== goModule && !spec.startsWith(`${goModule}/`))) return [];
            const dir = spec === goModule ? "" : spec.slice(goModule.length + 1);
            if (!goByDir) {
                goByDir = new Map();
                for (const p of known) {
                    if (!p.endsWith(".go")) continue;
                    const d = dirOf(p);
                    const list = goByDir.get(d);
                    if (list) list.push(p); else goByDir.set(d, [p]);
                }
            }
            return goByDir.get(dir) ?? [];
        }

        // Python spells "relative" with leading dots, not with a path: `.` is this package,
        // `..` the one above. Handled here so the JS-shaped path below never sees it.
        if (lang === "python") {
            const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
            const segments = spec.slice(dots).split(".").filter(Boolean);
            if (dots > 0) {
                let dir = dirOf(fromRel);
                for (let up = 1; up < dots; up++) dir = dirOf(dir);
                return [verifyModule(joinRel(dir, segments), known)].filter((p): p is string => !!p);
            }
            return [underRoots(segments)].filter((p): p is string => !!p);
        }

        if (spec.startsWith(".")) return [relative(fromRel, spec)].filter((p): p is string => !!p);

        const separator = MODULE_SEPARATOR[lang];
        if (separator) {
            const segments = spec.split(separator).filter((s) => s && s !== "crate" && s !== "self");
            // The last segment of a namespace is usually the type, not the file; `a.b.Thing` is
            // tried as a file first, then as a member of `a/b`.
            return [underRoots(segments) ?? (segments.length > 1 ? underRoots(segments.slice(0, -1)) : null)]
                .filter((p): p is string => !!p);
        }

        // Everything left is written as a path: a bundler alias (`@/lib/x`), a source-root import
        // (`src/lib/x`), a `require_relative`, or a quoted C include.
        const path = spec.replace(/^[@~#]\//, "").replace(/^\/+/, "");
        return [relative(fromRel, `./${path}`) ?? underRoots(path.split("/"))].filter((p): p is string => !!p);
    };
}

/** Stable id for a symbol: `path#name`, with a `~n` ordinal when a file declares the name twice. */
function symbolId(path: string, name: string, taken: Set<string>): string {
    const base = `${path}#${name}`;
    if (!taken.has(base)) { taken.add(base); return base; }
    for (let n = 2; ; n++) {
        const candidate = `${base}~${n}`;
        if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
    }
}

/**
 * Mint every node of a file set, files first then their symbols in declaration order.
 *
 * The single source of node ids: the build and every later load call this, so an id minted at
 * index time is the same id a query resolves months later without the ids being persisted.
 */
function mintNodes(files: CodeFile[]): GraphNode[] {
    const taken = new Set<string>();
    const nodes: GraphNode[] = [];
    for (const f of files) {
        nodes.push({ id: f.path, name: basename(f.path), kind: "file", path: f.path, line: 1, endLine: f.loc, signature: "", chars: f.chars });
        for (const s of f.symbols) {
            nodes.push({ id: symbolId(f.path, s.name, taken), name: s.name, kind: s.kind, path: f.path, line: s.line, endLine: s.endLine, signature: s.signature });
        }
    }
    return nodes;
}

/** Innermost symbol whose span contains `line`, given that file's symbols sorted by start line. */
function enclosingSymbol(spans: { id: string; line: number; endLine: number; }[], line: number): string | null {
    let found: string | null = null;
    for (const s of spans) {
        if (s.line > line) break;
        if (line <= s.endLine) found = s.id;
    }
    return found;
}

/** The base types named by a class/interface declaration, as `[relation, name]` pairs. */
function inheritanceTargets(signature: string): [EdgeRelation, string][] {
    const out: [EdgeRelation, string][] = [];
    const ext = /\bextends\s+([\w$.<>,\s]+?)(?:\s+implements\b|$)/.exec(signature);
    const impl = /\bimplements\s+([\w$.<>,\s]+)$/.exec(signature);
    const names = (clause: string): string[] => clause
        .split(",")
        .map((s) => s.trim().replace(/<.*$/, "").split(".").pop() || "")
        .filter((s) => s.length >= MIN_REF_NAME);
    if (ext) for (const n of names(ext[1])) out.push(["extends", n]);
    if (impl) for (const n of names(impl[1])) out.push(["implements", n]);
    return out;
}

/**
 * Wire the extracted files into typed edges.
 *
 * Reference resolution is name-based and import-aware, in that order of preference: a name that
 * resolves to exactly one definition binds to it; an ambiguous name binds only when exactly one
 * candidate sits in a file this one imports (or in this file itself). Anything still ambiguous is
 * dropped rather than guessed - a wrong edge is worse than a missing one, because it silently
 * misdirects a blast-radius query.
 */
function buildEdges(
    root: string,
    files: CodeFile[],
    importEdges: [string, string][],
    resolveImport: (fromRel: string, lang: string, spec: string) => string[],
): { edges: CodeEdge[]; refs: Record<string, number>; bodies: BodyIndex; } {
    const nodes = mintNodes(files);
    const spansByFile = new Map<string, { id: string; line: number; endLine: number; }[]>();
    const defsByName = new Map<string, { id: string; path: string; }[]>();

    for (const n of nodes) {
        if (n.kind === "file") { spansByFile.set(n.path, []); continue; }
        spansByFile.get(n.path)!.push({ id: n.id, line: n.line, endLine: n.endLine });
        if (n.name.length >= MIN_REF_NAME) {
            let list = defsByName.get(n.name);
            if (!list) { list = []; defsByName.set(n.name, list); }
            list.push({ id: n.id, path: n.path });
        }
    }
    for (const spans of spansByFile.values()) spans.sort((a, b) => a.line - b.line);

    const importsOf = new Map<string, Set<string>>();
    for (const [from, to] of importEdges) {
        let set = importsOf.get(from);
        if (!set) { set = new Set(); importsOf.set(from, set); }
        set.add(to);
    }

    const edges: CodeEdge[] = [];
    const seen = new Set<string>();
    const push = (from: string, to: string, rel: EdgeRelation): void => {
        if (edges.length >= MAX_EDGES || from === to) return;
        const key = `${from}|${to}|${rel}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push([from, to, rel]);
    };

    for (const f of files) {
        for (const span of spansByFile.get(f.path) ?? []) push(f.path, span.id, "contains");
        for (const to of importsOf.get(f.path) ?? []) push(f.path, to, "imports");
    }

    const known = new Set(files.map((f) => f.path));
    const idByPathName = new Map<string, string>();
    // Per-file name -> id, with null marking a name the file declares more than once (ambiguous).
    const localDefs = new Map<string, Map<string, string | null>>();
    for (const n of nodes) {
        if (n.kind === "file") { localDefs.set(n.path, new Map()); continue; }
        const key = `${n.path}#${n.name}`;
        if (!idByPathName.has(key)) idByPathName.set(key, n.id);
        const local = localDefs.get(n.path)!;
        local.set(n.name, local.has(n.name) ? null : n.id);
    }

    /**
     * The resolver for one file: which definition, if any, an identifier in it refers to.
     *
     * A name resolves inside its own file first, and crosses a file boundary only through an
     * import that actually binds that name. The weaker "globally unique name" rule is a disaster
     * of a heuristic - every local `out`, `dir` or `err` in the repo binds to whichever single
     * file happens to declare that name, inventing hundreds of dependencies and crowning a local
     * helper as the codebase's biggest hub. It survives only as the fallback for languages whose
     * imports do not name their bindings, where the alternative is no cross-file edges at all.
     */
    function binderFor(f: CodeFile): (name: string, memberOf?: string) => string | null {
        const local = localDefs.get(f.path) ?? new Map<string, string | null>();
        const imported = importsOf.get(f.path);
        const unique = (name: string): string | null => {
            const candidates = defsByName.get(name)?.filter((c) => imported?.has(c.path));
            return candidates?.length === 1 ? candidates[0].id : null;
        };
        if (!f.bindings) {
            return (name) => {
                if (local.has(name)) return local.get(name) ?? null;
                if (imported?.size) return unique(name);
                const all = defsByName.get(name);
                return all?.length === 1 ? all[0].id : null;
            };
        }
        const bound = new Set(f.bindings.names);
        const namespaces = new Map<string, string>();
        for (const [alias, spec] of f.bindings.namespaces) {
            const [target] = resolveImport(f.path, f.lang, spec);
            if (target) namespaces.set(alias, target);
        }
        return (name, memberOf) => {
            // `ns.thing` resolves only through a namespace import; any other `x.thing` is a
            // property of some value, not a reference to a top-level definition.
            if (memberOf !== undefined) {
                const path = namespaces.get(memberOf);
                return path ? idByPathName.get(`${path}#${name}`) ?? null : null;
            }
            if (local.has(name)) return local.get(name) ?? null;
            return bound.has(name) ? unique(name) : null;
        };
    }

    const refs: Record<string, number> = {};
    const bodies: BodyIndex = [];
    const nameById = new Map(nodes.map((n) => [n.id, n.name]));
    const pathById = new Map(nodes.map((n) => [n.id, n.path]));

    for (const f of files) {
        let content = "";
        try { content = readFileSync(join(root, f.path), "utf8"); } catch { continue; }
        const spans = spansByFile.get(f.path) ?? [];
        const declLines = new Set(f.symbols.map((s) => s.line));
        const lines = content.split("\n");
        indexBodies(bodies, f.path, spans, lines);
        const bind = binderFor(f);
        // Only the languages with named import bindings can tell `ns.thing` from `value.thing`;
        // for the rest the prefix scan is pure cost, so it is skipped entirely.
        const strict = !!f.bindings;

        for (const s of f.symbols) {
            if (s.kind !== "class" && s.kind !== "interface" && s.kind !== "struct") continue;
            const self = spans.find((sp) => sp.line === s.line);
            if (!self) continue;
            for (const [rel, name] of inheritanceTargets(s.signature)) {
                const target = bind(name);
                if (target) push(self.id, target, rel);
            }
        }

        for (let i = 0; i < lines.length; i++) {
            const lineNo = i + 1;
            if (declLines.has(lineNo)) continue; // the declaration itself is not a reference to itself
            const line = lines[i];
            const from = enclosingSymbol(spans, lineNo) ?? f.path;
            const ident = /[A-Za-z_$][\w$]*/g;
            let m: RegExpExecArray | null;
            while ((m = ident.exec(line))) {
                const name = m[0];
                if (name.length < MIN_REF_NAME || !defsByName.has(name)) continue;
                const memberOf = strict ? /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(line.slice(0, m.index))?.[1] : undefined;
                const target = bind(name, memberOf);
                if (!target || target === from) continue;
                const after = line.slice(m.index + name.length);
                push(from, target, /^\s*\(/.test(after) ? "calls" : "references");
                if (pathById.get(target) !== f.path) {
                    const targetName = nameById.get(target) ?? name;
                    refs[targetName] = (refs[targetName] || 0) + 1;
                }
            }
        }
    }

    return { edges, refs, bodies };
}

/** Distinct tokens kept per node - enough to make a definition findable by its own vocabulary,
 * few enough that the sidecar stays a fraction of the source it describes. */
const MAX_BODY_TOKENS = 80;

/**
 * Record the searchable vocabulary of each node in a file: a symbol's own definition text, and
 * for the file node the residual lines no symbol covers (imports, constants, top-level code).
 *
 * This is what makes a term that appears only in the CODE - never in a name, path or signature -
 * still find its node, without a query ever having to re-read the tree.
 */
function indexBodies(out: BodyIndex, path: string, spans: { id: string; line: number; endLine: number; }[], lines: string[]): void {
    const covered = new Uint8Array(lines.length + 1);
    for (const s of spans) {
        const text = lines.slice(s.line - 1, s.endLine).join("\n");
        for (let l = s.line; l <= Math.min(s.endLine, lines.length); l++) covered[l] = 1;
        const bag = topTokens(text);
        if (bag.length) out.push([s.id, bag]);
    }
    const residual: string[] = [];
    for (let l = 1; l <= lines.length; l++) if (!covered[l]) residual.push(lines[l - 1]);
    const fileBag = topTokens(residual.join("\n"));
    if (fileBag.length) out.push([path, fileBag]);
}

/** The `MAX_BODY_TOKENS` most frequent tokens of `text`, ties broken by token for determinism. */
function topTokens(text: string): [string, number][] {
    const m = new Map<string, number>();
    for (const t of tokenize(text)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_BODY_TOKENS);
}

/** Index a project directory into a graph and persist it. Returns the summary entry. */
export function indexProject(rootDir?: string): ProjectEntry {
    const { root, files, truncated } = scanFiles(rootDir);
    const id = createHash("sha1").update(root).digest("hex").slice(0, 12);
    const name = basename(root) || root;

    const known = new Set(files.map((f) => f.path));
    const resolveImport = createImportResolver(root, known);
    const importEdges: [string, string][] = [];
    const externalModules: Record<string, number> = {};
    for (const f of files) {
        for (const spec of f.imports) {
            const targets = resolveImport(f.path, f.lang, spec);
            // A specifier resolving to nothing inside the project is a dependency, by definition:
            // the count is what the architecture view reports as this project's external surface,
            // so a module of its own listed here means resolution missed it.
            if (!targets.length) { externalModules[spec] = (externalModules[spec] || 0) + 1; continue; }
            for (const target of targets) if (target !== f.path) importEdges.push([f.path, target]);
        }
    }

    const { edges, refs, bodies } = buildEdges(root, files, importEdges, resolveImport);
    const graph: CodeGraph = { version: GRAPH_VERSION, id, name, root, indexedAt: Date.now(), files, importEdges, edges, refs, externalModules, truncated };
    writeJson(graphFile(id), graph);
    writeJson(bodyIndexFile(id), bodies);

    const symbols = files.reduce((n, f) => n + f.symbols.length, 0);
    const entry: ProjectEntry = { id, name, root, indexedAt: graph.indexedAt, files: files.length, symbols, truncated };
    writeJson(projectsFile(), [...listProjects().filter((p) => p.id !== id), entry]);
    return entry;
}

// --- queries -------------------------------------------------------------------------

/** All indexed projects (most-recently-indexed first). */
export function listProjects(): ProjectEntry[] {
    const stored = readJsonSafe<ProjectEntry[]>(projectsFile(), [])
        .map((p) => ({ ...p, truncated: p.truncated === true }));
    const live = stored.filter((p) => !p.root || existsSync(p.root));
    // A project whose root is gone is not a project. Anything that indexes a temporary checkout
    // leaves one behind - the quality gate runs in a throwaway worktree, so every run added an
    // entry named after its run id and ~25 MB of graph that nothing would ever read again.
    // Deleting is safe by construction: a graph is derived from the tree, never a source of truth.
    if (live.length !== stored.length) {
        for (const dead of stored.filter((p) => !live.includes(p))) {
            rmSync(graphFile(dead.id), { force: true });
            rmSync(bodyIndexFile(dead.id), { force: true });
        }
        writeJson(projectsFile(), live);
    }
    return live.sort((a, b) => b.indexedAt - a.indexedAt);
}

/** dashboard/CLI-facing project list (alias of listProjects with the compat shape). */
export function codeGraphProjects(): CodeGraphProject[] {
    return listProjects();
}

/**
 * Resolve a project by id, exact name, or root path.
 *
 * With nothing named, the project containing the current directory wins over the most recently
 * indexed one - answering a question asked inside repo B with repo A's graph is worse than saying
 * nothing, and "most recent" is exactly how that happens.
 */
function resolveProject(project?: string): ProjectEntry | null {
    const all = listProjects();
    if (!all.length) return null;
    if (project) return all.find((p) => p.id === project || p.name === project || p.root === project) || null;
    const cwd = resolve(process.cwd());
    const covering = all
        .filter((p) => cwd === p.root || cwd.startsWith(`${p.root}${cwd.includes("\\") ? "\\" : "/"}`))
        .sort((a, b) => b.root.length - a.root.length);
    return covering[0] ?? all[0];
}

/** Files that mark the top of a project - checked walking up from the working directory. */
const ROOT_MARKERS = [".git", "package.json", "go.mod", "pyproject.toml", "Cargo.toml", "pom.xml", "composer.json"];

/** How far up the walk may look for one. Past this the answer is "there is no project above me". */
const MAX_ROOT_WALK = 6;

/**
 * The root a query asked from `dir` is really about: the nearest ancestor that looks like a
 * project. An agent's working directory is often several levels down, and indexing that directory
 * alone would build a graph that cannot see the code calling into it - which is exactly the
 * question the graph exists to answer.
 */
function projectRootOf(dir: string): string {
    const start = resolve(dir);
    if (ROOT_MARKERS.some((marker) => existsSync(join(start, marker)))) return start;

    // Only a repository boundary justifies climbing. A manifest in some ANCESTOR is not evidence
    // that this directory belongs to it: a scratch folder under a temp dir that happens to hold
    // another tool's package.json would be indexed as part of it - measured here as forty thousand
    // symbols of unrelated code answering a question about four files. `.git` cannot be borrowed
    // that way, and the walk is bounded and never leaves the home directory besides.
    const home = resolve(homedir());
    let current = start;
    for (let up = 0; up < MAX_ROOT_WALK; up++) {
        const parent = resolve(current, "..");
        if (parent === current || parent === home) break;
        current = parent;
        if (existsSync(join(current, ".git"))) return current;
    }
    return start;
}

/**
 * The graph a query asked from `dir` should read, indexing it first when nothing covers it.
 * Returns the project id, so a caller never has to guess which graph it just got.
 *
 * `dir` defaults to the working directory but must be passed by any caller that knows better -
 * a session hook is told which project it is speaking about, and taking the process cwd there
 * would answer a question about one repo with another repo's graph.
 */
export function ensureProjectForCwd(dir?: string): string {
    const from = resolve(dir || process.cwd());
    const covering = listProjects()
        .filter((p) => from === p.root || from.startsWith(`${p.root}${from.includes("\\") ? "\\" : "/"}`))
        .sort((a, b) => b.root.length - a.root.length)[0];
    if (covering) return covering.id;
    return indexProject(projectRootOf(from)).id;
}

export function loadGraph(project?: string): CodeGraph | null {
    const entry = resolveProject(project);
    if (!entry) return null;
    return readJsonSafe<CodeGraph | null>(graphFile(entry.id), null);
}

/**
 * The graph in a shape this build understands, re-indexing it when the stored one predates the
 * current shape. Every read-only surface goes through this: a graph written by an older build has
 * fields that mean something else or are missing entirely, and rendering it reports an empty edge
 * set for a codebase full of them - a wrong answer wearing the clothes of a real one.
 *
 * Drift is deliberately NOT repaired here. A stale FORMAT is unusable; stale CONTENT still answers,
 * and re-parsing the tree on every panel render would turn a page refresh into a full index.
 */
export function loadCompatibleGraph(project?: string): CodeGraph | null {
    const graph = loadGraph(project);
    if (!graph || graph.version === GRAPH_VERSION) return graph;
    if (!graph.root || !existsSync(graph.root)) return null;
    indexProject(graph.root);
    return loadGraph(graph.id);
}

/**
 * The searchable vocabulary written beside a graph. Missing or unreadable degrades to an empty
 * index, which costs recall on body-only terms - never correctness, and never an error.
 */
export function loadBodyIndex(graphId: string): Map<string, Map<string, number>> {
    const raw = readJsonSafe<BodyIndex>(bodyIndexFile(graphId), []);
    const out = new Map<string, Map<string, number>>();
    for (const [id, bag] of raw) out.set(id, new Map(bag));
    return out;
}

/** What moved in the working tree since the last index. Empty everywhere = the graph is current. */
export interface CodeGraphDrift { changed: string[]; added: string[]; removed: string[]; }

export function isCleanDrift(d: CodeGraphDrift): boolean {
    return d.changed.length === 0 && d.added.length === 0 && d.removed.length === 0;
}

export function driftCount(d: CodeGraphDrift): number {
    return d.changed.length + d.added.length + d.removed.length;
}

/**
 * Diff the working tree against the stored index using one stat per file - no reads, no parsing.
 * That cheapness is the point: it is what lets every query refresh before it answers, so an
 * answer describes the code as it is now (uncommitted edits included) rather than as it was.
 */
export function probeDrift(graph: CodeGraph): CodeGraphDrift {
    const drift: CodeGraphDrift = { changed: [], added: [], removed: [] };
    const onDisk = statSourceFiles(graph.root);
    const indexed = new Map(graph.files.map((f) => [f.path, f]));
    for (const [path, st] of onDisk) {
        const rec = indexed.get(path);
        if (!rec) { drift.added.push(path); continue; }
        if (rec.size !== st.size || rec.mtimeMs !== st.mtimeMs) drift.changed.push(path);
    }
    for (const path of indexed.keys()) if (!onDisk.has(path)) drift.removed.push(path);
    drift.changed.sort();
    drift.added.sort();
    drift.removed.sort();
    return drift;
}

/**
 * The graph as a query should see it: re-indexed first when the tree moved, or when the stored
 * graph predates the current shape. `refresh: false` answers from disk exactly as indexed.
 */
export function loadFreshGraph(project?: string, refresh = true): CodeGraph | null {
    const graph = loadGraph(project);
    if (!graph) return null;
    if (!refresh) return graph;
    if (graph.version !== GRAPH_VERSION || !isCleanDrift(probeDrift(graph))) {
        indexProject(graph.root);
        return loadGraph(graph.id);
    }
    return graph;
}

/** Every node (files and symbols) of a graph, ids assigned exactly as the build assigned them. */
export function graphNodes(graph: CodeGraph): GraphNode[] {
    return mintNodes(graph.files);
}

export interface Architecture {
    project: string;
    languages: Record<string, number>;
    files: number;
    symbols: number;
    importEdges: number;
    entryPoints: string[];
    hotspots: { name: string; refs: number; }[];
    packages: Record<string, number>;
    externalModules: { name: string; count: number; }[];
}

/** Architecture overview for a project (languages, entry points, hotspots, packages, deps). */
export function codeGraphArchitecture(project?: string): Architecture | null {
    const g = loadCompatibleGraph(project);
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

export interface GraphSchema { nodes: Record<string, number>; edges: Record<string, number>; }

/** Node/edge label counts for a project's graph. */
export function codeGraphSchema(project?: string): GraphSchema | null {
    const g = loadCompatibleGraph(project);
    if (!g) return null;
    const nodes: Record<string, number> = { File: g.files.length };
    for (const f of g.files) for (const s of f.symbols) {
        const label = s.kind.charAt(0).toUpperCase() + s.kind.slice(1);
        nodes[label] = (nodes[label] || 0) + 1;
    }
    const edges: Record<string, number> = {};
    for (const [, , rel] of g.edges ?? []) edges[rel.toUpperCase()] = (edges[rel.toUpperCase()] || 0) + 1;
    if (!Object.keys(edges).length) edges.IMPORTS = g.importEdges.length;
    return { nodes, edges };
}

export interface SymbolHit { name: string; kind: SymbolKind; file: string; line: number; }

/** Search a project's symbols by name (regex or substring) and optional kind. */
export function searchGraph(project: string | undefined, opts: { name?: string; kind?: string; limit?: number; } = {}): SymbolHit[] {
    const g = loadCompatibleGraph(project);
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
export function codeGraphStatus(): { enabled: boolean; available: boolean; projects: number; } {
    return { enabled: readConfig().config.codeGraph, available: true, projects: listProjects().length };
}
