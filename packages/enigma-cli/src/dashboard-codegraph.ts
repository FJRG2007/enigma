/**
 * Bridge exposing the native codebase-memory (code graph) engine to the dashboard's HTTP API:
 * a serializable view (enabled state, indexed projects, and a selected project's architecture +
 * graph schema, freshness) and actions - toggle the codeGraph setting on/off (which (de)registers
 * the enigma MCP server that hosts the tools), index a project directory, run a query against the
 * graph, and cut a drawable slice of it for the panel's canvas. Imported dynamically by
 * dashboard.ts. Everything is computed in-process by enigma's own engine - no external tool.
 */

import { readConfig } from "./config";
import * as q from "./codegraph-query";
import * as fmt from "./codegraph-format";
import * as sub from "./codegraph-subgraph";
import {
    codeGraphArchitecture,
    codeGraphSchema,
    indexProject,
    listProjects,
    type Architecture,
    type CodeGraphProject,
    type GraphSchema
} from "./codegraph";

export interface CodeGraphView {
    /** config.codeGraph is on (tools exposed to agents). */
    enabled: boolean;
    /** The engine is native, so it is always available. */
    available: boolean;
    /** Indexed projects known to the code graph. */
    projects: CodeGraphProject[];
    /** The project whose detail is shown, or null. */
    selected: string | null;
    /** Architecture overview for the selected project. */
    architecture: Architecture | null;
    /** Node/edge label counts for the selected project. */
    schema: GraphSchema | null;
    /** How far the graph has drifted from the code since it was indexed. */
    freshness: q.FreshnessResult | null;
    /** The last query's answer, when the view was built by an `ask` action. */
    ask: { query: string; report: string; } | null;
}

/** Build the code-graph view, resolving the selected project's detail. */
export function codeGraphDashboard(opts: { project?: string; ask?: { query: string; report: string; }; } = {}): CodeGraphView {
    const enabled = readConfig().config.codeGraph;
    const projects = listProjects();
    const names = projects.map((p) => p.name);
    const selected = (opts.project && (names.includes(opts.project) || projects.some((p) => p.id === opts.project)))
        ? opts.project
        : (projects[0]?.name || null);
    return {
        enabled,
        available: true,
        projects,
        selected,
        architecture: selected ? codeGraphArchitecture(selected) : null,
        schema: selected ? codeGraphSchema(selected) : null,
        // Reported, never repaired here: a panel that silently re-indexed on every render would
        // turn a page refresh into a full re-parse of the tree.
        freshness: selected ? q.codeGraphCheck(selected) : null,
        ask: opts.ask ?? null,
    };
}

export interface CodeGraphActionPayload {
    on?: boolean;
    project?: string;
    root?: string;
    query?: string;
    /** A symbol name, file path or node id to centre the slice on. */
    focus?: string;
    depth?: number;
    limit?: number;
    scope?: sub.SubgraphScope;
}

export interface CodeGraphActionResult {
    ok: boolean;
    error?: string;
    view?: CodeGraphView;
    enabled?: boolean;
    note?: string;
    /** The drawable slice, for the `graph` action only. */
    graph?: sub.SubgraphResult;
}

/** Apply a code-graph action and return the refreshed view. */
export async function applyCodeGraphAction(op: string, payload: CodeGraphActionPayload = {}): Promise<CodeGraphActionResult> {
    if (op === "toggle") {
        if (typeof payload.on !== "boolean") return { ok: false, error: "missing on flag" };
        // Through the settings registry, not straight to the config file: the toggle owns the MCP
        // tools, the four session hooks AND the skill block that tells an agent they exist. Writing
        // the value here on its own left the dashboard's switch doing a third of what the same
        // switch does from the CLI - enabled in the config, never wired into a session.
        const { applySetting } = await import("./dashboard-settings");
        const out = await applySetting("code-graph", payload.on, "global");
        if (!out.ok) return { ok: false, error: out.error };
        // Deliberately no view: nothing the panel shows depends on the toggle, and rebuilding it
        // would stat the whole tree to re-answer a freshness question the toggle did not change.
        return { ok: true, enabled: readConfig().config.codeGraph, note: out.restartNote };
    }
    if (op === "index") {
        try {
            const entry = indexProject(payload.root && payload.root.trim() ? payload.root.trim() : undefined);
            return { ok: true, view: codeGraphDashboard({ project: entry.name }) };
        } catch (e) {
            return { ok: false, error: `indexing failed: ${(e as Error).message}` };
        }
    }
    if (op === "ask") {
        const query = (payload.query ?? "").trim();
        if (!query) return { ok: false, error: "missing query" };
        try {
            // Same refusal as the freshness field above, for the same reason: a refresh here is a
            // full re-parse of the tree inside the request, and this server handles one at a time.
            // Drift is already reported next to the answer, with Re-index as the repair.
            const answer = q.codeGraphAsk(query, { project: payload.project, limit: 10, refresh: false });
            if (!answer) return { ok: false, error: q.NOT_INDEXED };
            return { ok: true, view: codeGraphDashboard({ project: payload.project, ask: { query, report: fmt.formatAsk(answer) } }) };
        } catch (e) {
            return { ok: false, error: `query failed: ${(e as Error).message}` };
        }
    }
    if (op === "graph") {
        try {
            // Same refusal as `ask`: no refresh inside the request. Panning a graph must not
            // re-parse the tree, and the Freshness panel already states the drift with the repair.
            const slice = sub.codeGraphSubgraph({
                project: payload.project,
                focus: payload.focus,
                depth: payload.depth,
                limit: payload.limit,
                scope: payload.scope,
                refresh: false,
            });
            if (!slice) return { ok: false, error: q.NOT_INDEXED };
            return { ok: true, graph: slice };
        } catch (e) {
            return { ok: false, error: `graph failed: ${(e as Error).message}` };
        }
    }
    if (op === "refresh") return { ok: true, view: codeGraphDashboard({ project: payload.project }) };
    return { ok: false, error: `unknown op '${op}'` };
}
