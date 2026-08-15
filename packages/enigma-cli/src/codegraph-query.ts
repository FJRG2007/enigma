/**
 * Retrieval over the code graph: the answers an agent actually asks for, rather than a dump of
 * what was indexed.
 *
 * Five surfaces, all deterministic and offline - no model, no key, no network:
 *   - ask       ranked nodes for a task, with exact file:line and optional inlined source
 *   - trace     who depends on a symbol (or what it depends on), N levels deep - blast radius
 *   - skeleton  every signature in one file, no bodies: the API surface for a fraction of the read
 *   - map       repo orientation: directory clusters, per-directory hubs, global hotspots
 *   - grep      exhaustive regex, grouped by enclosing symbol and ranked by how coupled it is
 *
 * Each one refreshes the graph first when the working tree has moved (a stat per file, no reads),
 * so an answer describes the code as it is right now - uncommitted edits included - instead of as
 * it was at the last index. Rendering lives in codegraph-format.ts; this module returns data.
 */

import { join } from "node:path";
import * as cg from "./codegraph";
import { readFileSync } from "node:fs";
import * as rank from "./codegraph-rank";

// --- shared plumbing -----------------------------------------------------------------

/** Every query answers against this: the current graph plus its nodes, minted once. */
interface Loaded { graph: cg.CodeGraph; nodes: cg.GraphNode[]; byId: Map<string, cg.GraphNode>; }

export interface QueryOptions {
    project?: string;
    /** Re-index first when the tree moved. Off answers from the graph exactly as it is on disk. */
    refresh?: boolean;
    /** Narrow to nodes at or under this repo-relative path prefix. */
    in?: string;
}

/** The one message every surface gives when there is nothing indexed to answer from. */
export const NOT_INDEXED = "No project indexed yet. Run: enigma codegraph index";

function load(opts: QueryOptions): Loaded | null {
    const graph = cg.loadFreshGraph(opts.project, opts.refresh ?? true);
    if (!graph) return null;
    const nodes = cg.graphNodes(graph);
    return { graph, nodes, byId: new Map(nodes.map((n) => [n.id, n])) };
}

/** Accept either separator and a trailing slash, so `--in src/`, `src` and `src\a` all agree. */
function normalizePrefix(prefix: string): string {
    return prefix.split("\\").join("/").replace(/\/+$/, "");
}

