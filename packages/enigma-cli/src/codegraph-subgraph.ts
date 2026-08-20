/**
 * A renderable slice of the code graph: the shape every other retrieval surface answers ABOUT,
 * returned as nodes and edges instead of prose.
 *
 * The stored graph is far too large to draw whole - a mid-size monorepo indexes tens of thousands
 * of symbols and edges - so a slice is always seeded and capped, never dumped. Two seedings cover
 * what people actually look at:
 *   - no focus: the repo at a glance, either its import graph (`scope: "files"`) or the symbols
 *     the rest of the codebase depends on (`scope: "symbols"`), ranked by cross-file in-degree.
 *   - a focus:  everything within N hops of one symbol or file, both directions at once, which is
 *     the picture `trace` gives one direction of at a time.
 *
 * Edges are INDUCED: once the node set is fixed, every stored edge with both ends inside it is
 * returned. Carrying only the edges the walk happened to traverse would draw a tree of a graph and
 * hide exactly the cross-links the picture exists to show.
 *
 * Deterministic and offline like the rest of the engine. Rendering (DOT, text, the dashboard
 * canvas) reads this; it renders nothing itself.
 */

import * as cg from "./codegraph";
import * as rank from "./codegraph-rank";
import { resolveSymbolNodes, type QueryOptions } from "./codegraph-query";

/** Slices bigger than this stop being readable and start being a hairball; also the payload cap. */
const MAX_LIMIT = 2000;

const DEFAULT_LIMIT = 300;

const DEFAULT_DEPTH = 1;

/** Beyond this the walk reaches most of the repo from any seed, which is not a neighbourhood. */
const MAX_DEPTH = 4;

export type SubgraphScope = "symbols" | "files";

export interface SubgraphNode {
    id: string;
    name: string;
    kind: string;
    path: string;
    line: number;
    endLine: number;
    signature: string;
    /** How many OTHER files depend on it - the same "important" map, ask and grep rank by. */
    inDegree: number;
    /** Hops from the nearest seed; 0 marks a seed itself. */
    depth: number;
    /** Neighbours left outside this slice, so a viewer can say what expanding would add. */
    hidden: number;
}

export interface SubgraphEdge {
    source: string;
    target: string;
    relation: cg.EdgeRelation;
}

export interface SubgraphResult {
    project: string;
    root: string;
    scope: SubgraphScope;
    depth: number;
    /** Every node the focus resolved to, or null when the slice is an unfocused overview. */
    focus: { id: string; name: string; path: string; line: number; }[] | null;
    nodes: SubgraphNode[];
    edges: SubgraphEdge[];
    /** The whole graph behind the slice, so the view can state what share of it is on screen. */
    totals: { files: number; symbols: number; edges: number; };
    /** The cap left reachable nodes out - stated, so a slice is never mistaken for the whole. */
    truncated: boolean;
    /** The INDEX does not cover the whole tree (the scan hit a limit), which the slice inherits. */
    incomplete: boolean;
    note?: string;
}

export interface SubgraphOptions extends QueryOptions {
    /** A symbol name or file path to centre on. Omitted, the slice is a ranked overview. */
    focus?: string;
    /** Hops walked out from the seeds, both directions. */
    depth?: number;
    /** Hard cap on returned nodes. */
    limit?: number;
    scope?: SubgraphScope;
}

/** Accept either separator and a trailing slash, so `--in src/`, `src` and `src\a` all agree. */
function normalizePrefix(prefix: string): string {
    return prefix.split("\\").join("/").replace(/\/+$/, "");
}

