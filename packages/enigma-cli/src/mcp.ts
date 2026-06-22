/**
 * enigma's MCP server: a hand-rolled stdio JSON-RPC 2.0 endpoint exposing the
 * native compression engine to any MCP host (Claude Code, Codex, opencode). No
 * SDK dependency - enigma ships zero runtime deps, and the tools-only surface of
 * MCP over stdio (initialize / tools/list / tools/call) is small enough to
 * implement directly with Node builtins.
 *
 * Transport contract: newline-delimited JSON, one message per line, on stdin and
 * stdout. stdout is the protocol channel, so ALL diagnostics go to stderr.
 *
 * Tools:
 *   enigma_compress  - compress tool output/logs/text; returns the compressed
 *                      payload (carrying a CCR marker when lossy).
 *   enigma_retrieve  - restore the original behind a CCR hash.
 *   enigma_stats     - cumulative token savings.
 */

import { compress, retrieve, readStats } from "./compress";
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
    error?: { code: number; message: string };
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
        default:
            return textResult(`Unknown tool: ${name}`, true);
    }
}

/** The MCP client name reported in an initialize request, or undefined. */
export function clientNameOf(req: JsonRpcRequest): string | undefined {
    const info = req.params?.clientInfo as { name?: unknown } | undefined;
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
            return ok(req.id, { tools: TOOLS });
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
