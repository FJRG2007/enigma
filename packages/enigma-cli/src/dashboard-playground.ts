/**
 * Bridge for the dashboard's API playground: a tester for the local OpenAI-compatible API
 * (`enigma api`). It lets the browser send a chat request in either the OpenAI
 * (`/v1/chat/completions`) or Anthropic (`/v1/messages`) shape, choose the backing agent by
 * model, optionally set an auth key, and see the response. Two modes:
 *   - "inproc": run the completion in-process via the shared adapters (no `enigma api` process
 *     needed, no CORS) and shape the reply into the requested format.
 *   - "http": forward the request to a running server (default the local `enigma api`), so the
 *     real endpoint + its auth are exercised. The target is restricted to loopback hosts.
 * Imported dynamically by dashboard.ts. Never logs or stores the auth key.
 */
import { PACKS, isPackInstalled } from "./packs";
import { availableAdapters } from "./api-agents";
import { request as httpRequest } from "node:http";
import { readConfig, setEnigmaValue } from "./config";
import { listAccounts, listProfiles } from "./accounts";
import { completeOnce, type CompleteResult } from "./api-server";

/** Info for populating the playground UI: agents, models, accounts, profiles, packs, port. */
export interface PlaygroundInfo {
    agents: string[];
    models: Array<{ tool: string; models: string[] }>;
    accounts: Array<{ tool: string; name: string }>;
    profiles: string[];
    packs: Array<{ id: string; label: string; installed: boolean }>;
    apiPort: number;
    /** The persisted default context the `enigma api` server runs under (settable here). */
    defaults: { account: string; profile: string; pack: string };
}

export function playgroundInfo(): PlaygroundInfo {
    const adapters = availableAdapters();
    const cfg = readConfig().config;
    const accounts = adapters.flatMap((a) => listAccounts(a.tool).map((acc) => ({ tool: a.tool, name: acc.name })));
    return {
        agents: adapters.map((a) => a.tool),
        models: adapters.map((a) => ({ tool: a.tool, models: a.models })),
        accounts,
        profiles: listProfiles().map((p) => p.name),
        packs: PACKS.map((p) => ({ id: p.id, label: p.label, installed: isPackInstalled(p.id) })),
        apiPort: cfg.apiPort || 8000,
        defaults: { account: cfg.apiAccount || "", profile: cfg.apiProfile || "", pack: cfg.apiPack || "" },
    };
}

/** Persist the default API context (account/profile/pack) globally; empty values clear a field. */
export function setApiDefaults(d: { account?: string; profile?: string; pack?: string }): { ok: boolean; defaults: { account: string; profile: string; pack: string } } {
    setEnigmaValue("apiAccount", typeof d.account === "string" ? d.account : "", "global");
    setEnigmaValue("apiProfile", typeof d.profile === "string" ? d.profile : "", "global");
    setEnigmaValue("apiPack", typeof d.pack === "string" ? d.pack : "", "global");
    const cfg = readConfig().config;
    return { ok: true, defaults: { account: cfg.apiAccount || "", profile: cfg.apiProfile || "", pack: cfg.apiPack || "" } };
}

/** A request from the playground form. */
export interface PlaygroundRequest {
    mode?: "inproc" | "http";
    format?: "openai" | "anthropic";
    model?: string;
    system?: string;
    message?: string;
    enableTools?: boolean;
    /** An attached image as a data URL (data:image/...;base64,...) to send with the message. */
    imageDataUrl?: string;
    /** Run under a specific account, a profile's mapping, or a pack's isolated context. */
    account?: string;
    profile?: string;
    pack?: string;
    /** http mode only: target server base URL (loopback only) and optional bearer key. */
    baseUrl?: string;
    apiKey?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "enigma", "::1", "0.0.0.0"]);

/** The endpoint path for a given API format. */
export function formatPath(format: string): string {
    return format === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
}

/** Parse a data URL into an Anthropic base64 image source, or null. */
function dataUrlToAnthropicImage(url: string): { type: "image"; source: { type: "base64"; media_type: string; data: string } } | null {
    const m = /^data:([^;]+);base64,(.+)$/i.exec(url);
    return m ? { type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } } : null;
}

/** Build the user-turn content for a format: a plain string, or a parts array when an image is attached. */
function userContent(message: string, imageDataUrl: string | undefined, format: string): unknown {
    if (!imageDataUrl) return message;
    if (format === "anthropic") {
        const img = dataUrlToAnthropicImage(imageDataUrl);
        return img ? [{ type: "text", text: message }, img] : message;
    }
    return [{ type: "text", text: message }, { type: "image_url", image_url: { url: imageDataUrl } }];
}

/** Build the request body a client would send for the chosen format. */
export function buildRequestBody(req: PlaygroundRequest): Record<string, unknown> {
    const model = req.model || "claude";
    const content = userContent(req.message || "", req.imageDataUrl, req.format || "openai");
    if (req.format === "anthropic") {
        const body: Record<string, unknown> = { model, max_tokens: 4096, messages: [{ role: "user", content }] };
        if (req.system) body.system = req.system;
        if (req.enableTools) body.enable_tools = true;
        applyContext(body, req);
        return body;
    }
    const messages: Array<{ role: string; content: unknown }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content });
    const body: Record<string, unknown> = { model, messages };
    if (req.enableTools) body.enable_tools = true;
    applyContext(body, req);
    return body;
}

/** Fold the account/profile/pack context into a request body when set (enigma extension fields). */
function applyContext(body: Record<string, unknown>, req: PlaygroundRequest): void {
    if (req.account) body.account = req.account;
    if (req.profile) body.profile = req.profile;
    if (req.pack) body.pack = req.pack;
}