/** Segment-aware containment: `src` covers `src/a.ts` but never `lib/mysrc/a.ts`. */
function underPrefix(path: string, prefix: string): boolean {
    return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

export interface Savings { files: number; baselineChars: number; }

/** What reading those files whole would have cost - the honest baseline for "tokens saved". */
function savingsFor(nodes: cg.GraphNode[], paths: Iterable<string>): Savings | undefined {
    const sizes = new Map<string, number>();
    for (const n of nodes) if (n.kind === "file" && typeof n.chars === "number") sizes.set(n.path, n.chars);
    let baselineChars = 0;
    let files = 0;
    for (const p of new Set(paths)) {
        const c = sizes.get(p);
        if (c === undefined) continue;
        baselineChars += c;
        files++;
    }
    return files > 0 ? { files, baselineChars } : undefined;
}

/** Read lines [from, to] (1-indexed, inclusive) of a file, capped so one hit cannot flood a pack. */
const MAX_SPAN_LINES = 80;

function sliceSpan(root: string, path: string, from: number, to: number): string | null {
    try {
        const lines = readFileSync(join(root, path), "utf8").split("\n");
        const start = Math.max(1, from);
        const end = Math.min(lines.length, to);
        const slice = lines.slice(start - 1, end);
        if (slice.length > MAX_SPAN_LINES) {
            const head = slice.slice(0, MAX_SPAN_LINES);
            head.push(`... (+${slice.length - MAX_SPAN_LINES} more lines; open ${path}:${start}-${end})`);
            return head.join("\n");
        }
        return slice.join("\n");
    } catch { return null; }
}

// --- symbol resolution ---------------------------------------------------------------

/**
 * Resolve a query string to every node it can name, best interpretation first: a bare or
 * qualified symbol name, then the last dot-segment of a package-qualified name, then a file by
 * path or basename. Multiple matches are not an error - a name can legitimately be defined twice.
 */
export function resolveSymbolNodes(nodes: cg.GraphNode[], query: string, inPrefix?: string): cg.GraphNode[] {
    const lower = query.toLowerCase();
    const suffixHash = `#${lower}`;
    const suffixDot = `.${lower}`;
    const stripOrdinals = (s: string): string => s.replace(/~\d+(?=\.|$)/g, "");

    let matches = nodes.filter((n) => {
        if (n.kind === "file") return false;
        if (n.name.toLowerCase() === lower) return true;
        const id = n.id.toLowerCase();
        const hash = id.indexOf("#");
        const candidate = hash === -1 ? id : id.slice(0, hash + 1) + stripOrdinals(id.slice(hash + 1));
        return candidate.endsWith(suffixHash) || candidate.endsWith(suffixDot);
    });

    if (!matches.length && query.includes(".")) {
        const last = query.slice(query.lastIndexOf(".") + 1).toLowerCase();
        if (last) matches = nodes.filter((n) => n.kind !== "file" && n.name.toLowerCase() === last);
    }
    if (!matches.length && query.includes(".") && !query.includes("#")) {
        matches = nodes.filter((n) => n.kind === "file" && (n.path.toLowerCase() === lower || n.path.toLowerCase().endsWith(`/${lower}`)));
    }
    if (inPrefix !== undefined) matches = matches.filter((n) => underPrefix(n.path, inPrefix));
    return matches;
}

// --- ask -----------------------------------------------------------------------------

export interface AskHit {
    kind: "symbol" | "caller" | "callee";
    name: string;
    symbolKind: string;
    path: string;
    line: number;
    endLine: number;
    signature: string;
    score: number;
    relation?: cg.EdgeRelation;
    /** Present when `source` was requested and the span could be read. */
    code?: string;
}

export interface AskResult {
    query: string;
    mode: "structural" | "lexical" | "empty";
    subject?: string;
    hits: AskHit[];
    note?: string;
    /** IDF-weighted share of the query the top hit matched: how much of the ask was understood. */
    coverage?: number;
    saved?: Savings;
}

/** A question about wiring ("who calls X") is answered from edges, never from word overlap. */
const INCOMING = /\b(caller|callers|calls?\s+into|who\s+calls|what\s+calls|called\s+by|used\s+by|uses)\b/i;
const OUTGOING = /\b(callee|callees|calls\s+what|imports?|depends\s+on)\b/i;
const INCOMING_RELS: cg.EdgeRelation[] = ["calls", "references", "implements", "extends"];
const OUTGOING_RELS: cg.EdgeRelation[] = ["calls", "references", "imports", "implements", "extends"];

/** How much graph centrality (0..1) can lift a blended score above its lexical share. */
const GRAPH_WEIGHT = 0.5;

/** A node the query never word-matched joins the results only at this share of the top mass. */
const RESCUE_FLOOR = 0.15;

/** Tests stay findable but rank below the definition they exercise, unless the query wants them. */
const TEST_PENALTY = 0.35;

function toHit(n: cg.GraphNode, score: number, relation?: cg.EdgeRelation): AskHit {
    return {
        kind: relation ? (relation === "imports" ? "callee" : "symbol") : "symbol",
        name: n.name, symbolKind: n.kind, path: n.path, line: n.line, endLine: n.endLine,
        signature: n.signature, score, relation,
    };
}

/** Longest identifier-shaped word first: the subject of "who calls X" is X, never the verb. */
function findSubject(query: string, nodes: cg.GraphNode[], inPrefix?: string): { subject: cg.GraphNode[]; tried: string; } {
    const words = [...new Set(query.split(/[^A-Za-z0-9_.]+/).filter(Boolean))].sort((a, b) => b.length - a.length);
    for (const w of words) {
        const hits = resolveSymbolNodes(nodes, w, inPrefix);
        if (hits.length) return { subject: hits, tried: w };
    }
    return { subject: [], tried: words[0] ?? query };
}

function structuralAsk(query: string, loaded: Loaded, limit: number, inPrefix?: string): AskResult | { fallthrough: string; } | null {
    const wantsIn = INCOMING.test(query);
    const wantsOut = OUTGOING.test(query);
    if (!wantsIn && !wantsOut) return null;

    const { subject, tried } = findSubject(query, loaded.nodes, inPrefix);
    const nudge = (name: string): string => `No indexed edges for '${name}'. Showing word matches instead; for exact edges try: enigma codegraph callers ${name}`;
    if (!subject.length) return { fallthrough: nudge(tried) };

    const ids = new Set(subject.map((n) => n.id));
    const outgoing = wantsOut && !wantsIn;
    const rels = new Set(outgoing ? OUTGOING_RELS : INCOMING_RELS);
    const hits: AskHit[] = [];
    const seen = new Set<string>();
    for (const [source, target, rel] of loaded.graph.edges) {
        if (!rels.has(rel)) continue;
        const anchor = outgoing ? source : target;
        const other = outgoing ? target : source;
        if (!ids.has(anchor) || seen.has(other + rel)) continue;
        seen.add(other + rel);
        const node = loaded.byId.get(other);
        if (!node) continue;
        if (inPrefix !== undefined && !underPrefix(node.path, inPrefix)) continue;
        hits.push({ ...toHit(node, 1, rel), kind: outgoing ? "callee" : "caller" });
    }
    if (!hits.length) return { fallthrough: nudge(subject[0].name) };

    hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return {
        query,
        mode: "structural",
        subject: subject[0].name,
        hits: hits.slice(0, limit),
        note: outgoing ? `outgoing edges from ${subject[0].name}` : `callers and references of ${subject[0].name}`,
    };
}

function lexicalAsk(query: string, loaded: Loaded, limit: number, inPrefix?: string): AskResult {
    // Binary query terms: a word repeated in a pasted issue body counts once, so a long rant
    // cannot linearly amplify one incidental word.
    const q = new Map([...rank.counts(rank.tokenize(query)).keys()].map((t) => [t, 1]));
    const bodies = cg.loadBodyIndex(loaded.graph.id);
    const wantsTests = /\b(tests?|specs?|coverage|assert(?:ion)?s?|fixtures?|mocks?)\b/i.test(query);
    const testFactor = (path: string): number => (!wantsTests && rank.isTestPath(path) ? TEST_PENALTY : 1);

    const nodes = inPrefix === undefined ? loaded.nodes : loaded.nodes.filter((n) => underPrefix(n.path, inPrefix));
    const docs = nodes.map((n) => ({
        n,
        name: rank.counts(rank.tokenize(n.name)),
        path: rank.counts(rank.tokenize(n.path)),
        body: mergeBags(rank.counts(rank.tokenize(n.signature)), bodies.get(n.id)),
    }));
    if (!docs.length) return { query, mode: "empty", hits: [], note: NOT_INDEXED };

    const idf = rank.computeIdf(docs.map((d) => new Set([...d.name.keys(), ...d.path.keys(), ...d.body.keys()])));
    const defaultIdf = Math.log(1 + docs.length);
    const avgBody = docs.reduce((a, d) => a + rank.bagLength(d.body), 0) / docs.length;

    const lex = new Map<string, number>();
    let maxLex = 0;
    for (const { n, name, path, body } of docs) {
        // Name and path are short identifiers, so plain IDF-weighted overlap fits; the body is
        // length-normalized through BM25 so a long definition cannot win on bulk alone.
        const total = (rank.overlapScore(q, name, idf) * 3 + rank.overlapScore(q, path, idf) * 2 + rank.bm25(q, body, idf, rank.bagLength(body), avgBody)) * testFactor(n.path);
        if (total > 0) { lex.set(n.id, total); maxLex = Math.max(maxLex, total); }
    }

    const allowed = inPrefix === undefined ? undefined : (id: string): boolean => underPrefix(loaded.byId.get(id)?.path ?? "", inPrefix);
    const pr = lex.size ? rank.personalizedPageRank(nodes.map((n) => n.id), loaded.graph.edges, lex, { nodeFilter: allowed }) : new Map<string, number>();

    const candidates = new Set(lex.keys());
    for (const [id, p] of pr) if (p >= RESCUE_FLOOR) candidates.add(id);

    const docById = new Map(docs.map((d) => [d.n.id, d]));
    const hits: AskHit[] = [];
    const coverageOf = new Map<AskHit, number>();
    for (const id of candidates) {
        const n = loaded.byId.get(id);
        if (!n) continue;
        const lexN = maxLex > 0 ? (lex.get(id) ?? 0) / maxLex : 0;
        // The penalty is applied after normalization too: if a test is the strongest raw match,
        // dividing by maxLex would otherwise restore it to 1.0 and erase the de-rank.
        const blended = (lexN + GRAPH_WEIGHT * (pr.get(id) ?? 0)) * testFactor(n.path);
        if (blended <= 0) continue;
        const hit = toHit(n, blended);
        const d = docById.get(id);
        coverageOf.set(hit, d ? rank.matchedShare(q, [d.name, d.path, d.body], idf, defaultIdf) : 0);
        hits.push(hit);
    }

    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
    const top = hits.slice(0, limit);
    return {
        query,
        mode: hits.length ? "lexical" : "empty",
        hits: top,
        coverage: hits.length && q.size ? coverageOf.get(hits[0]) : undefined,
        note: hits.length ? undefined : "No matching nodes. Try different words, or re-index: enigma codegraph index",
    };
}

/** Signature tokens plus the indexed body vocabulary - one bag, summed where they overlap. */
function mergeBags(a: Map<string, number>, b?: Map<string, number>): Map<string, number> {
    if (!b) return a;
    const out = new Map(a);
    for (const [t, c] of b) out.set(t, (out.get(t) ?? 0) + c);
    return out;
}

export interface AskOptions extends QueryOptions {
    limit?: number;
    /** Inline the source at each hit, so the agent does not have to reopen the file. */
    source?: boolean;
}

/** Answer a task-shaped question from the graph: ranked nodes with exact locations. */
export function codeGraphAsk(query: string, opts: AskOptions = {}): AskResult | null {
    const loaded = load(opts);
    if (!loaded) return null;
    const limit = opts.limit ?? 8;
    const inPrefix = opts.in === undefined ? undefined : normalizePrefix(opts.in);

    const structural = structuralAsk(query, loaded, limit, inPrefix);
    let result: AskResult;
    if (structural && "hits" in structural) {
        result = structural;
    } else {
        result = lexicalAsk(query, loaded, limit, inPrefix);
        // A wiring question that could not be answered from wiring still says so out loud, rather
        // than quietly handing back word matches as if they were the edges that were asked for.
        if (structural) result.note = result.note ? `${structural.fallthrough}\n${result.note}` : structural.fallthrough;
    }

    if (opts.source) {
        for (const h of result.hits) {
            const code = sliceSpan(loaded.graph.root, h.path, h.line, h.endLine);
            if (code) h.code = code;
        }
        // The result substitutes for reading the files only in this mode, so the estimate is only
        // claimed here.
        result.saved = savingsFor(loaded.nodes, result.hits.map((h) => h.path));
    }
    return result;
}

// --- trace (callers / blast radius) --------------------------------------------------

export type Direction = "in" | "out";

export interface TraceHit {
    id: string;
    name: string;
    kind: string;
    path: string;
    line: number;
    relation: cg.EdgeRelation;
    depth: number;
}

export interface TraceResult {
    symbol: string;
    direction: Direction;
    depth: number;
    /** Every node the query resolved to - a name defined twice traces from both. */
    matched: { name: string; path: string; line: number; }[];
    hits: TraceHit[];
    note?: string;
}

/** Adjacency for one walk direction: `in` = who points at the key, `out` = what the key points to. */
function adjacency(edges: cg.CodeEdge[], direction: Direction): Map<string, { other: string; relation: cg.EdgeRelation; }[]> {
    const adj = new Map<string, { other: string; relation: cg.EdgeRelation; }[]>();
    for (const [source, target, rel] of edges) {
        if (!cg.WALK_RELATIONS.has(rel)) continue;
        const key = direction === "in" ? target : source;
        const other = direction === "in" ? source : target;
        const entry = { other, relation: rel };
        const arr = adj.get(key);
        if (arr) arr.push(entry);
        else adj.set(key, [entry]);
    }
    return adj;
}

export interface TraceOptions extends QueryOptions {
    direction?: Direction;
    depth?: number;
}

/**
 * Who depends on a symbol, or what it depends on, N levels out - the blast radius of a change.
 *
 * A file seed also walks every symbol it defines: a call from another file targets the SYMBOL,
 * never the file, so seeding the file alone would silently miss the dependents that matter most.
 * Each reached node is reported once, at the depth it was first reached from any seed.
 */
export function codeGraphTrace(symbol: string, opts: TraceOptions = {}): TraceResult | null {
    const loaded = load(opts);
    if (!loaded) return null;
    const direction = opts.direction ?? "in";
    const depth = Math.max(1, opts.depth ?? 1);
    const inPrefix = opts.in === undefined ? undefined : normalizePrefix(opts.in);

    const matches = resolveSymbolNodes(loaded.nodes, symbol, inPrefix);
    if (!matches.length) {
        return { symbol, direction, depth, matched: [], hits: [], note: `No symbol named '${symbol}' in the graph. Try: enigma codegraph search ${symbol}` };
    }

    const seeds = [...matches];
    for (const m of matches) {
        if (m.kind !== "file") continue;
        for (const n of loaded.nodes) if (n.kind !== "file" && n.path === m.path) seeds.push(n);
    }

    const adj = adjacency(loaded.graph.edges, direction);
    const visited = new Set(seeds.map((s) => s.id));
    const hits: TraceHit[] = [];
    let frontier = [...visited];
    for (let d = 1; d <= depth && frontier.length; d++) {
        const next: string[] = [];
        for (const current of frontier) {
            for (const { other, relation } of adj.get(current) ?? []) {
                if (visited.has(other)) continue;
                visited.add(other);
                const node = loaded.byId.get(other);
                if (!node) continue;
                if (inPrefix !== undefined && !underPrefix(node.path, inPrefix)) continue;
                hits.push({ id: other, name: node.name, kind: node.kind, path: node.path, line: node.line, relation, depth: d });
                next.push(other);
            }
        }
        frontier = next;
    }

    hits.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path) || a.line - b.line);
    return {
        symbol, direction, depth,
        matched: matches.map((m) => ({ name: m.name, path: m.path, line: m.line })),
        hits,
        note: hits.length ? undefined : `'${symbol}' resolved, but the graph has no ${direction === "in" ? "inbound" : "outbound"} edges for it.`,
    };
}

