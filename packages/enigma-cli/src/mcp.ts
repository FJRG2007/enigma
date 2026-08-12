/**
 * enigma's MCP server: a hand-rolled stdio JSON-RPC 2.0 endpoint exposing the
 * native compression engine to any MCP host (Claude Code, Codex, opencode, Kimi Code). No
 * SDK dependency - enigma ships zero runtime deps, and the tools-only surface of
 * MCP over stdio (initialize / tools/list / tools/call) is small enough to
 * implement directly with Node builtins.
 *
 * Transport contract: newline-delimited JSON, one message per line, on stdin and
 * stdout. stdout is the protocol channel, so ALL diagnostics go to stderr.
 *
 * Tools:
 *   enigma_compress    - compress tool output/logs/text; returns the compressed
 *                        payload (carrying a CCR marker when lossy).
 *   enigma_retrieve    - restore the original behind a CCR hash.
 *   enigma_stats       - cumulative token savings.
 *   enigma_recall      - search the local session-memory index (when recall is on).
 *   enigma_recall_get  - fetch full memory observations by id.
 *   enigma_codegraph_* - index/search/architecture over the native code graph (when codeGraph is on).
 */

import { readConfig } from "./config";
import { compress, retrieve, readStats } from "./compress";
import { searchRecall, getObservations, recallTimeline, recallAvailable } from "./recall";
import { indexProject, listProjects, searchGraph, codeGraphArchitecture } from "./codegraph";
import type { ContentType } from "./compress";

const PROTOCOL_VERSION = "2025-06-18";
const CONTENT_TYPES: ContentType[] = ["json", "code", "log", "diff", "markdown", "text"];

interface JsonRpcRequest {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
}

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; };
}

const TOOLS = [
    {
        name: "enigma_compress",
        description:
            "Compress large tool output, logs, JSON, or text before reading it - same information, far fewer tokens. "
            + "Returns the compressed content; when data is dropped it carries a marker <<enigma:ccr:HASH ...>> whose "
            + "HASH can be passed to enigma_retrieve to get the full original back.",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string", description: "The raw content to compress." },
                content_type: { type: "string", enum: CONTENT_TYPES, description: "Optional: force a content type instead of auto-detecting." },
            },
            required: ["content"],
        },
    },
    {
        name: "enigma_retrieve",
        description: "Retrieve the full original content behind a CCR hash produced by enigma_compress.",
        inputSchema: {
            type: "object",
            properties: { hash: { type: "string", description: "The CCR hash from a <<enigma:ccr:HASH ...>> marker." } },
            required: ["hash"],
        },
    },
    {
        name: "enigma_stats",
        description: "Report cumulative token savings from compression so far (calls, tokens before/after, tokens saved).",
        inputSchema: { type: "object", properties: {} },
    },
];

/**
 * Recall tools, exposed only when the recall setting is on. They give an agent durable
 * memory of past coding sessions in this project: search a compact index first (cheap), then
 * fetch full details for the ids that matter (the search -> get pattern keeps tokens low).
 */
const RECALL_TOOLS = [
    {
        name: "enigma_recall",
        description: "Search durable memory of past coding sessions (what was done, which files changed, decisions made). Returns a compact index of observations with ids; pass interesting ids to enigma_recall_get for full details. Use this at the start of a task to recall prior context about this project.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Free-text search; empty returns the most recent observations." },
                project: { type: "string", description: "Optional: limit to a project name." },
                type: { type: "string", description: "Optional: filter by type (bugfix, feature, refactor, change, discovery, decision, security)." },
                limit: { type: "number", description: "Max results (default 15)." },
            },
        },
    },
    {
        name: "enigma_recall_get",
        description: "Fetch full details for memory observations by id (from enigma_recall). Always batch the ids you want.",
        inputSchema: {
            type: "object",
            properties: { ids: { type: "array", items: { type: "number" }, description: "Observation ids to fetch." } },
            required: ["ids"],
        },
    },
    {
        name: "enigma_recall_timeline",
        description: "Get the chronological context around a memory observation - what was done just before and after it in the same project. Pass an id from enigma_recall.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "number", description: "Anchor observation id." }, before: { type: "number" }, after: { type: "number" } },
            required: ["id"],
        },
    },
];

/**
 * Native code-graph tools, exposed only when the codeGraph setting is on. They give an agent a
 * structural map of the codebase (symbols, imports, references) built by enigma itself - no
 * external engine. Index once, then search symbols or read the architecture.
 */