/** Segment-aware containment: `src` covers `src/a.ts` but never `lib/mysrc/a.ts`. */
function underPrefix(path: string, prefix: string): boolean {
    return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** Undirected adjacency over dependency edges - a neighbourhood is not a direction. */
function undirectedAdjacency(edges: cg.CodeEdge[]): Map<string, string[]> {
    const adj = new Map<string, string[]>();
    const push = (key: string, other: string): void => {
        const arr = adj.get(key);
        if (arr) arr.push(other);
        else adj.set(key, [other]);
    };
    for (const [source, target, rel] of edges) {
        if (!cg.WALK_RELATIONS.has(rel)) continue;
        push(source, target);
        push(target, source);
    }
    return adj;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * A slice of the graph, seeded and capped, ready to draw.
 *
 * Returns null when nothing is indexed. A focus that resolves to nothing still returns a result -
 * an empty one carrying the reason - because "that name is not in the graph" is an answer, and
 * silently drawing the overview instead would answer a question nobody asked.
 */
export function codeGraphSubgraph(opts: SubgraphOptions = {}): SubgraphResult | null {
    const graph = cg.loadFreshGraph(opts.project, opts.refresh ?? true);
    if (!graph) return null;
    const nodes = cg.graphNodes(graph);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const scope: SubgraphScope = opts.scope === "files" ? "files" : "symbols";
    const depth = clamp(opts.depth, DEFAULT_DEPTH, 1, MAX_DEPTH);
    const limit = clamp(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const inPrefix = opts.in === undefined ? undefined : normalizePrefix(opts.in);
    const visible = (n: cg.GraphNode): boolean => inPrefix === undefined || underPrefix(n.path, inPrefix);

    // The file/import graph is its own edge list: import edges carry file paths, not node ids, so
    // it is built directly rather than walked out of `edges` like the symbol slice below.
    // A file node's id IS its repo-relative path, so an import edge is already a pair of node ids.
    const edgePool: cg.CodeEdge[] = scope === "files" && !opts.focus
        ? graph.importEdges.map(([from, to]) => [from, to, "imports"] as cg.CodeEdge)
        : graph.edges;

    const degree = rank.inDegree(graph.edges, true);
    const totals = {
        files: graph.files.length,
        symbols: graph.files.reduce((n, f) => n + f.symbols.length, 0),
        edges: graph.edges.length,
    };
    const base = {
        project: graph.name,
        root: graph.root,
        scope,
        depth,
        totals,
        incomplete: graph.truncated === true,
    };

    let seeds: cg.GraphNode[] = [];
    let focus: SubgraphResult["focus"] = null;

    if (opts.focus && opts.focus.trim()) {
        const query = opts.focus.trim();
        // An exact node id is the most precise name a node has, and it is what a viewer expanding
        // a node already holds - resolving it by name instead would re-run the ambiguity the id
        // exists to settle, and centre on a same-named symbol in another file.
        const exact = byId.get(query);
        const matches = exact ? [exact] : resolveSymbolNodes(nodes, query, inPrefix);
        if (!matches.length) {
            return {
                ...base, focus: [], nodes: [], edges: [], truncated: false,
                note: `No symbol or file named '${query}' in the graph. Try: enigma codegraph search ${query}`,
            };
        }
        // A file seed also carries the symbols it defines: a call from another file targets the
        // SYMBOL, never the file, so seeding the file alone draws an island. Same rule as `trace`.
        seeds = [...matches];
        for (const m of matches) {
            if (m.kind !== "file") continue;
            for (const n of nodes) if (n.kind !== "file" && n.path === m.path) seeds.push(n);
        }
        focus = matches.map((m) => ({ id: m.id, name: m.name, path: m.path, line: m.line }));
    } else if (scope === "files") {
        const importDegree = new Map<string, number>();
        for (const [, to] of graph.importEdges) importDegree.set(to, (importDegree.get(to) ?? 0) + 1);
        seeds = nodes
            .filter((n) => n.kind === "file" && visible(n))
            .sort((a, b) => (importDegree.get(b.path) ?? 0) - (importDegree.get(a.path) ?? 0) || a.path.localeCompare(b.path))
            .slice(0, limit);
    } else {
        // The symbols the most other files depend on: the same ranking `map` puts at the top, so
        // the picture opens on the same code every other surface calls important.
        seeds = nodes
            .filter((n) => n.kind !== "file" && visible(n) && (degree.get(n.id) ?? 0) > 0)
            .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name))
            .slice(0, Math.max(1, Math.ceil(limit / 3)));
    }

    const adj = undirectedAdjacency(edgePool);
    const depthOf = new Map<string, number>();
    for (const s of seeds) if (visible(s) && byId.has(s.id)) depthOf.set(s.id, 0);
    // An unfocused overview is already the ranked answer; walking it out would drown the hubs in
    // the callers that made them hubs. A focused slice is the one that wants its neighbourhood.
    const walkDepth = focus ? depth : (scope === "files" ? depth : 1);

    let truncated = false;
    let frontier = [...depthOf.keys()];
    for (let d = 1; d <= walkDepth && frontier.length; d++) {
        // Ranked before the cap bites, so what survives is what the rest of the codebase depends
        // on rather than whatever the edge list happened to list first.
        const next = [...new Set(frontier.flatMap((id) => adj.get(id) ?? []))]
            .filter((id) => !depthOf.has(id) && byId.has(id) && visible(byId.get(id)!))
            .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b));
        const room = Math.max(0, limit - depthOf.size);
        if (next.length > room) truncated = true;
        const taken = next.slice(0, room);
        for (const id of taken) depthOf.set(id, d);
        if (depthOf.size >= limit) break;
        frontier = taken;
    }

    const kept = new Set(depthOf.keys());
    const outEdges: SubgraphEdge[] = [];
    const hidden = new Map<string, number>();
    const bump = (id: string): void => { hidden.set(id, (hidden.get(id) ?? 0) + 1); };
    for (const [source, target, relation] of edgePool) {
        const hasSource = kept.has(source);
        const hasTarget = kept.has(target);
        if (hasSource && hasTarget) { outEdges.push({ source, target, relation }); continue; }
        // Counted, not drawn: the node stays honest about how much it is standing in front of.
        if (hasSource && byId.has(target)) bump(source);
        else if (hasTarget && byId.has(source)) bump(target);
    }

    const outNodes: SubgraphNode[] = [...kept].map((id) => {
        const n = byId.get(id)!;
        return {
            id, name: n.name, kind: n.kind, path: n.path, line: n.line, endLine: n.endLine,
            signature: n.signature, inDegree: degree.get(id) ?? 0,
            depth: depthOf.get(id) ?? 0, hidden: hidden.get(id) ?? 0,
        };
    }).sort((a, b) => a.depth - b.depth || b.inDegree - a.inDegree || a.path.localeCompare(b.path) || a.line - b.line);

    return {
        ...base, focus, nodes: outNodes, edges: outEdges, truncated,
        note: outNodes.length ? undefined : "The graph has no dependency edges to draw yet.",
    };
}