// --- skeleton ------------------------------------------------------------------------

export interface SkeletonEntry { name: string; kind: string; line: number; endLine: number; signature: string; }

export interface SkeletonResult { file: string; entries: SkeletonEntry[]; note?: string; saved?: Savings; }

/** Every signature in one file and no bodies: the API surface at a fraction of reading it. */
export function codeGraphSkeleton(file: string, opts: QueryOptions = {}): SkeletonResult | null {
    const loaded = load(opts);
    if (!loaded) return null;
    const want = normalizePrefix(file);

    let defs = loaded.nodes.filter((n) => n.kind !== "file" && n.path === want);
    if (!defs.length) {
        const paths = new Set(loaded.nodes.filter((n) => n.path === want || n.path.endsWith(`/${want}`)).map((n) => n.path));
        if (paths.size > 1) return { file: want, entries: [], note: `Ambiguous. Matches: ${[...paths].sort().join(", ")}` };
        const [path] = paths;
        if (path) defs = loaded.nodes.filter((n) => n.kind !== "file" && n.path === path);
    }
    if (!defs.length) return { file: want, entries: [], note: "No definitions indexed for this file." };

    defs.sort((a, b) => a.line - b.line);
    return {
        file: defs[0].path,
        entries: defs.map((n) => ({ name: n.name, kind: n.kind, line: n.line, endLine: n.endLine, signature: n.signature })),
        saved: savingsFor(loaded.nodes, [defs[0].path]),
    };
}