const CODEGRAPH_TOOLS = [
    {
        name: "enigma_codegraph_index",
        description: "Index a project's source into a code knowledge graph (files, symbols, imports, cross-file references). Run once per project (or after big changes); the other codegraph tools read what this builds.",
        inputSchema: {
            type: "object",
            properties: { root: { type: "string", description: "Absolute path to the project root (defaults to the current working directory)." } },
        },
    },
    {
        name: "enigma_codegraph_projects",
        description: "List the projects already indexed into the code graph (name, root, file/symbol counts).",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "enigma_codegraph_search",
        description: "Search a project's code graph for symbols (functions, classes, types, ...) by name pattern and optional kind. Use this to locate where something is defined without grepping.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name pattern (regex or substring, case-insensitive)." },
                kind: { type: "string", description: "Optional: function | class | interface | type | struct | enum | trait | module | method." },
                project: { type: "string", description: "Optional: project name/root/id (defaults to the most recently indexed)." },
                limit: { type: "number", description: "Max results (default 50)." },
            },
        },
    },
    {
        name: "enigma_codegraph_architecture",
        description: "Get a project's architecture overview from the code graph: languages, entry points, hotspots (most-referenced symbols), top-level packages and external dependencies.",
        inputSchema: {
            type: "object",
            properties: { project: { type: "string", description: "Optional: project name/root/id (defaults to the most recently indexed)." } },
        },
    },
];