/** Shape an in-process result into the OpenAI or Anthropic response envelope. */
export function shapeResult(result: CompleteResult, format: string): Record<string, unknown> {
    if (format === "anthropic") {
        return {
            id: `msg_${Date.now().toString(36)}`,
            type: "message",
            role: "assistant",
            model: result.model,
            content: [{ type: "text", text: result.text }],
            stop_reason: "end_turn",
            usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
        };
    }
    return {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: "chat.completion",
        model: result.model,
        choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
        usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens },
    };
}

/** Build an equivalent curl command for the request, so the user can reproduce it in a terminal. */
export function buildCurl(baseUrl: string, format: string, body: Record<string, unknown>, apiKey?: string): string {
    const url = `${baseUrl.replace(/\/$/, "")}${formatPath(format)}`;
    const parts = [`curl ${url}`, "-H 'Content-Type: application/json'"];
    if (apiKey) parts.push(`-H 'Authorization: Bearer ${apiKey}'`);
    // Truncate long base64 image data so the reproducible command stays readable.
    const serialized = JSON.stringify(body).replace(/(base64,)[A-Za-z0-9+/=]{40,}/g, "$1<base64 image data omitted>");
    parts.push(`-d '${serialized}'`);
    return parts.join(" \\\n  ");
}

/** True when a base URL points at a loopback host (the only targets the playground allows). */
export function isLoopbackTarget(baseUrl: string): boolean {
    try {
        const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
        return LOOPBACK_HOSTS.has(host);
    } catch {
        return false;
    }
}

/** POST a JSON body to a loopback API server and return its raw + parsed response. */
function forwardHttp(baseUrl: string, format: string, body: Record<string, unknown>, apiKey?: string): Promise<{ status: number; raw: string; json: unknown }> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try { target = new URL(formatPath(format), baseUrl); } catch { reject(new Error("Invalid base URL.")); return; }
        const payload = JSON.stringify(body);
        const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
        if (apiKey) { headers.authorization = `Bearer ${apiKey}`; headers["x-api-key"] = apiKey; }
        const upReq = httpRequest({ hostname: target.hostname, port: target.port || 80, path: target.pathname, method: "POST", headers }, (upRes) => {
            const chunks: Buffer[] = [];
            upRes.on("data", (c: Buffer) => chunks.push(c));
            upRes.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                let json: unknown = null;
                try { json = JSON.parse(raw); } catch { /* leave raw */ }
                resolve({ status: upRes.statusCode || 0, raw, json });
            });
        });
        upReq.on("error", (err) => reject(err));
        upReq.end(payload);
    });
}

/** Response returned to the playground UI. */
export interface PlaygroundResponse {
    ok: boolean;
    error?: string;
    mode: string;
    format: string;
    tool?: string;
    status?: number;
    text?: string;
    response?: unknown;
    usage?: { input: number; output: number };
    curl: string;
}

/**
 * Run a playground request. In "inproc" mode it drives the local agent directly and shapes the
 * reply; in "http" mode it forwards to the running server (loopback only) and returns its
 * response. The curl equivalent is always included so the call is reproducible in a terminal.
 */
export async function runPlayground(req: PlaygroundRequest): Promise<PlaygroundResponse> {
    const format = req.format === "anthropic" ? "anthropic" : "openai";
    const mode = req.mode === "http" ? "http" : "inproc";
    const body = buildRequestBody(req);
    const baseUrl = req.baseUrl && req.baseUrl.trim() ? req.baseUrl.trim() : `http://127.0.0.1:${readConfig().config.apiPort || 8000}`;
    const curl = buildCurl(baseUrl, format, body, mode === "http" ? req.apiKey : undefined);

    if (!req.message || !req.message.trim()) return { ok: false, error: "Enter a message to send.", mode, format, curl };

    if (mode === "http") {
        if (!isLoopbackTarget(baseUrl)) return { ok: false, error: "The playground only calls loopback servers (127.0.0.1 / localhost / enigma).", mode, format, curl };
        try {
            const out = await forwardHttp(baseUrl, format, body, req.apiKey);
            const text = extractText(out.json, format);
            return { ok: out.status >= 200 && out.status < 300, status: out.status, mode, format, text, response: out.json ?? out.raw, curl, error: out.status >= 400 ? `Server returned ${out.status}. Is 'enigma api' running on ${baseUrl}?` : undefined };
        } catch (err) {
            return { ok: false, error: `Could not reach ${baseUrl}: ${(err as Error).message}. Start it with 'enigma api'.`, mode, format, curl };
        }
    }

    try {
        const content = userContent(req.message || "", req.imageDataUrl, "openai") as import("./api-server").ChatMessage["content"];
        const result = await completeOnce({ model: req.model, system: req.system, messages: [{ role: "user", content }], enableTools: req.enableTools, account: req.account, profile: req.profile, pack: req.pack });
        const response = shapeResult(result, format);
        return {
            ok: !result.isError,
            error: result.isError ? (result.errorMessage || `${result.tool} returned an error.`) : undefined,
            mode, format, tool: result.tool, text: result.text, response, curl,
            usage: { input: result.inputTokens, output: result.outputTokens },
        };
    } catch (err) {
        return { ok: false, error: (err as Error).message, mode, format, curl };
    }
}

/** Pull the assistant text out of an OpenAI or Anthropic response body for a quick preview. */
function extractText(json: unknown, format: string): string {
    if (!json || typeof json !== "object") return "";
    const obj = json as Record<string, unknown>;
    if (format === "anthropic") {
        const content = obj.content as Array<{ text?: string }> | undefined;
        return Array.isArray(content) ? content.map((c) => c.text || "").join("") : "";
    }
    const choices = obj.choices as Array<{ message?: { content?: string } }> | undefined;
    return choices?.[0]?.message?.content || "";
}
