/**
 * Codebase memory (code graph): enigma manages an external code-intelligence MCP server that
 * keeps a persistent knowledge graph of the codebase (functions, classes, call chains, imports,
 * routes) across many languages. This is STRUCTURAL code memory, complementary to enigma's
 * session `recall` memory.
 *
 * enigma does NOT reimplement the engine (it is a native binary with vendored parsers and
 * embeddings - not portable to enigma's zero-dependency TypeScript). Instead it MANAGES the
 * server: registers it (fetched on demand via npx, the package's own runtime) in each managed
 * agent's config, gated by the `codeGraph` toggle - the same mirror-settings deployment as the
 * compression MCP (mcp-deploy.ts), reusing its generalized helpers - and surfaces the graph in
 * enigma's dashboard by shelling out to the server's CLI mode, which needs no running UI or port.
 *
 * UPSTREAM_PKG is the ONLY place the third-party package name is referenced (it is the npm target
 * npx must run). Every user-facing surface - labels, hints, docs, dashboard, the registered server
 * name - stays de-branded ("codebase memory" / "code graph"). To drop this last reference too,
 * republish the binary under an @enigmax scope (the helio/dashboard pattern) and point UPSTREAM_PKG
 * at it.
 */

import { resolveBin } from "./util";
import { existsSync } from "node:fs";
import { readConfig } from "./config";
import { spawnSync } from "node:child_process";
import { MANAGED_TOOLS, Scope, applyCodexEntry, mcpAccountPath, mcpPath, winWrapInvocation, writeServerEntry } from "./mcp-deploy";

/** De-branded server name in each agent's MCP config (distinct from enigma's own `enigma`). */
const SERVER_NAME = "codegraph";

/** The npm package/binary npx runs - the sole technical reference to the upstream tool. */
const PACKAGE = "codebase-memory-mcp";

/** Whether the code-graph MCP should be registered (the `codeGraph` toggle). */
function codeGraphEnabled(): boolean {
    return readConfig().config.codeGraph;
}

/**
 * How to launch the tool: the resolved binary when installed (fast), else `npx -y <package>`
 * (fetched on demand - matches the package's own npm runtimeHint). Returns the base command and
 * the args that precede any tool arguments. `ENIGMA_CBM_BIN` overrides the binary (tests/mirrors).
 */
function toolBase(): { cmd: string; pre: string[] } | null {
    const direct = process.env.ENIGMA_CBM_BIN || resolveBin(PACKAGE);
    if (direct) return { cmd: direct, pre: [] };
    const npx = resolveBin("npx");
    if (npx) return { cmd: npx, pre: ["-y", PACKAGE] };
    return null;
}

/** The command + args that launch the code-graph MCP server (stdio) for `tool`, per OS. */
function invocation(tool: string): { command: string; args: string[] } {
    const base = toolBase() ?? { cmd: "npx", pre: ["-y", PACKAGE] };
    return winWrapInvocation(tool, base.cmd, base.pre);
}

/** Write/remove the code-graph MCP entry in `file` for `tool`, per `enabled`. */
function writeEntry(tool: string, file: string, enabled: boolean): boolean {
    return writeServerEntry(tool, file, SERVER_NAME, invocation(tool), enabled);
}

/** Register or remove the code-graph MCP server for `agent` at `scope`. Returns whether it changed. */
export function applyCodeGraphForAgent(agent: string, scope: Scope): boolean {
    const file = mcpPath(agent, scope);
    if (!file) return false;
    return writeEntry(agent, file, codeGraphEnabled());
}

/** Register or remove the code-graph MCP server in a managed account's config dir. */
export function applyCodeGraphForAccount(tool: string, dir: string): boolean {
    const file = mcpAccountPath(tool, dir);
    if (!file) return false;
    return writeEntry(tool, file, codeGraphEnabled());
}

/**
 * Apply the `codeGraph` toggle's side effect immediately across managed agents at `scope`
 * (the twin of applyMcpToggle for the code-graph server) so toggling takes effect without
 * re-running `enigma install`. An ENABLE only touches an agent whose config already exists
 * (never creates config for an unused tool); a DISABLE is a no-op on an absent file. Returns
 * the tools whose config changed.
 */
export function applyCodeGraphToggle(scope: Scope): string[] {
    const enabled = codeGraphEnabled();
    const changed: string[] = [];
    for (const tool of MANAGED_TOOLS) {
        const file = mcpPath(tool, scope);
        if (!file) continue;
        if (enabled && !existsSync(file)) continue;
        if (writeEntry(tool, file, enabled)) changed.push(tool);
    }
    return changed;
}

// --- dashboard queries (CLI mode, no UI/port required) ---------------------------------

/** Whether the tool is reachable (binary on PATH, or npx available to fetch it). */
export function codeGraphAvailable(): boolean {
    return toolBase() !== null;
}

/**
 * Run the server's CLI mode (`<bin> cli <tool> [<json>] --json`) and parse the JSON result, or
 * null on any failure (tool absent, non-zero exit, unparseable output). Timeout-bounded; never throws.
 */
function runCli<T = unknown>(tool: string, args?: Record<string, unknown>): T | null {
    const base = toolBase();
    if (!base) return null;
    const argv = [...base.pre, "cli", tool];
    if (args) argv.push(JSON.stringify(args));
    argv.push("--json");
    try {
        const r = spawnSync(base.cmd, argv, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
        if (r.status !== 0 || !r.stdout) return null;
        return JSON.parse(r.stdout) as T;
    } catch {
        return null;
    }
}

export interface CodeGraphProject { name?: string; root?: string; [k: string]: unknown }

/** Indexed projects known to the code-graph store, or [] when unavailable / none indexed. */
export function codeGraphProjects(): CodeGraphProject[] {
    const out = runCli<unknown>("list_projects");
    if (Array.isArray(out)) return out as CodeGraphProject[];
    // Some builds wrap the list under a key (e.g. { projects: [...] }).
    if (out && typeof out === "object") {
        const arr = (out as Record<string, unknown>).projects;
        if (Array.isArray(arr)) return arr as CodeGraphProject[];
    }
    return [];
}

/** Architecture overview for a project (languages, entry points, routes, hotspots, ...), or null. */
export function codeGraphArchitecture(project: string): Record<string, unknown> | null {
    return runCli<Record<string, unknown>>("get_architecture", project ? { project } : undefined);
}

/** Graph schema (node/edge label counts) for a project, or null. */
export function codeGraphSchema(project: string): Record<string, unknown> | null {
    return runCli<Record<string, unknown>>("get_graph_schema", project ? { project } : undefined);
}

/**
 * Run the upstream tool with inherited stdio (passthrough for `enigma codegraph <install|update|
 * index|cli ...>`), returning its exit code, or -1 when the tool is unavailable. Wraps in `cmd /c`
 * on Windows so a `.cmd` launcher (npx / the global bin) resolves without a shell-quoting hazard.
 */
export function codeGraphRun(args: string[]): number {
    const base = toolBase();
    if (!base) return -1;
    const full = [...base.pre, ...args];
    const r = process.platform === "win32"
        ? spawnSync("cmd", ["/c", base.cmd, ...full], { stdio: "inherit" })
        : spawnSync(base.cmd, full, { stdio: "inherit" });
    return r.status ?? 1;
}

/** Compact state for the dashboard "Enigma Systems" panel. */
export function codeGraphStatus(): { enabled: boolean; available: boolean; projects: number } {
    const enabled = codeGraphEnabled();
    const available = codeGraphAvailable();
    return { enabled, available, projects: available ? codeGraphProjects().length : 0 };
}
