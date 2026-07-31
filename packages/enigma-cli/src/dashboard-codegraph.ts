/**
 * Bridge exposing the native codebase-memory (code graph) engine to the dashboard's HTTP API:
 * a serializable view (enabled state, indexed projects, and a selected project's architecture +
 * graph schema) and actions - toggle the codeGraph setting on/off (which (de)registers the enigma
 * MCP server that hosts the tools) and index a project directory. Imported dynamically by
 * dashboard.ts. Everything is computed in-process by enigma's own engine - no external tool.
 */

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
}

/** Build the code-graph view, resolving the selected project's detail. */
export function codeGraphDashboard(opts: { project?: string; } = {}): CodeGraphView {
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
    };
}

export interface CodeGraphActionPayload { on?: boolean; project?: string; root?: string; }

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
    if (op === "refresh") return { ok: true, view: codeGraphDashboard({ project: payload.project }) };
    return { ok: false, error: `unknown op '${op}'` };
}
