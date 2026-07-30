/**
 * Local OpenAI-compatible API server for coding agents.
 *
 * Exposes the local Claude Code (and, where installed, Codex and OpenCode) over an HTTP API
 * that any OpenAI client library can call. It is NOT a network proxy to Anthropic: every
 * request spawns the local agent CLI in headless mode with the resolved account's config dir
 * injected, then translates the CLI output into OpenAI (`/v1/chat/completions`) and Anthropic
 * (`/v1/messages`) response shapes. A single server backs SEVERAL agents at once - each request
 * is routed to an agent adapter by its `model` field (see api-agents.ts).
 *
 * Dependency-free (node:http + node:child_process), loopback-bound by design. The pure
 * translation helpers (message->prompt, chunk shaping) and the per-agent parsers are exported
 * for unit tests so no test ever spawns a CLI.
 */
import { resolveBin } from "./util";
import { readConfig } from "./config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getTool, resolveConfigDir, resolveLaunchAccount, listProfiles } from "./accounts";
import {
    resolveAdapter,
    availableAdapters,
    estimateTokens,
    DEFAULT_MODEL,
    type AgentAdapter,
    type CompletionOptions,
    type ImageBlock,
} from "./api-agents";

/** A content part in an OpenAI/Anthropic message: text, an OpenAI image_url, or an Anthropic image. */
interface ContentPart {
    type?: string;
    text?: string;
    image_url?: { url?: string } | string;
    source?: { type?: string; media_type?: string; data?: string; url?: string };
}

/** Minimal chat message (content may be a string or a content-part array with text and images). */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string | ContentPart[];
}

/** Coerce message content (string or parts) into a single string, keeping only text. */
export function contentToText(content: ChatMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((p) => p && (p.type === undefined || p.type === "text") && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
}

/** Translate an OpenAI `image_url` value (data URL or http URL) into an Anthropic image block. */
function openAIImage(url: string): ImageBlock | null {
    const data = /^data:([^;]+);base64,(.+)$/i.exec(url);
    if (data) return { type: "image", source: { type: "base64", media_type: data[1]!, data: data[2]! } };
    if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
    return null;
}

/**
 * Collect image content blocks from all messages, in Anthropic shape. Handles OpenAI
 * `image_url` parts (data or http URLs) and native Anthropic `image` blocks (passed through),
 * so both request formats can carry vision content (Claude Code applies it; other agents ignore).
 */
export function extractImages(messages: ChatMessage[]): ImageBlock[] {
    const images: ImageBlock[] = [];
    for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content) {
            if (!part) continue;
            if (part.type === "image_url") {
                const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
                const block = url ? openAIImage(url) : null;
                if (block) images.push(block);
            } else if (part.type === "image" && part.source && (part.source.data || part.source.url)) {
                images.push(part.source.type === "url" && part.source.url
                    ? { type: "image", source: { type: "url", url: part.source.url } }
                    : { type: "image", source: { type: "base64", media_type: part.source.media_type || "image/png", data: part.source.data || "" } });
            }
        }
    }
    return images;
}

/**
 * Convert OpenAI messages into an agent prompt plus an optional system prompt. A single user
 * turn is sent verbatim; multi-turn conversations are flattened into a labelled transcript so
 * the model keeps the exchange context. The last system message wins (mirrors OpenAI semantics)
 * and is returned separately so an adapter can apply it as the agent's system prompt.
 */
export function messagesToPrompt(messages: ChatMessage[]): { prompt: string; system: string | null } {
    let system: string | null = null;
    const turns: Array<{ role: string; text: string }> = [];
    for (const m of messages) {
        const text = contentToText(m.content);
        if (m.role === "system") system = text;
        else turns.push({ role: m.role, text });
    }
    if (turns.length === 1 && turns[0]!.role === "user") return { prompt: turns[0]!.text, system };
    const parts = turns.map((t) => `${t.role === "assistant" ? "Assistant" : "Human"}: ${t.text}`);
    if (turns.length && turns[turns.length - 1]!.role !== "user") parts.push("Human: Please continue.");
    return { prompt: parts.join("\n\n"), system };
}

/** OpenAI streaming chunk envelope. */
export function streamChunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null): string {
    const payload = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
}

interface RunResult { text: string; sessionId: string | null; inputTokens: number; outputTokens: number; isError: boolean; errorMessage?: string }

/**
 * Resolve the adapter's agent binary + account-scoped env, spawn it in headless mode, and drive
 * its output. Stream-json adapters parse each line; plain adapters collect the whole stdout as
 * the answer text. Text is forwarded to `onText` (for HTTP streaming); the run summary is
 * returned. Rejects only when the process cannot be spawned.
 */
