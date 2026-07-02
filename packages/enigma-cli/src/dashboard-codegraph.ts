/**
 * Bridge exposing the code-graph (codebase-memory-mcp) integration to the dashboard's HTTP API:
 * a serializable view (enabled/available state, indexed projects, and a selected project's
 * architecture + graph schema) and one action (toggle the codeGraph setting on/off, which
 * registers/removes the MCP server across managed agents). Imported dynamically by dashboard.ts.
 *
 * All graph data comes from the tool's own CLI mode (`codebase-memory-mcp cli <tool> --json`),
 * so the dashboard needs no running UI, port, or SQLite parsing - and degrades gracefully when
 * the tool is not installed (available:false) or nothing is indexed yet (projects:[]).
 */

import { readConfig, setEnigmaValue } from "./config";
import {
    codeGraphArchitecture,
    codeGraphAvailable,
    codeGraphProjects,
    codeGraphSchema,
    applyCodeGraphToggle,
    type CodeGraphProject,
} from "./codegraph";

export interface CodeGraphView {
    /** config.codeGraph is on (server registered in managed agents). */
    enabled: boolean;
    /** The upstream tool is reachable (binary on PATH, or npx available to fetch it). */
    available: boolean;
    /** npm package / binary name, for the "how to install" hint. */
    package: string;
    /** Indexed projects known to the code-graph store. */
    projects: CodeGraphProject[];
    /** The project whose detail is shown, or null. */
    selected: string | null;
    /** get_architecture for the selected project (defensive: shape varies by tool version). */
    architecture: Record<string, unknown> | null;
    /** get_graph_schema (node/edge label counts) for the selected project. */
    schema: Record<string, unknown> | null;
}

function projectName(p: CodeGraphProject): string {
    return (typeof p.name === "string" && p.name) || (typeof p.root === "string" && p.root) || "";
}

/** Build the Code-graph view. When available, resolves the selected project's detail. */
export function codeGraphDashboard(opts: { project?: string } = {}): CodeGraphView {
    const enabled = readConfig().config.codeGraph;
    const available = codeGraphAvailable();
    const pkg = "codebase-memory-mcp";
    if (!available) return { enabled, available, package: pkg, projects: [], selected: null, architecture: null, schema: null };
    const projects = codeGraphProjects();
    // Default to the requested project, else the first indexed one.
    const names = projects.map(projectName).filter(Boolean);
    const selected = (opts.project && names.includes(opts.project)) ? opts.project : (names[0] || null);
    return {
        enabled,
        available,
        package: pkg,
        projects,
        selected,
        architecture: selected ? codeGraphArchitecture(selected) : null,
        schema: selected ? codeGraphSchema(selected) : null,
    };
}

export interface CodeGraphActionPayload { on?: boolean; project?: string }

/** Apply a Code-graph action and return the refreshed view. */
export function applyCodeGraphAction(op: string, payload: CodeGraphActionPayload = {}): { ok: boolean; error?: string; view?: CodeGraphView } {
    if (op === "toggle") {
        if (typeof payload.on !== "boolean") return { ok: false, error: "missing on flag" };
        setEnigmaValue("codeGraph", payload.on, "global");
        applyCodeGraphToggle("global");
        return { ok: true, view: codeGraphDashboard({ project: payload.project }) };
    }
    if (op === "refresh") return { ok: true, view: codeGraphDashboard({ project: payload.project }) };
    return { ok: false, error: `unknown op '${op}'` };
}
