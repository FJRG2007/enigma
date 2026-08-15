/**
 * Ranking primitives for code-graph retrieval: tokenization, IDF, BM25 and personalized PageRank.
 *
 * The reason this layer exists is that pure keyword overlap ranks code badly. A node that merely
 * shares a word with the query can outrank the node the query is actually about, purely on word
 * count. The graph knows better: the right node is the one wired into the cluster of code the
 * query touches. So lexical scoring proposes, and a random-walk-with-restart over the wiring
 * graph disposes - mass concentrates on nodes edge-connected to the matched set, while a
 * lexically-matched but structurally isolated collision keeps only its own restart mass and sinks.
 *
 * Deterministic and dependency-free: no embeddings, no index to keep warm, same input -> same
 * output. Pure functions only, so every one of them is testable against a hand-built fixture.
 */

import { WALK_RELATIONS, type CodeEdge } from "./codegraph-types";

/** Words carrying no discriminating power in a code query - dropped before scoring. */
const STOP = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to", "in", "on", "at",
    "by", "with", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this",
    "that", "these", "those", "there", "here", "how", "what", "when", "where", "which", "who",
    "why", "do", "does", "did", "can", "could", "should", "would", "will", "not", "no", "we", "you",
    "i", "my", "our", "your", "me", "us", "get", "set", "new", "all", "any", "some", "into", "out",
]);