/**
 * Resolve the config directory the agent should run under, honoring an explicit account, a
 * profile's mapping for this tool, or a pack's isolated context (e.g. Helio) - falling back to
 * the active account. The pack path is dynamic-imported so the common case never loads packs.ts.
 */
async function resolveContextDir(tool: string, opts: CompletionOptions): Promise<string> {
    if (opts.pack) {
        const { ensurePackContext } = await import("./packs");
        return ensurePackContext(opts.pack, tool, opts.account ?? undefined);
    }
    let account = opts.account ?? null;
    if (!account && opts.profile) {
        account = listProfiles().find((p) => p.name === opts.profile)?.accounts[tool] ?? null;
    }
    if (!account) account = resolveLaunchAccount(tool);
    return resolveConfigDir(tool, account);
}

async function runAgent(adapter: AgentAdapter, prompt: string, opts: CompletionOptions, onText?: (t: string) => void): Promise<RunResult> {
    const toolName = adapter.tool;
    const tool = getTool(toolName);
    const cfg = readConfig().config;
    const dir = await resolveContextDir(toolName, opts);
    const binary = process.env[tool.binEnv] || cfg.toolPaths?.[toolName] || resolveBin(tool.bin) || tool.bin;
    const env = { ...process.env, ...tool.envFor(dir) };
    const { args, stdin } = adapter.build(prompt, opts);
    const useShell = process.platform === "win32" && !binary.toLowerCase().endsWith(".exe");

    return new Promise<RunResult>((resolve, reject) => {
        const child = useShell
            ? spawn([binary, ...args].map(quoteWinArg).join(" "), { env, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
            : spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

        const summary: RunResult = { text: "", sessionId: opts.sessionId ?? null, inputTokens: 0, outputTokens: 0, isError: false };
        let stdoutBuf = "";
        let stderrBuf = "";

        child.on("error", (err) => reject(err));
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (adapter.mode === "plain" || !adapter.parseLine) {
                // Plain adapters stream raw stdout as it arrives; the full text is the answer.
                summary.text += chunk;
                if (onText) onText(chunk);
                return;
            }
            stdoutBuf += chunk;
            let nl: number;
            while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
                const line = stdoutBuf.slice(0, nl);
                stdoutBuf = stdoutBuf.slice(nl + 1);
                const ev = adapter.parseLine(line);
                if (!ev) continue;
                if (ev.kind === "init" && ev.sessionId) summary.sessionId = ev.sessionId;
                else if (ev.kind === "text") { summary.text += ev.text; if (onText) onText(ev.text); }
                else if (ev.kind === "result") {
                    if (ev.text && !summary.text) summary.text = ev.text;
                    if (ev.sessionId) summary.sessionId = ev.sessionId;
                    summary.inputTokens = ev.inputTokens;
                    summary.outputTokens = ev.outputTokens;
                    summary.isError = ev.isError;
                    summary.errorMessage = ev.errorMessage;
                }
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => { stderrBuf += chunk; });
        child.on("close", (code) => {
            if (adapter.mode === "plain") summary.text = summary.text.trim();
            if (summary.inputTokens === 0) summary.inputTokens = estimateTokens(prompt);
            if (summary.outputTokens === 0) summary.outputTokens = estimateTokens(summary.text);
            if (code !== 0 && !summary.text && !summary.isError) {
                summary.isError = true;
                summary.errorMessage = stderrBuf.trim() || `${toolName} exited with code ${code}`;
            }
            resolve(summary);
        });

        if (stdin !== null) { child.stdin.write(stdin); child.stdin.end(); }
        else child.stdin.end();
    });
}

/** Parameters for a one-shot in-process completion (used by the dashboard playground). */
export interface CompleteParams {
    model?: string | null;
    /** Default backend when the model does not name one. */
    tool?: string;
    system?: string | null;
    messages?: ChatMessage[];
    prompt?: string;
    enableTools?: boolean;
    /** Images for the current turn (Claude Code only). */
    images?: ImageBlock[];
    /** Run under a specific account, a profile's mapping, or a pack's isolated context. */
    account?: string | null;
    profile?: string | null;
    pack?: string | null;
}

/** Normalized result of a one-shot completion, agent-agnostic. */
export interface CompleteResult {
    tool: string;
    model: string;
    text: string;
    inputTokens: number;
    outputTokens: number;
    sessionId: string | null;
    isError: boolean;
    errorMessage?: string;
}

/**
 * Run a single completion in-process (no HTTP), routing to the agent adapter selected by
 * `model` (default `tool`). Used by the dashboard playground so it can drive the real local
 * agent without a separate `enigma api` process. Rejects only when the agent cannot be spawned.
 */
export async function completeOnce(params: CompleteParams): Promise<CompleteResult> {
    const model = params.model || DEFAULT_MODEL;
    const adapter = resolveAdapter(model, params.tool || "claude");
    const { prompt, system } = params.messages
        ? messagesToPrompt(params.messages)
        : { prompt: params.prompt || "", system: params.system ?? null };
    const images = params.images ?? (params.messages ? extractImages(params.messages) : undefined);
    const result = await runAgent(adapter, prompt, { model, system: params.system ?? system, sessionId: null, enableTools: params.enableTools === true, images, account: params.account, profile: params.profile, pack: params.pack });
    return { tool: adapter.tool, model, ...result };
}

/** Windows arg quoting for the shell path (mirrors accounts.ts, kept local to stay standalone). */
function quoteWinArg(arg: string): string {
    if (arg === "") return "\"\"";
    if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\"\"")}"`;
}