/** Quote a DOT identifier: backslashes first, or an escaped quote becomes an escaped backslash. */
function dotQuote(value: string): string {
    return `"${value.split("\\").join("\\\\").split("\"").join("\\\"")}"`;
}

/**
 * The slice as Graphviz DOT, so it can be rendered anywhere the dashboard is not - a PNG in a
 * review, an SVG in a doc, `dot -Tsvg` in CI. The label carries `name` plus `path:line` because a
 * bare name is ambiguous in every repo that defines `run` twice.
 */
export function subgraphToDot(r: SubgraphResult): string {
    const lines = [
        `digraph ${dotQuote(r.project)} {`,
        "    graph [rankdir=LR, bgcolor=\"transparent\", fontname=\"monospace\"];",
        "    node [shape=box, style=rounded, fontname=\"monospace\", fontsize=10];",
        "    edge [fontname=\"monospace\", fontsize=8, color=\"#8a93a3\"];",
    ];
    for (const n of r.nodes) {
        const label = n.kind === "file" ? n.path : `${n.name}\\n${n.path}:${n.line}`;
        lines.push(`    ${dotQuote(n.id)} [label=${dotQuote(label)}, tooltip=${dotQuote(n.signature || n.name)}];`);
    }
    for (const e of r.edges) lines.push(`    ${dotQuote(e.source)} -> ${dotQuote(e.target)} [label=${dotQuote(e.relation)}];`);
    lines.push("}");
    return lines.join("\n");
}