/** Split text into scoring tokens: camelCase and snake_case both fall apart into their words. */
export function tokenize(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Term-frequency count map. */
export function counts(tokens: string[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
}

/**
 * Inverse document frequency over the scored corpus: `log(1 + N/(1+df))`. Monotonically
 * decreasing in df, always positive, and near-zero for a token that appears in every document -
 * which is what stops a word common to the whole codebase from deciding the ranking.
 */
export function computeIdf(bags: Array<Set<string>>): Map<string, number> {
    const df = new Map<string, number>();
    for (const bag of bags) for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
    const idf = new Map<string, number>();
    for (const [t, d] of df) idf.set(t, Math.log(1 + bags.length / (1 + d)));
    return idf;
}

/** Plain IDF-weighted term overlap - the right scorer for short fields (a name, a path). */
export function overlapScore(query: Map<string, number>, doc: Map<string, number>, idf: Map<string, number>): number {
    let s = 0;
    for (const [t, qn] of query) {
        const dn = doc.get(t);
        if (dn) s += qn * dn * (idf.get(t) ?? 1);
    }
    return s;
}

/**
 * BM25 for the body field. Unlike raw term frequency it saturates repeated occurrences (`k1`) and
 * normalizes by document length (`b`), so a sprawling definition cannot outrank a tight, on-point
 * function merely by containing more words.
 */
export function bm25(query: Map<string, number>, doc: Map<string, number>, idf: Map<string, number>, dl: number, avgdl: number): number {
    const k1 = 1.2;
    const b = 0.75;
    const norm = k1 * (1 - b + (b * dl) / (avgdl || 1));
    let s = 0;
    for (const t of query.keys()) {
        const tf = doc.get(t);
        if (tf) s += (idf.get(t) ?? 1) * ((tf * (k1 + 1)) / (tf + norm));
    }
    return s;
}

/** Total term count of a bag - the document length BM25 normalizes against. */
export function bagLength(m: Map<string, number>): number {
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
}

/** Term presence with plural folding, so a natural-language plural is not read as a miss. */
export function hasTerm(f: Map<string, number>, t: string): boolean {
    return f.has(t) || f.has(`${t}s`) || (t.endsWith("s") && f.has(t.slice(0, -1)));
}

/**
 * IDF-weighted share (0..1) of the query that a document matches: each query term counts by its
 * rarity. This separates a real task prompt (which matches exactly the rare, discriminating
 * identifiers) from conversational chatter (whose words are either off-corpus or generic).
 */
export function matchedShare(query: Map<string, number>, fields: Array<Map<string, number>>, idf: Map<string, number>, defaultIdf: number): number {
    let matched = 0;
    let total = 0;
    for (const t of query.keys()) {
        const w = idf.get(t) ?? defaultIdf;
        total += w;
        if (fields.some((f) => hasTerm(f, t))) matched += w;
    }
    return total > 0 ? matched / total : 0;
}

export interface PageRankOptions {
    /** Mass that teleports back to the seed set each step. Higher keeps the walk near the seeds. */
    alpha?: number;
    /** Power-iteration count; 25 converges comfortably on graphs of this size. */
    iters?: number;
    /** Restrict the walk to a subgraph: an edge counts only when both endpoints pass. */
    nodeFilter?: (id: string) => boolean;
}

/**
 * Personalized PageRank over the wiring graph, seeded by lexical scores.
 *
 * The graph is walked as UNDIRECTED: for "understand this area" a callee is as relevant as a
 * caller. Returns a score per node normalized so the top node is 1; nodes the walk never touched
 * are absent. Edges whose endpoints are not both real nodes (an unresolved import specifier, say)
 * are ignored, so only genuine wiring carries mass.
 */
export function personalizedPageRank(nodeIds: Iterable<string>, edges: CodeEdge[], seeds: Map<string, number>, opts: PageRankOptions = {}): Map<string, number> {
    const alpha = opts.alpha ?? 0.25;
    const iters = opts.iters ?? 25;

    const ids = new Set<string>();
    for (const id of nodeIds) if (!opts.nodeFilter || opts.nodeFilter(id)) ids.add(id);

    const adj = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
        const arr = adj.get(a);
        if (arr) arr.push(b);
        else adj.set(a, [b]);
    };
    for (const [source, target, rel] of edges) {
        if (!WALK_RELATIONS.has(rel)) continue;
        if (!ids.has(source) || !ids.has(target)) continue;
        link(source, target);
        link(target, source);
    }

    let seedTotal = 0;
    for (const [id, w] of seeds) if (ids.has(id) && w > 0) seedTotal += w;
    if (seedTotal <= 0) return new Map();
    const restart = new Map<string, number>();
    for (const [id, w] of seeds) if (ids.has(id) && w > 0) restart.set(id, w / seedTotal);

    let rank = new Map(restart);
    for (let i = 0; i < iters; i++) {
        const next = new Map<string, number>();
        for (const [id, r] of restart) next.set(id, alpha * r);
        // Dangling mass (nodes with no walk edges) is pooled and returned to the seed set once per
        // iteration - the same math as redistributing per node, at O(nodes + seeds) instead of
        // O(dangling x seeds).
        let dangling = 0;
        for (const [id, mass] of rank) {
            const nbrs = adj.get(id);
            if (!nbrs || nbrs.length === 0) { dangling += mass; continue; }
            const share = ((1 - alpha) * mass) / nbrs.length;
            for (const nb of nbrs) next.set(nb, (next.get(nb) ?? 0) + share);
        }
        if (dangling > 0) {
            const dm = (1 - alpha) * dangling;
            for (const [sid, r] of restart) next.set(sid, (next.get(sid) ?? 0) + dm * r);
        }
        rank = next;
    }

    let max = 0;
    for (const v of rank.values()) if (v > max) max = v;
    if (max <= 0) return new Map();
    const out = new Map<string, number>();
    for (const [id, v] of rank) out.set(id, v / max);
    return out;
}

/** The file a node id belongs to: everything before the `#` for a symbol, the id itself for a file. */
export function pathOfId(id: string): string {
    const hash = id.indexOf("#");
    return hash === -1 ? id : id.slice(0, hash);
}

/**
 * Incoming walk-relation edge count per target - the shared "coupling" metric behind every
 * "which of these matters" ranking.
 *
 * `crossFileOnly` is what makes it mean something: a hub is code OTHER files depend on. Counting
 * same-file references instead crowns a local helper used fifty times in its own module over the
 * function half the codebase imports, which is exactly backwards for orientation.
 */
export function inDegree(edges: CodeEdge[], crossFileOnly = false): Map<string, number> {
    const deg = new Map<string, number>();
    for (const [source, target, rel] of edges) {
        if (!WALK_RELATIONS.has(rel)) continue;
        if (crossFileOnly && pathOfId(source) === pathOfId(target)) continue;
        deg.set(target, (deg.get(target) ?? 0) + 1);
    }
    return deg;
}

/** Test files stay findable ("where are the tests") but rank below the definition they exercise. */
export function isTestPath(path: string): boolean {
    return /(^|\/)(tests?|__tests__|spec)\/|(_test|\.test|\.spec)\.[a-z]+$|(^|\/)(test_[^/]+|conftest)\.py$/i.test(path || "");
}