// --- HTTP layer -------------------------------------------------------------

interface SessionRecord { createdAt: number; lastAccessed: number; messageCount: number }
const sessions = new Map<string, SessionRecord>();

function touchSession(id: string | null, turns: number): void {
    if (!id) return;
    const now = Date.now();
    const rec = sessions.get(id);
    if (rec) { rec.lastAccessed = now; rec.messageCount += turns; }
    else sessions.set(id, { createdAt: now, lastAccessed: now, messageCount: turns });
}

function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
}

function apiError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
    sendJson(res, status, { error: { message, type, code: null, param: null } });
}

/** Model catalog aggregated across every installed agent (Claude Code, Codex, OpenCode). */
function modelsPayload(): unknown {
    const created = Math.floor(Date.now() / 1000);
    const data = availableAdapters().flatMap((a) => a.models.map((id) => ({ id, object: "model", created, owned_by: a.tool })));
    return { object: "list", data };
}

/** Bearer-token check when an API key is configured; always true when open (loopback). */
function authorized(req: IncomingMessage, apiKey: string | null): boolean {
    if (!apiKey) return true;
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.headers["x-api-key"] as string | undefined);
    return token === apiKey;
}

/** Server-wide defaults for the backing context, overridable per request. */
interface ServerDefaults { tool: string; account?: string | null; profile?: string | null; pack?: string | null }

/** Merge the per-request account/profile/pack over the server defaults (request wins). */
function contextOf(body: Record<string, unknown>, defaults: ServerDefaults): Pick<CompletionOptions, "account" | "profile" | "pack"> {
    return {
        account: (typeof body.account === "string" ? body.account : null) ?? defaults.account ?? null,
        profile: (typeof body.profile === "string" ? body.profile : null) ?? defaults.profile ?? null,
        pack: (typeof body.pack === "string" ? body.pack : null) ?? defaults.pack ?? null,
    };
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, defaults: ServerDefaults): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return apiError(res, 400, "Invalid JSON body."); }
    const messages = body.messages as ChatMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) return apiError(res, 400, "'messages' must be a non-empty array.");

    const { prompt, system } = messagesToPrompt(messages);
    const model = (body.model as string) || DEFAULT_MODEL;
    const adapter = resolveAdapter(model, defaults.tool);
    const opts: CompletionOptions = { model, system, sessionId: (body.session_id as string) ?? null, enableTools: body.enable_tools === true, images: extractImages(messages), ...contextOf(body, defaults) };
    const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(streamChunk(id, model, { role: "assistant" }));
        try {
            const result = await runAgent(adapter, prompt, opts, (t) => res.write(streamChunk(id, model, { content: t })));
            touchSession(result.sessionId, messages.length + 1);
            if (result.isError) res.write(streamChunk(id, model, { content: `\n[error] ${result.errorMessage ?? "unknown error"}` }));
            const includeUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
            const finalPayload: Record<string, unknown> = {
                id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
            if (includeUsage) finalPayload.usage = { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens };
            res.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
            res.write("data: [DONE]\n\n");
        } catch (err) {
            res.write(streamChunk(id, model, { content: `\n[error] ${(err as Error).message}` }, "stop"));
            res.write("data: [DONE]\n\n");
        }
        res.end();
        return;
    }

    try {
        const result = await runAgent(adapter, prompt, opts);
        touchSession(result.sessionId, messages.length + 1);
        if (result.isError) return apiError(res, 502, result.errorMessage ?? `${adapter.tool} returned an error.`, "api_error");
        sendJson(res, 200, {
            id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
            usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens },
            system_fingerprint: result.sessionId ? `session_${result.sessionId}` : null,
        });
    } catch (err) {
        apiError(res, 502, (err as Error).message, "api_error");
    }
}