// --- map -----------------------------------------------------------------------------

export interface Hub { name: string; kind: string; path: string; line: number; inDegree: number; }

export interface DirEntry {
    path: string;
    files: number;
    symbols: number;
    languages: string[];
    hubs: Hub[];
    /** True when the split refinement bottomed out on a file sitting directly in the split
     * directory, so `path` is that file's own path and must not be rendered with a trailing "/". */
    isFile: boolean;
}

export interface RepoMap {
    totals: { files: number; symbols: number; edges: number; languages: string[]; };
    dirs: DirEntry[];
    hotspots: Hub[];
    /** Directory groups beyond the cap - counted, never silently dropped. */
    dropped: number;
    saved?: Savings;
}

const DEFAULT_MAX_DIRS = 16;
const DEFAULT_HUBS_PER_DIR = 3;
const DEFAULT_HOTSPOTS = 12;

/** One group holding more than this share of the repo is useless for orientation, so it is split. */
const SPLIT_THRESHOLD = 0.6;

function dirKey(path: string, depth: number): string {
    const segments = path.split("/");
    return segments.slice(0, Math.min(depth, segments.length)).join("/");
}

function topHubs(nodes: cg.GraphNode[], deg: Map<string, number>, cap: number): Hub[] {
    return nodes
        .map((n) => ({ name: n.name, kind: n.kind, path: n.path, line: n.line, inDegree: deg.get(n.id) ?? 0 }))
        .filter((h) => h.inDegree > 0)
        .sort((a, b) => b.inDegree - a.inDegree || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
        .slice(0, cap);
}

export interface MapOptions extends QueryOptions { maxDirs?: number; }

/**
 * A first look at an unfamiliar repo: directory clusters with their local hubs, and the global
 * hotspots. Ranked by inbound dependency edges - the same "important" every other surface uses -
 * never by line count, which drifts from what the code actually depends on.
 */
export function codeGraphMap(opts: MapOptions = {}): RepoMap | null {
    const loaded = load(opts);
    if (!loaded) return null;
    const maxDirs = opts.maxDirs ?? DEFAULT_MAX_DIRS;
    const inPrefix = opts.in === undefined ? undefined : normalizePrefix(opts.in);
    const nodes = inPrefix === undefined ? loaded.nodes : loaded.nodes.filter((n) => underPrefix(n.path, inPrefix));
    const deg = rank.inDegree(loaded.graph.edges, true);

    const fileNodes = nodes.filter((n) => n.kind === "file");
    const langByPath = new Map(loaded.graph.files.map((f) => [f.path, f.lang]));

    // One refinement pass: when a single top-level segment swallows most of the repo, split it a
    // level deeper so the map still says something. Two groups cannot both exceed 60% of a total.
    const depth1 = new Map<string, number>();
    for (const n of fileNodes) depth1.set(dirKey(n.path, 1), (depth1.get(dirKey(n.path, 1)) ?? 0) + 1);
    let splitSegment: string | null = null;
    for (const [seg, count] of depth1) {
        if (!fileNodes.length || count / fileNodes.length <= SPLIT_THRESHOLD) continue;
        // Only split where there is something to split into. A flat directory of files has no
        // subdirectories, so refining it produces one group per file - a file listing wearing a
        // repo map's clothes, which is worse than the single honest group it replaced.
        const subdirs = new Set(fileNodes
            .filter((n) => dirKey(n.path, 1) === seg && n.path.split("/").length > 2)
            .map((n) => dirKey(n.path, 2)));
        if (subdirs.size >= 2) splitSegment = seg;
        break;
    }

    const groups = new Map<string, { files: cg.GraphNode[]; symbols: cg.GraphNode[]; }>();
    for (const n of nodes) {
        const key = dirKey(n.path, splitSegment !== null && dirKey(n.path, 1) === splitSegment ? 2 : 1);
        let g = groups.get(key);
        if (!g) { g = { files: [], symbols: [] }; groups.set(key, g); }
        if (n.kind === "file") g.files.push(n);
        else g.symbols.push(n);
    }

    const filePaths = new Set(fileNodes.map((f) => f.path));
    const dirs = [...groups.entries()]
        .map(([path, g]) => ({
            path,
            files: g.files.length,
            symbols: g.symbols.length,
            languages: [...new Set(g.files.map((f) => langByPath.get(f.path)).filter((l): l is string => !!l))].sort(),
            hubs: topHubs(g.symbols, deg, DEFAULT_HUBS_PER_DIR),
            isFile: filePaths.has(path),
        }))
        .sort((a, b) => b.symbols - a.symbols || a.path.localeCompare(b.path));

    const symbols = nodes.filter((n) => n.kind !== "file");
    return {
        totals: {
            files: fileNodes.length,
            symbols: symbols.length,
            edges: loaded.graph.edges.length,
            languages: [...new Set(fileNodes.map((f) => langByPath.get(f.path)).filter((l): l is string => !!l))].sort(),
        },
        dirs: dirs.slice(0, maxDirs),
        hotspots: topHubs(symbols, deg, DEFAULT_HOTSPOTS),
        dropped: Math.max(0, dirs.length - maxDirs),
        saved: savingsFor(loaded.nodes, fileNodes.map((f) => f.path)),
    };
}

// --- grep ----------------------------------------------------------------------------

export interface GrepHit { line: number; text: string; }

export interface GrepGroup {
    /** null when the hit lies outside every indexed symbol: module-level code. */
    symbol: { name: string; kind: string; line: number; endLine: number; } | null;
    path: string;
    inDegree: number;
    hits: GrepHit[];
}

export interface GrepResult {
    pattern: string;
    filesSearched: number;
    totalHits: number;
    groups: GrepGroup[];
    /** Never silent: files that could not be read, and matches found past the cap. */
    truncated: { files: number; hits: number; };
    saved?: Savings;
}

const DEFAULT_MAX_HITS = 300;
const MAX_HIT_TEXT = 160;

export interface GrepOptions extends QueryOptions {
    ignoreCase?: boolean;
    /** Treat the pattern as a literal string rather than a regex. */
    fixed?: boolean;
    maxHits?: number;
}

/**
 * Exhaustive regex over the indexed files, with every hit attributed to the symbol that encloses
 * it and groups ranked by how depended-upon that symbol is - which is the part plain grep cannot
 * do: it gives no way to tell a hit inside a heavily-used function from one inside dead code.
 */
export function codeGraphGrep(pattern: string, opts: GrepOptions = {}): GrepResult | null {
    const loaded = load(opts);
    if (!loaded) return null;
    const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
    const source = opts.fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    const regex = new RegExp(source, opts.ignoreCase ? "i" : "");
    const inPrefix = opts.in === undefined ? undefined : normalizePrefix(opts.in);
    const deg = rank.inDegree(loaded.graph.edges, true);

    const spansByFile = new Map<string, cg.GraphNode[]>();
    for (const n of loaded.nodes) {
        if (n.kind === "file") continue;
        const arr = spansByFile.get(n.path);
        if (arr) arr.push(n);
        else spansByFile.set(n.path, [n]);
    }
    for (const arr of spansByFile.values()) arr.sort((a, b) => a.line - b.line);

    const files = loaded.nodes.filter((n) => n.kind === "file" && (inPrefix === undefined || underPrefix(n.path, inPrefix)));
    const groups = new Map<string, GrepGroup>();
    let collected = 0;
    let truncatedHits = 0;
    let truncatedFiles = 0;

    for (const file of files) {
        let text: string;
        try { text = readFileSync(join(loaded.graph.root, file.path), "utf8"); } catch { truncatedFiles++; continue; }
        const spans = spansByFile.get(file.path) ?? [];
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (!regex.test(lines[i])) continue;
            if (collected >= maxHits) { truncatedHits++; continue; }
            collected++;
            const lineNo = i + 1;
            let sym: cg.GraphNode | null = null;
            for (const s of spans) {
                if (s.line > lineNo) break;
                if (lineNo <= s.endLine) sym = s;
            }
            const key = sym ? sym.id : `file:${file.path}`;
            let group = groups.get(key);
            if (!group) {
                group = {
                    symbol: sym ? { name: sym.name, kind: sym.kind, line: sym.line, endLine: sym.endLine } : null,
                    path: file.path,
                    inDegree: sym ? (deg.get(sym.id) ?? 0) : 0,
                    hits: [],
                };
                groups.set(key, group);
            }
            const trimmed = lines[i].trim();
            group.hits.push({ line: lineNo, text: trimmed.length > MAX_HIT_TEXT ? trimmed.slice(0, MAX_HIT_TEXT) : trimmed });
        }
    }

    const sorted = [...groups.values()].sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path) || (a.symbol?.line ?? 0) - (b.symbol?.line ?? 0));
    return {
        pattern,
        filesSearched: files.length,
        totalHits: collected,
        groups: sorted,
        truncated: { files: truncatedFiles, hits: truncatedHits },
        saved: savingsFor(loaded.nodes, sorted.map((g) => g.path)),
    };
}

// --- freshness -----------------------------------------------------------------------

export interface FreshnessResult { project: string; root: string; indexedAt: number; drift: cg.CodeGraphDrift; stale: number; }

/** Whether the graph still describes the code. Reports drift; never repairs it - that is `index`. */
export function codeGraphCheck(project?: string): FreshnessResult | null {
    const graph = cg.loadFreshGraph(project, false);
    if (!graph) return null;
    const drift = cg.probeDrift(graph);
    return { project: graph.name, root: graph.root, indexedAt: graph.indexedAt, drift, stale: cg.driftCount(drift) };
}

export { isCleanDrift } from "./codegraph";
