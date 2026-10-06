/**
 * The code graph's shared vocabulary: what a node is, what an edge means, and which edges count
 * as a dependency.
 *
 * Kept in its own module so the builder (codegraph.ts), the ranking primitives (codegraph-rank.ts)
 * and the retrieval layer (codegraph-query.ts) can all agree on the shape without importing each
 * other - "important" then means the same thing on every surface, and no cycle is needed to say so.
 */

import type { SymbolKind } from "./codegraph-extract";

/**
 * How one node depends on another. `contains` is structural (a file holds its symbols) and is
 * deliberately excluded from every dependency walk: a file contains every symbol declared in it,
 * so walking it would make same-file symbols neighbours and turn any file into a false hub.
 */
export type EdgeRelation = "contains" | "imports" | "calls" | "references" | "extends" | "implements";

/**
 * `[source, target, relation, inferred?]` - positional to keep the persisted graph small. The
 * fourth slot is `1` when the edge was INFERRED by a naming heuristic (a globally unique name in a
 * language whose imports do not say what they bind, or a doc's inline-code mention) rather than
 * read from an explicit statement - an import, a declaration in the same file, or an import that
 * binds the name. Absent means extracted. Graphify tags its edges the same way, so a reader can
 * weigh "this calls that" by how it was learned.
 */
export type CodeEdge = [string, string, EdgeRelation, 1?];

/** True when the edge came from a naming heuristic rather than an explicit statement. */
export function isInferred(edge: CodeEdge): boolean {
    return edge[3] === 1;
}

/** Edges that carry dependency meaning, shared by every ranking and traversal surface. */
export const WALK_RELATIONS: ReadonlySet<EdgeRelation> = new Set<EdgeRelation>(["imports", "calls", "references", "extends", "implements"]);

/** A node as the query layer sees it: a file or one symbol, addressed by its stable id. */
export interface GraphNode {
    id: string;
    name: string;
    kind: SymbolKind | "file";
    path: string;
    line: number;
    endLine: number;
    signature: string;
    /** File nodes only: byte length of the whole file (the "read it whole" savings baseline). */
    chars?: number;
}

/** Per-node searchable vocabulary: `[nodeId, [token, count][]]`, written beside the graph. */
export type BodyIndex = [string, [string, number][]][];