async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse, defaults: ServerDefaults): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return apiError(res, 400, "Invalid JSON body."); }
    const rawMessages = body.messages as ChatMessage[] | undefined;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return apiError(res, 400, "'messages' must be a non-empty array.");
    const system = typeof body.system === "string" ? (body.system as string) : null;
    const { prompt } = messagesToPrompt(rawMessages);
    const model = (body.model as string) || DEFAULT_MODEL;
    const adapter = resolveAdapter(model, defaults.tool);
    const opts: CompletionOptions = { model, system, enableTools: body.enable_tools === true, images: extractImages(rawMessages), ...contextOf(body, defaults) };
    const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        try {
            const result = await runAgent(adapter, prompt, opts, (t) => send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }));
            send("content_block_stop", { type: "content_block_stop", index: 0 });
            send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: result.outputTokens } });
            send("message_stop", { type: "message_stop" });
        } catch (err) {
            send("error", { type: "error", error: { type: "api_error", message: (err as Error).message } });
        }
        res.end();
        return;
    }

    try {
        const result = await runAgent(adapter, prompt, opts);
        if (result.isError) return apiError(res, 502, result.errorMessage ?? `${adapter.tool} returned an error.`, "api_error");
        sendJson(res, 200, {
            id, type: "message", role: "assistant", model,
            content: [{ type: "text", text: result.text }],
            stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
        });
    } catch (err) {
        apiError(res, 502, (err as Error).message, "api_error");
    }
}

/** Options for the local API server. */
export interface ApiServerOptions {
    port: number;
    apiKey?: string | null;
    tool?: string;
    /** Default context for every request (overridable per request via account/profile/pack). */
    account?: string | null;
    profile?: string | null;
    pack?: string | null;
}

/** Result of a started server: the bound URL/port and a close handle. */
export interface RunningApi { url: string; port: number; close: () => void }

/**
 * Start the loopback OpenAI-compatible API server. Resolves once it is listening. Each request
 * is routed by its `model` field to the matching agent adapter (default: `tool`), so the one
 * server can back Claude Code, Codex and OpenCode concurrently.
 */
export function startApiServer(options: ApiServerOptions): Promise<RunningApi> {
    const apiKey = options.apiKey?.trim() || null;
    const defaultTool = options.tool || "claude";
    const defaults: ServerDefaults = { tool: defaultTool, account: options.account ?? null, profile: options.profile ?? null, pack: options.pack ?? null };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
            const path = (req.url || "").split("?")[0] || "/";
            const method = req.method || "GET";
            try {
                const defaultContext = { account: defaults.account, profile: defaults.profile, pack: defaults.pack };
                if (method === "GET" && path === "/health") return sendJson(res, 200, { status: "ok", service: "enigma-api", defaultBackend: defaultTool, agents: availableAdapters().map((a) => a.tool), defaultContext });
                if (method === "GET" && (path === "/" || path === "/v1")) {
                    return sendJson(res, 200, { service: "enigma local agent API", endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models", "/v1/sessions", "/health"], defaultBackend: defaultTool, agents: availableAdapters().map((a) => a.tool), defaultContext, authenticated: Boolean(apiKey) });
                }
                if (method === "GET" && path === "/v1/models") return sendJson(res, 200, modelsPayload());
                // Everything below requires auth when a key is set.
                if (!authorized(req, apiKey)) return apiError(res, 401, "Missing or invalid API key.", "authentication_error");
                if (method === "GET" && path === "/v1/sessions") {
                    const list = Array.from(sessions.entries()).map(([sid, r]) => ({ session_id: sid, created_at: r.createdAt, last_accessed: r.lastAccessed, message_count: r.messageCount }));
                    return sendJson(res, 200, { sessions: list, total: list.length });
                }
                if (method === "DELETE" && path.startsWith("/v1/sessions/")) {
                    const sid = decodeURIComponent(path.slice("/v1/sessions/".length));
                    const existed = sessions.delete(sid);
                    return sendJson(res, existed ? 200 : 404, { deleted: existed, session_id: sid });
                }
                if (method === "POST" && path === "/v1/chat/completions") return await handleChatCompletions(req, res, defaults);
                if (method === "POST" && path === "/v1/messages") return await handleAnthropicMessages(req, res, defaults);
                apiError(res, 404, `No route for ${method} ${path}.`, "not_found");
            } catch (err) {
                if (!res.headersSent) apiError(res, 500, (err as Error).message, "api_error");
                else try { res.end(); } catch { /* already closed */ }
            }
        })();
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ url: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); } catch { /* */ } } });
        });
    });
}