/** The tools advertised this connection: recall/codegraph tools appear only when enabled. */
function toolList(): unknown[] {
    const cfg = readConfig().config;
    let tools: unknown[] = [...TOOLS];
    if (cfg.recall && recallAvailable()) tools = [...tools, ...RECALL_TOOLS];
    if (cfg.codeGraph) tools = [...tools, ...CODEGRAPH_TOOLS];
    return tools;
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Wrap text as an MCP tool-call result payload. */
function textResult(text: string, isError = false): unknown {
    return { content: [{ type: "text", text }], isError };
}

/** Execute a single tool call and return its MCP result payload. */
function callTool(name: string, args: Record<string, unknown>, source?: string): unknown {
    switch (name) {
        case "enigma_compress": {
            const content = typeof args.content === "string" ? args.content : "";
            if (!content) return textResult("enigma_compress: 'content' is required.", true);
            const type = CONTENT_TYPES.includes(args.content_type as ContentType) ? (args.content_type as ContentType) : undefined;
            const r = compress(content, { type, source });
            return textResult(r.compressed);
        }
        case "enigma_retrieve": {
            const hash = typeof args.hash === "string" ? args.hash : "";
            const original = hash ? retrieve(hash) : null;
            return original === null ? textResult(`enigma_retrieve: no cached original for hash '${hash}'.`, true) : textResult(original);
        }
        case "enigma_stats":
            return textResult(JSON.stringify(readStats(), null, 2));
        case "enigma_recall": {
            if (!readConfig().config.recall || !recallAvailable()) return textResult("enigma_recall: session memory is off (enable it with `enigma config recall on`).", true);
            const query = typeof args.query === "string" ? args.query : "";
            const project = typeof args.project === "string" ? args.project : undefined;
            const type = typeof args.type === "string" ? args.type : undefined;
            const limit = typeof args.limit === "number" ? args.limit : 15;
            const hits = searchRecall(query, { project, type, limit });
            const index = hits.map((o) => ({ id: o.id, type: o.type, title: o.title, project: o.project, files: o.filesModified.slice(0, 5) }));
            return textResult(JSON.stringify(index, null, 2));
        }
        case "enigma_recall_get": {
            if (!readConfig().config.recall || !recallAvailable()) return textResult("enigma_recall_get: session memory is off (enable it with `enigma config recall on`).", true);
            const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
            if (!ids.length) return textResult("enigma_recall_get: 'ids' (array of numbers) is required.", true);
            return textResult(JSON.stringify(getObservations(ids), null, 2));
        }
        case "enigma_recall_timeline": {
            if (!readConfig().config.recall || !recallAvailable()) return textResult("enigma_recall_timeline: session memory is off (enable it with `enigma config recall on`).", true);
            const id = typeof args.id === "number" ? args.id : 0;
            if (!id) return textResult("enigma_recall_timeline: 'id' (number) is required.", true);
            const before = typeof args.before === "number" ? args.before : undefined;
            const after = typeof args.after === "number" ? args.after : undefined;
            return textResult(JSON.stringify(recallTimeline({ id, before, after }), null, 2));
        }
        case "enigma_codegraph_index": {
            if (!readConfig().config.codeGraph) return textResult("enigma_codegraph_index: the code graph is off (enable it with `enigma config code-graph on`).", true);
            const root = typeof args.root === "string" && args.root ? args.root : undefined;
            return textResult(JSON.stringify(indexProject(root), null, 2));
        }
        case "enigma_codegraph_projects": {
            if (!readConfig().config.codeGraph) return textResult("enigma_codegraph_projects: the code graph is off (enable it with `enigma config code-graph on`).", true);
            return textResult(JSON.stringify(listProjects(), null, 2));
        }
        case "enigma_codegraph_search": {
            if (!readConfig().config.codeGraph) return textResult("enigma_codegraph_search: the code graph is off (enable it with `enigma config code-graph on`).", true);
            const project = typeof args.project === "string" ? args.project : undefined;
            const hits = searchGraph(project, {
                name: typeof args.name === "string" ? args.name : undefined,
                kind: typeof args.kind === "string" ? args.kind : undefined,
                limit: typeof args.limit === "number" ? args.limit : undefined,
            });
            return textResult(JSON.stringify(hits, null, 2));
        }
        case "enigma_codegraph_architecture": {
            if (!readConfig().config.codeGraph) return textResult("enigma_codegraph_architecture: the code graph is off (enable it with `enigma config code-graph on`).", true);
            const arch = codeGraphArchitecture(typeof args.project === "string" ? args.project : undefined);
            return arch ? textResult(JSON.stringify(arch, null, 2)) : textResult("enigma_codegraph_architecture: no project indexed yet - run enigma_codegraph_index first.", true);
        }
        default:
            return textResult(`Unknown tool: ${name}`, true);
    }
}

/** The MCP client name reported in an initialize request, or undefined. */
export function clientNameOf(req: JsonRpcRequest): string | undefined {
    const info = req.params?.clientInfo as { name?: unknown; } | undefined;
    return typeof info?.name === "string" && info.name ? info.name : undefined;
}

/**
 * Pure request handler. Returns a response object, or null for notifications
 * (which take no reply). `source` is the connection's MCP client name, threaded in
 * so a compress call is attributed to the calling app. Exported so the server can be
 * driven in tests without a real stdio pipe.
 */
export function handleMcpRequest(req: JsonRpcRequest, version: string, source?: string): JsonRpcResponse | null {
    switch (req.method) {
        case "initialize":
            return ok(req.id, {
                protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: "enigma", version },
            });
        case "notifications/initialized":
        case "notifications/cancelled":
            return null; // notifications get no response
        case "ping":
            return ok(req.id, {});
        case "tools/list":
            return ok(req.id, { tools: toolList() });
        case "tools/call": {
            const name = String(req.params?.name ?? "");
            const args = (req.params?.arguments as Record<string, unknown>) ?? {};
            try { return ok(req.id, callTool(name, args, source)); }
            catch (e) { return err(req.id, -32603, `Tool error: ${(e as Error).message}`); }
        }
        default:
            // A notification we don't handle (method starts with "notifications/") gets no reply.
            if (typeof req.method === "string" && req.method.startsWith("notifications/")) return null;
            return err(req.id, -32601, `Method not found: ${req.method}`);
    }
}

/**
 * Run the stdio server loop: read newline-delimited JSON-RPC from stdin, write
 * responses to stdout, log to stderr. Resolves when stdin closes.
 */
export function runMcpServer(version: string): Promise<void> {
    return new Promise((resolve) => {
        let buffer = "";
        // Connection state: the client identifies itself once at initialize, and that
        // name attributes every later compress call to the calling app.
        let clientName: string | undefined;
        process.stdin.setEncoding("utf8");
        const emit = (res: JsonRpcResponse | null) => { if (res) process.stdout.write(JSON.stringify(res) + "\n"); };
        process.stdin.on("data", (chunk: string) => {
            buffer += chunk;
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let req: JsonRpcRequest;
                try { req = JSON.parse(line); }
                catch { emit(err(null, -32700, "Parse error")); continue; }
                if (req.method === "initialize") clientName = clientNameOf(req) ?? clientName;
                try { emit(handleMcpRequest(req, version, clientName)); }
                catch (e) { process.stderr.write(`enigma mcp: ${(e as Error).message}\n`); }
            }
        });
        process.stdin.on("end", () => resolve());
        process.stdin.on("close", () => resolve());
    });
}
