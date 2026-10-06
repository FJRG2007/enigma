/**
 * Functional areas of a codebase: files grouped by how densely they depend on each other, not by
 * which directory they sit in.
 *
 * A directory map says where files are; an agent orienting in a repo needs to know what works with
 * what - a gate's runner and the dashboard view that renders it belong to one area wherever they
 * live. Graphify (Graphify-Labs/graphify) clusters its graph with Leiden for the same reason. This
 * is Louvain (Blondel et al. 2008), Leiden's predecessor: the same modularity objective, simpler to
 * write without a dependency, and on a graph this size the connectedness refinement Leiden adds
 * matters less than it costs. Deterministic: nodes are visited in sorted order and ties keep the
 * current community, so the same graph always yields the same areas.
 */

/** An undirected weighted edge between two files. */
export type FileLink = [string, string, number];

/** Moves per pass before a level stops improving - bounds a pathological graph, never reached in practice. */
const MAX_SWEEPS = 20;

/** Levels of aggregation - each roughly divides the community count, so a handful suffices. */
const MAX_LEVELS = 6;

interface Level { nodes: number; adj: Map<number, number>[]; selfLoops: number[]; }

/** One Louvain level: greedy modularity moves until no node gains by moving. Returns community per node. */
function localMoves(level: Level, totalWeight: number): number[] {
    const { nodes, adj, selfLoops } = level;
    const degree = new Array<number>(nodes).fill(0);
    for (let i = 0; i < nodes; i++) {
        let d = selfLoops[i] * 2;
        for (const w of adj[i].values()) d += w;
        degree[i] = d;
    }
    const comm = Array.from({ length: nodes }, (_, i) => i);
    const commDegree = degree.slice();
    const m2 = totalWeight * 2;
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        let moved = false;
        for (let i = 0; i < nodes; i++) {
            const current = comm[i];
            const toComm = new Map<number, number>();
            for (const [j, w] of adj[i]) toComm.set(comm[j], (toComm.get(comm[j]) ?? 0) + w);
            commDegree[current] -= degree[i];
            let best = current;
            let bestGain = (toComm.get(current) ?? 0) - (commDegree[current] * degree[i]) / m2;
            for (const [c, w] of [...toComm.entries()].sort((a, b) => a[0] - b[0])) {
                const gain = w - (commDegree[c] * degree[i]) / m2;
                if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
            }
            commDegree[best] += degree[i];
            if (best !== current) { comm[i] = best; moved = true; }
        }
        if (!moved) break;
    }
    return comm;
}

/**
 * Group files into functional areas. Returns file -> area index, areas numbered by size (0 is the
 * largest). Files with no dependency edge each form their own area and are left to the caller.
 */
export function clusterFiles(files: string[], links: FileLink[]): Map<string, number> {
    const sorted = [...new Set(files)].sort();
    const index = new Map(sorted.map((f, i) => [f, i]));
    let level: Level = { nodes: sorted.length, adj: sorted.map(() => new Map<number, number>()), selfLoops: new Array<number>(sorted.length).fill(0) };
    let totalWeight = 0;
    for (const [a, b, w] of links) {
        const i = index.get(a);
        const j = index.get(b);
        if (i === undefined || j === undefined || w <= 0) continue;
        totalWeight += w;
        if (i === j) { level.selfLoops[i] += w; continue; }
        level.adj[i].set(j, (level.adj[i].get(j) ?? 0) + w);
        level.adj[j].set(i, (level.adj[j].get(i) ?? 0) + w);
    }
    // membership[f] = community of original node f at the current level.
    let membership = sorted.map((_, i) => i);
    if (totalWeight === 0) return new Map(sorted.map((f, i) => [f, i]));

    for (let l = 0; l < MAX_LEVELS; l++) {
        const comm = localMoves(level, totalWeight);
        const ids = new Map<number, number>();
        for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size);
        if (ids.size === level.nodes) break;
        membership = membership.map((c) => ids.get(comm[c])!);
        // Aggregate: one node per community, edges summed, internal edges as self loops.
        const next: Level = { nodes: ids.size, adj: Array.from({ length: ids.size }, () => new Map<number, number>()), selfLoops: new Array<number>(ids.size).fill(0) };
        for (let i = 0; i < level.nodes; i++) {
            const ci = ids.get(comm[i])!;
            next.selfLoops[ci] += level.selfLoops[i];
            for (const [j, w] of level.adj[i]) {
                const cj = ids.get(comm[j])!;
                if (ci === cj) { if (i < j) next.selfLoops[ci] += w; } else next.adj[ci].set(cj, (next.adj[ci].get(cj) ?? 0) + w);
            }
        }
        level = next;
    }

    // Renumber by size, largest first, ties by first member - stable across runs.
    const members = new Map<number, string[]>();
    sorted.forEach((f, i) => { const c = membership[i]; const list = members.get(c); if (list) list.push(f); else members.set(c, [f]); });
    const order = [...members.entries()].sort((a, b) => b[1].length - a[1].length || a[1][0].localeCompare(b[1][0]));
    const out = new Map<string, number>();
    order.forEach(([, list], rank) => { for (const f of list) out.set(f, rank); });
    return out;
}
