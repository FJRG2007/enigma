/**
 * The tool endpoints of `enigma serve`: the same recall, code graph and compression operations the
 * MCP server gives a local agent, as JSON over HTTP for a host with no CLI home (a chat backend).
 *
 * Every handler is synchronous and runs inside withTenant, so the stores it touches are the
 * calling tenant's and nobody else's. Handlers validate their body with an explicit schema,
 * cap every list they return, and throw ServeError with a stable code for anything the caller
 * can act on.
 */

import * as recall from "../recall";
import { confineRoot } from "./tenant";
import * as cgQuery from "../codegraph-query";
import * as cgFormat from "../codegraph-format";
import { ccrCacheStats } from "../compress/ccr";
import { parseBody, type Schema } from "./schema";
import { OBSERVATION_TYPES } from "../recall/types";
import { compress, retrieve, readStats } from "../compress";
import { CONTENT_TYPES, type ContentType } from "../compress";
import { codeGraphArchitecture, indexProject, listProjects, searchGraph } from "../codegraph";

/** An error the client can act on: an HTTP status plus a stable machine code. */
export class ServeError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = "ServeError";
    }
}

/** What a handler sees about the request it serves. */
export interface RouteContext {
    tenant: string;
    /** Root of the tenants' code workspaces, or null when indexing is disabled. */
    workspaceRoot: string | null;
    /** Largest `text` a response may carry, in characters. */
    maxText: number;
}

export interface Route {
    method: "GET" | "POST";
    /** Request-body schema; GET routes take none. */
    schema?: Schema;
    run(body: Record<string, unknown>, ctx: RouteContext): unknown;
}

/** Most items one page of a list may hold, and the deepest a cursor may reach. */
const PAGE_MAX = 100;
const SCAN_MAX = 1000;

/** Opaque-to-clients cursor: the offset of the next page, or null when there is none. */
function page<T>(all: T[], offset: number, limit: number, more: boolean): { items: T[]; nextCursor: string | null; } {
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length;
    return { items, nextCursor: items.length === limit && (more || next < all.length) && next < SCAN_MAX ? String(next) : null };
}

/** Parse a cursor back to an offset; a malformed one is the client's error, not a silent restart. */
function offsetOf(cursor: unknown): number {
    if (cursor === undefined) return 0;
    const n = Number(cursor);
    if (!Number.isInteger(n) || n < 0 || n >= SCAN_MAX) throw new ServeError(400, "invalid_cursor", "cursor is not one this server issued");
    return n;
}

/** Cap a rendered report, saying so instead of cutting it silently. */
function text(value: string, ctx: RouteContext): { text: string; truncated: boolean; } {
    return value.length > ctx.maxText ? { text: value.slice(0, ctx.maxText), truncated: true } : { text: value, truncated: false };
}

/** Fail with 503 when recall cannot run in this process (it needs the Bun binary's sqlite). */
function needRecall(): void {
    if (!recall.recallAvailable()) throw new ServeError(503, "recall_unavailable", "recall needs the enigma binary (bun:sqlite); this process cannot open the store");
}

/**
 * The graph a code graph query reads. Named explicitly or, when the tenant has exactly one
 * project, that one. Never the server's working directory: that would answer one tenant's
 * question from whatever tree the server happens to run in.
 */
function projectOf(asked: unknown): string {
    const all = listProjects();
    if (typeof asked === "string" && asked) {
        const hit = all.find((p) => p.id === asked || p.name === asked);
        if (!hit) throw new ServeError(404, "project_not_found", `no indexed project '${asked}' for this tenant`);
        return hit.id;
    }
    if (all.length === 1) return all[0]!.id;
    if (!all.length) throw new ServeError(409, "not_indexed", "this tenant has no indexed project yet - POST /v1/codegraph/index first");
    throw new ServeError(400, "project_required", "this tenant has several projects - name one with 'project'");
}

const PROJECT = { type: "string", max: 200 } as const;
const IN = { type: "string", max: 500 } as const;

