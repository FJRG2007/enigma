/**
 * Bridge exposing the native codebase-memory (code graph) engine to the dashboard's HTTP API:
 * a serializable view (enabled state, indexed projects, and a selected project's architecture +
 * graph schema, freshness) and actions - toggle the codeGraph setting on/off (which (de)registers
 * the enigma MCP server that hosts the tools), index a project directory, and run a query against
 * the graph. Imported dynamically by dashboard.ts. Everything is computed in-process by enigma's
 * own engine - no external tool.
 */

import * as q from "./codegraph-query";
import * as fmt from "./codegraph-format";
import { applyMcpToggle } from "./mcp-deploy";
import { readConfig, setEnigmaValue } from "./config";
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

export interface CodeGraphActionPayload { on?: boolean; project?: string; root?: string; query?: string; }

/** Apply a code-graph action and return the refreshed view. */
export function applyCodeGraphAction(op: string, payload: CodeGraphActionPayload = {}): { ok: boolean; error?: string; view?: CodeGraphView; } {
    if (op === "toggle") {
        if (typeof payload.on !== "boolean") return { ok: false, error: "missing on flag" };
        setEnigmaValue("codeGraph", payload.on, "global");
        applyMcpToggle("global");
        return { ok: true, view: codeGraphDashboard({ project: payload.project }) };
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
            const answer = q.codeGraphAsk(query, { project: payload.project, limit: 10 });
            if (!answer) return { ok: false, error: q.NOT_INDEXED };
            return { ok: true, view: codeGraphDashboard({ project: payload.project, ask: { query, report: fmt.formatAsk(answer) } }) };
        } catch (e) {
            return { ok: false, error: `query failed: ${(e as Error).message}` };
        }
    }
    if (op === "refresh") return { ok: true, view: codeGraphDashboard({ project: payload.project }) };
    return { ok: false, error: `unknown op '${op}'` };
}
