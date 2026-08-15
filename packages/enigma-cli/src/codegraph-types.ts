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

/** `[source, target, relation]` - positional to keep the persisted graph small. */
export type CodeEdge = [string, string, EdgeRelation];

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