export const ROUTES: Record<string, Route> = {
    // --- recall ---------------------------------------------------------------------------
    "/v1/recall/search": {
        method: "POST",
        schema: {
            query: { type: "string", max: 500 },
            queries: { type: "strings", maxItems: recall.MAX_QUERIES, maxLength: 500 },
            project: PROJECT,
            type: { type: "enum", values: OBSERVATION_TYPES },
            limit: { type: "int", min: 1, max: PAGE_MAX },
            cursor: { type: "string", max: 12 },
        },
        run(b) {
            needRecall();
            const limit = (b.limit as number | undefined) ?? 15;
            const offset = offsetOf(b.cursor);
            const extra = (b.queries as string[] | undefined) ?? [];
            const query = (b.query as string | undefined) ?? "";
            // "*" or no project searches every project the tenant has.
            const project = b.project === "*" ? undefined : b.project as string | undefined;
            const want = Math.min(offset + limit + 1, SCAN_MAX);
            const hits = recall.searchRecall(extra.length ? [query, ...extra] : query, { project, type: b.type as string | undefined, limit: want });
            const index = hits.map((o) => ({ id: o.id, type: o.type, title: o.title, project: o.project, files: o.filesModified.slice(0, 5), createdAt: o.createdAt }));
            return page(index, offset, limit, hits.length >= want);
        },
    },
    "/v1/recall/get": {
        method: "POST",
        schema: { ids: { type: "ints", maxItems: 50, min: 1, max: Number.MAX_SAFE_INTEGER, required: true } },
        run(b) {
            needRecall();
            return { items: recall.getObservations(b.ids as number[]) };
        },
    },
    "/v1/recall/timeline": {
        method: "POST",
        schema: {
            id: { type: "int", min: 1, max: Number.MAX_SAFE_INTEGER, required: true },
            before: { type: "int", min: 0, max: 50 },
            after: { type: "int", min: 0, max: 50 },
        },
        run(b) {
            needRecall();
            return { items: recall.recallTimeline({ id: b.id as number, before: b.before as number | undefined, after: b.after as number | undefined }) };
        },
    },
    "/v1/recall/remember": {
        method: "POST",
        schema: {
            content: { type: "string", max: 4000, required: true },
            type: { type: "enum", values: OBSERVATION_TYPES, required: true },
            files: { type: "strings", maxItems: 20, maxLength: 300 },
            concepts: { type: "strings", maxItems: 20, maxLength: 60 },
            project: { type: "string", max: 200, required: true },
        },
        run(b) {
            needRecall();
            const input = recall.parseRememberInput(b);
            if (!input.ok) throw new ServeError(400, "invalid_body", input.error);
            const r = recall.rememberRecall(input.value, b.project as string);
            if (!r.ok) throw new ServeError(409, "not_stored", r.error);
            return r;
        },
    },
    "/v1/recall/forget": {
        method: "POST",
        schema: {
            ids: { type: "ints", maxItems: recall.FORGET_MAX_IDS, min: 1, max: Number.MAX_SAFE_INTEGER, required: true },
            reason: { type: "string", max: 500, required: true },
        },
        run(b) {
            needRecall();
            const r = recall.forgetRecall(b.ids as number[], b.reason as string);
            if (!r.ok) throw new ServeError(404, "not_found", r.error);
            return r;
        },
    },

    // --- code graph -----------------------------------------------------------------------
    "/v1/codegraph/index": {
        method: "POST",
        schema: { root: { type: "string", max: 1000, required: true } },
        run(b, ctx) {
            if (!ctx.workspaceRoot) throw new ServeError(403, "indexing_disabled", "this server was started without --workspace-root, so it indexes nothing");
            const root = confineRoot(ctx.workspaceRoot, ctx.tenant, b.root as string);
            if (!root) throw new ServeError(403, "forbidden_root", "root must be an existing directory inside this tenant's workspace");
            return indexProject(root);
        },
    },
    "/v1/codegraph/projects": {
        method: "POST",
        schema: { limit: { type: "int", min: 1, max: PAGE_MAX }, cursor: { type: "string", max: 12 } },
        run(b) {
            return page(listProjects(), offsetOf(b.cursor), (b.limit as number | undefined) ?? 50, false);
        },
    },
    "/v1/codegraph/search": {
        method: "POST",
        schema: {
            project: PROJECT,
            name: { type: "string", max: 200 },
            kind: { type: "string", max: 40 },
            limit: { type: "int", min: 1, max: PAGE_MAX },
        },
        run(b) {
            return { items: searchGraph(projectOf(b.project), { name: b.name as string | undefined, kind: b.kind as string | undefined, limit: (b.limit as number | undefined) ?? 20 }) };
        },
    },
    "/v1/codegraph/architecture": {
        method: "POST",
        schema: { project: PROJECT },
        run(b) {
            return codeGraphArchitecture(projectOf(b.project));
        },
    },
    "/v1/codegraph/ask": {
        method: "POST",
        schema: { query: { type: "string", max: 500, required: true }, project: PROJECT, in: IN, limit: { type: "int", min: 1, max: 50 }, source: { type: "bool" } },
        run(b, ctx) {
            const r = cgQuery.codeGraphAsk(b.query as string, { project: projectOf(b.project), in: b.in as string | undefined, limit: b.limit as number | undefined, source: b.source !== false });
            if (!r) throw new ServeError(409, "not_indexed", cgQuery.NOT_INDEXED);
            return text(cgFormat.formatAsk(r), ctx);
        },
    },
    "/v1/codegraph/trace": {
        method: "POST",
        schema: { symbol: { type: "string", max: 300, required: true }, project: PROJECT, in: IN, direction: { type: "enum", values: ["in", "out"] }, depth: { type: "int", min: 1, max: 5 } },
        run(b, ctx) {
            const r = cgQuery.codeGraphTrace(b.symbol as string, { project: projectOf(b.project), in: b.in as string | undefined, direction: b.direction === "out" ? "out" : "in", depth: b.depth as number | undefined });
            if (!r) throw new ServeError(409, "not_indexed", cgQuery.NOT_INDEXED);
            return text(cgFormat.formatTrace(r), ctx);
        },
    },
    "/v1/codegraph/skeleton": {
        method: "POST",
        schema: { file: { type: "string", max: 1000, required: true }, project: PROJECT },
        run(b, ctx) {
            const r = cgQuery.codeGraphSkeleton(b.file as string, { project: projectOf(b.project) });
            if (!r) throw new ServeError(409, "not_indexed", cgQuery.NOT_INDEXED);
            return text(cgFormat.formatSkeleton(r), ctx);
        },
    },
    "/v1/codegraph/map": {
        method: "POST",
        schema: { project: PROJECT, in: IN, maxDirs: { type: "int", min: 1, max: 100 } },
        run(b, ctx) {
            const r = cgQuery.codeGraphMap({ project: projectOf(b.project), in: b.in as string | undefined, maxDirs: b.maxDirs as number | undefined });
            if (!r) throw new ServeError(409, "not_indexed", cgQuery.NOT_INDEXED);
            return text(cgFormat.formatMap(r), ctx);
        },
    },
    "/v1/codegraph/grep": {
        method: "POST",
        schema: { pattern: { type: "string", max: 200, required: true }, project: PROJECT, in: IN, ignoreCase: { type: "bool" }, maxHits: { type: "int", min: 1, max: 500 } },
        run(b, ctx) {
            // Always a literal: a caller-supplied regex is a catastrophic-backtracking hazard on a
            // shared server, and a literal answers what a chat asks for.
            const r = cgQuery.codeGraphGrep(b.pattern as string, { project: projectOf(b.project), in: b.in as string | undefined, ignoreCase: b.ignoreCase === true, fixed: true, maxHits: (b.maxHits as number | undefined) ?? 100 });
            if (!r) throw new ServeError(409, "not_indexed", cgQuery.NOT_INDEXED);
            return text(cgFormat.formatGrep(r), ctx);
        },
    },

    // --- compression and stats ------------------------------------------------------------
    "/v1/compress": {
        method: "POST",
        schema: {
            content: { type: "string", max: Number.MAX_SAFE_INTEGER, required: true },
            content_type: { type: "enum", values: CONTENT_TYPES },
            command: { type: "string", max: 1000 },
        },
        run(b) {
            const r = compress(b.content as string, { type: b.content_type as ContentType | undefined, command: b.command as string | undefined, source: "serve" });
            return { compressed: r.compressed, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter };
        },
    },
    "/v1/retrieve": {
        method: "POST",
        schema: { hash: { type: "string", max: 128, required: true } },
        run(b, ctx) {
            if (!/^[A-Za-z0-9]+$/.test(b.hash as string)) throw new ServeError(400, "invalid_body", "'hash' must be the hash a compress marker carries");
            const original = retrieve(b.hash as string);
            if (original === null) throw new ServeError(404, "not_found", `no cached original for hash '${b.hash}'`);
            return text(original, ctx);
        },
    },
    "/v1/stats": {
        method: "GET",
        run() {
            const r = recall.recallAvailable() ? recall.recallStatus() : null;
            return {
                compress: readStats(),
                cache: ccrCacheStats(),
                recall: r ? { available: true, stats: r.stats, projects: r.projects.length } : { available: false },
                codegraph: { projects: listProjects().length },
            };
        },
    },
};
