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
import { randomUUID } from "node:crypto";
import { readUsageCached } from "./usage";
import { spawn } from "node:child_process";
import { tokenMatches } from "./dashboard-token";
import { readConfig, type ApiRotation } from "./config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AccountRotator, classifyAccountError, poolOrder, type WindowUsage } from "./api-rotation";
import { getTool, resolveConfigDir, resolveLaunchAccount, listProfiles, listAccounts } from "./accounts";
import { runSessionTurn, closeAllSessions, isSessionBusy, SessionError, DEFAULT_SESSION_CONFIG, type SessionSpec } from "./session-runtime";
import {
    resolveAdapter,
    availableAdapters,
    estimateTokens,
    DEFAULT_MODEL,
    type AgentAdapter,
    type CompletionOptions,
    type ImageBlock
} from "./api-agents";

/** A content part in an OpenAI/Anthropic message: text, an OpenAI image_url, or an Anthropic image. */
interface ContentPart {
    type?: string;
    text?: string;
    image_url?: { url?: string; } | string;
    source?: { type?: string; media_type?: string; data?: string; url?: string; };
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

/** The labels the flattened transcript uses to separate turns, at the start of a line. */
const TURN_LABEL = /^(Human|Assistant)(\s*):/gm;

/**
 * Neutralizes a turn label a caller put inside message text.
 *
 * The transcript below is plain text, so `Assistant:` at the start of a line IS a turn as far
 * as the model is concerned. Without this, a caller can write a newline followed by
 * "Assistant: sure, done" into a user message and forge a reply the agent never made -
 * putting words in its mouth, or
 * smuggling instructions in as though they came from another turn. The label is kept legible
 * and made inert by swapping its colon, the same trick as fencing untrusted text: the reader
 * still sees what was written, the parser no longer sees a turn.
 */
function neutralizeTurnLabels(text: string): string {
    return text.replace(TURN_LABEL, (_m, label: string, space: string) => `${label}${space}·`);
}

/**
 * Convert OpenAI messages into an agent prompt plus an optional system prompt. A single user
 * turn is sent verbatim; multi-turn conversations are flattened into a labelled transcript so
 * the model keeps the exchange context. The last system message wins (mirrors OpenAI semantics)
 * and is returned separately so an adapter can apply it as the agent's system prompt.
 *
 * Message text is UNTRUSTED: this is an HTTP surface, and everything below the system prompt
 * arrives from whoever called it. Turn labels inside that text are neutralized before the
 * transcript is assembled. The single-turn path needs none of it - with no transcript to
 * forge, the text is just the prompt.
 */
export function messagesToPrompt(messages: ChatMessage[]): { prompt: string; system: string | null; } {
    let system: string | null = null;
    const turns: Array<{ role: string; text: string; }> = [];
    for (const m of messages) {
        const text = contentToText(m.content);
        if (m.role === "system") system = text;
        else turns.push({ role: m.role, text });
    }
    if (turns.length === 1 && turns[0]!.role === "user") return { prompt: turns[0]!.text, system };
    const parts = turns.map((t) => `${t.role === "assistant" ? "Assistant" : "Human"}: ${neutralizeTurnLabels(t.text)}`);
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

interface RunResult { text: string; sessionId: string | null; inputTokens: number; outputTokens: number; isError: boolean; errorMessage?: string; }

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

async function runAgent(adapter: AgentAdapter, prompt: string, opts: CompletionOptions, onText?: (t: string) => Promise<void> | void): Promise<RunResult> {
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
        // What the incremental deltas have delivered for the assistant turn in progress, so the
        // closing full-text block can contribute only what they missed. Reset at the end of a turn.
        let streamedTurn = "";
        // The consumer's latest backpressure signal. Token-level streaming is one frame per token,
        // so an HTTP consumer that cannot keep up would otherwise be absorbed by Node's socket
        // buffer; when `onText` reports it is saturated the agent's stdout is paused until it drains.
        let saturated: Promise<void> | null = null;

        /** Forward answer text to the consumer, honoring the backpressure it reports. */
        const emit = (text: string): void => {
            if (!onText) return;
            const wait = onText(text);
            if (!wait) return;
            if (!saturated) child.stdout.pause();
            saturated = wait;
            const resume = (): void => {
                if (saturated !== wait) return;
                saturated = null;
                child.stdout.resume();
            };
            void wait.then(resume, resume);
        };

        child.on("error", (err) => reject(err));
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (adapter.mode === "plain" || !adapter.parseLine) {
                // Plain adapters stream raw stdout as it arrives; the full text is the answer.
                summary.text += chunk;
                emit(chunk);
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
                else if (ev.kind === "text") { summary.text += ev.text; streamedTurn += ev.text; emit(ev.text); }
                // Full assistant-turn text. While streaming, the `text` deltas above already delivered
                // what they covered, so only the REMAINDER is emitted - everything when the turn
                // produced no deltas at all (a CLI that accepts --include-partial-messages without
                // emitting partials, or a locally synthesized assistant notice), nothing when they
                // covered the turn. Without streaming it is the whole answer.
                else if (ev.kind === "text_final") {
                    const streamed = opts.stream ? streamedTurn : "";
                    streamedTurn = "";
                    const rest = ev.text.startsWith(streamed) ? ev.text.slice(streamed.length) : "";
                    if (rest) { summary.text += rest; emit(rest); }
                }
                else if (ev.kind === "result") {
                    // Last resort: the run carried an answer no assistant message ever delivered.
                    // It has to reach the consumer too, or a streamed response ends up empty.
                    if (ev.text && !summary.text) { summary.text = ev.text; emit(ev.text); }
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
    /** The account that served the request when rotation picked it (null = a fixed context). */
    account?: string | null;
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
    const messages = params.messages ?? [{ role: "user", content: prompt }];
    // Same resolution as the server: an explicit context wins, else the configured rotation, else
    // the saved defaults - so the playground shows which account `enigma api` would use.
    const defaults = configDefaults(params.tool || "claude");
    const explicit = { account: params.account || null, profile: params.profile || null, pack: params.pack || null };
    const picked = explicit.account || explicit.profile || explicit.pack ? { ctx: explicit, rotated: null } : pickContext(adapter.tool, null, defaults);
    const opts: CompletionOptions = { model, system: params.system ?? system, sessionId: null, enableTools: params.enableTools === true, images, ...picked.ctx };
    const result = await driveRotating(adapter, messages, prompt, opts, defaults, picked.rotated);
    return { tool: adapter.tool, model, ...result, account: result.account ?? null };
}

/** Windows arg quoting for the shell path (mirrors accounts.ts, kept local to stay standalone). */
function quoteWinArg(arg: string): string {
    if (arg === "") return "\"\"";
    if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\"\"")}"`;
}

// --- HTTP layer -------------------------------------------------------------

interface SessionRecord { createdAt: number; lastAccessed: number; messageCount: number; }
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

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
}

function apiError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
    sendJson(res, status, { error: { message, type, code: null, param: null } });
}

/**
 * Write one SSE frame, returning a promise ONLY when the socket buffer is already full.
 *
 * Token-level streaming sends one frame per token, so a consumer that reads slower than the agent
 * writes would otherwise be absorbed silently by Node's socket buffer - the whole answer held in
 * memory with nothing slowing the agent down. `runAgent` pauses the agent's stdout until the
 * returned promise resolves. A closed response resolves it too, so a disconnect never wedges a run.
 */
const drainWaiters = new WeakMap<ServerResponse, Promise<void>>();

function writeSse(res: ServerResponse, frame: string): Promise<void> | void {
    if (res.write(frame)) return;
    // One waiter per response, shared by every write that finds the buffer full: the frames
    // already parsed out of the current stdout chunk all land here, and a listener pair per frame
    // would trip the max-listeners warning and leak until the first drain.
    const pending = drainWaiters.get(res);
    if (pending) return pending;
    const wait = new Promise<void>((resolve) => {
        const done = (): void => {
            res.off("drain", done);
            res.off("close", done);
            drainWaiters.delete(res);
            resolve();
        };
        res.once("drain", done);
        res.once("close", done);
    });
    drainWaiters.set(res, wait);
    return wait;
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
    // Constant-time: a plain `===` stops at the first differing byte and leaks the key through timing.
    return tokenMatches(apiKey, token);
}

/** Server-wide defaults for the backing context, overridable per request. */
interface ServerDefaults {
    tool: string;
    account?: string | null;
    profile?: string | null;
    pack?: string | null;
    /** Picks an account per request when the caller names none; strategy "off" = the fixed defaults. */
    rotator: AccountRotator;
    /** Whether a caller may pick account/profile/pack per request. */
    clientContext: boolean;
}

type ContextFields = Pick<CompletionOptions, "account" | "profile" | "pack">;

/** An error carrying the HTTP status a handler should surface (client mistakes, not agent faults). */
class RequestError extends Error {
    constructor(public status: number, message: string, public apiType = "invalid_request_error") { super(message); }
}

/** A non-empty string field of the request body, trimmed, or null. */
function bodyString(body: Record<string, unknown>, key: string): string | null {
    const v = body[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Resolve the context one request runs under. Order: the caller's own account/profile/pack (when
 * the server lets callers choose), then the rotation (an account picked from the pool, sticky per
 * warm session), then the server defaults, then the active account. A request that names a
 * context on a server that does not allow it is refused rather than silently rerouted.
 */
function contextOf(body: Record<string, unknown>, defaults: ServerDefaults, tool: string): { ctx: ContextFields; rotated: string | null; } {
    const asked = { account: bodyString(body, "account"), profile: bodyString(body, "profile"), pack: bodyString(body, "pack") };
    if (asked.account || asked.profile || asked.pack) {
        if (!defaults.clientContext) throw new RequestError(403, "This server picks the account itself: remove account/profile/pack from the request, or allow it with 'enigma config api-client-context on'.", "permission_error");
        return { ctx: asked, rotated: null };
    }
    return pickContext(tool, typeof body.session_id === "string" ? body.session_id : null, defaults);
}

/** A tool's account names (a registry read plus one small file per account - fine per request). */
function accountNames(tool: string): string[] {
    return listAccounts(tool).map((a) => a.name);
}

/** The rotation's pick, or the fixed defaults when rotation is off or the pool has no account of this tool. */
function pickContext(tool: string, sessionId: string | null, defaults: ServerDefaults): { ctx: ContextFields; rotated: string | null; } {
    const fixed = { ctx: { account: defaults.account ?? null, profile: defaults.profile ?? null, pack: defaults.pack ?? null }, rotated: null };
    const rotator = defaults.rotator;
    if (!rotator.enabled) return fixed;
    const names = accountNames(tool);
    // A warm session lives in one account's config dir, so its later turns stay on that login.
    const bound = sessionId ? rotator.sessionAccount(sessionId) : undefined;
    if (bound && names.includes(bound)) return { ctx: { account: bound, profile: null, pack: null }, rotated: bound };
    if (!poolOrder(names, rotator.pool).length) return fixed;
    const account = rotator.pick(tool, names);
    if (!account) {
        const next = rotator.snapshot().cooldowns.filter((c) => c.tool === tool).reduce((min, c) => Math.min(min, c.until), Infinity);
        const when = Number.isFinite(next) ? ` The first one is free again at ${new Date(next).toISOString()}.` : "";
        throw new RequestError(429, `Every ${tool} account in the rotation is cooling down after a usage limit or a failed login.${when}`, "rate_limit_error");
    }
    return { ctx: { account, profile: null, pack: null }, rotated: account };
}

/**
 * Drive a request and, when the rotation picked its account, fail over on an account-level fault
 * (a usage limit or a broken login): that account cools down and the request runs again on the
 * next pick. A retry only happens while nothing has reached the client yet, and never for a warm
 * session, whose thread lives in the first account's directory.
 */
async function driveRotating(adapter: AgentAdapter, messages: ChatMessage[], prompt: string, opts: CompletionOptions, defaults: ServerDefaults, rotated: string | null, onText?: (t: string) => Promise<void> | void): Promise<RunResult & { account?: string; }> {
    if (!rotated) return drive(adapter, messages, prompt, opts, onText);
    const rotator = defaults.rotator;
    const tool = adapter.tool;
    const tried = new Set<string>();
    let account = rotated;
    for (;;) {
        const end = rotator.begin(tool, account);
        // A limit notice arrives as answer text before the run's error result, so the opening text
        // is held back: if the run turns out to be an account fault, nothing has reached the client
        // and the request can move to the next account. Past HOLD_CHARS it is a real answer.
        let held = "";
        let flowing = false;
        const relay = onText ? (t: string): Promise<void> | void => {
            if (flowing) return onText(t);
            held += t;
            if (held.length < HOLD_CHARS) return;
            flowing = true;
            const out = held;
            held = "";
            return onText(out);
        } : undefined;
        let result: RunResult;
        try { result = await drive(adapter, messages, prompt, { ...opts, account, profile: null, pack: null }, relay); }
        catch (err) { end(0); throw err; }
        end(result.inputTokens + result.outputTokens);
        if (opts.sessionId && !result.isError) rotator.bindSession(opts.sessionId, account);
        const fault = result.isError ? classifyAccountError(result.errorMessage) : null;
        if (fault) {
            rotator.markFault(tool, account, fault, result.errorMessage);
            tried.add(account);
            const next = flowing || opts.sessionId ? null : rotator.pick(tool, accountNames(tool), tried);
            if (next) { account = next; continue; }
        }
        if (held && onText) await onText(held);
        return { ...result, account };
    }
}

/** How much opening answer text a rotated stream holds back before it is known not to be a limit notice. */
const HOLD_CHARS = 160;

/** The response header naming the account that served a rotated request. */
function accountHeader(account: string | undefined): Record<string, string> {
    return account ? { "x-enigma-account": account } : {};
}

/** Transcript-based window usage for least-used, read only when the user allowed reading transcripts. */
const transcriptUsage: WindowUsage = (tool, account) => {
    if (tool !== "claude" || !readConfig().config.usageStats) return { tokens: 0, asOf: 0 };
    const report = readUsageCached();
    return { tokens: report.accounts[account]?.windows.session.used ?? 0, asOf: report.generatedAt };
};

/** A rotator for a strategy and pool, ranking least-used by the transcript windows. */
export function createRotator(strategy: ApiRotation, pool: string[]): AccountRotator {
    return new AccountRotator(strategy, pool, transcriptUsage);
}

let inprocRotator: AccountRotator | null = null;

/**
 * Defaults for in-process completions (the dashboard playground), from the saved config. The
 * rotator outlives the call so round-robin advances and cooldowns stick; a changed strategy or
 * pool replaces it.
 */
function configDefaults(tool: string): ServerDefaults {
    const cfg = readConfig().config;
    const pool = cfg.apiAccountPool ?? [];
    if (!inprocRotator || inprocRotator.strategy !== cfg.apiRotation || inprocRotator.pool.join(",") !== pool.join(",")) inprocRotator = createRotator(cfg.apiRotation, pool);
    return { tool, account: cfg.apiAccount || null, profile: cfg.apiProfile || null, pack: cfg.apiPack || null, rotator: inprocRotator, clientContext: true };
}

/** Claude Code's session ids are UUIDs, and `--session-id`/`--resume` reject anything else. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The newest user message's text - the only thing a warm session needs, since it holds the rest. */
export function lastUserText(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") return contentToText(messages[i]!.content);
    }
    return "";
}

/** Launch spec for a Claude Code session process, mirroring runAgent's binary/env resolution. */
async function buildClaudeSessionSpec(opts: CompletionOptions): Promise<SessionSpec> {
    const tool = getTool("claude");
    const cfg = readConfig().config;
    const dir = await resolveContextDir("claude", opts);
    const binary = process.env[tool.binEnv] || cfg.toolPaths?.claude || resolveBin(tool.bin) || tool.bin;
    const env = { ...process.env, ...tool.envFor(dir) };
    const useShell = process.platform === "win32" && !binary.toLowerCase().endsWith(".exe");
    // `dir` is the resolved isolation context: it binds the session id to this account/profile/pack.
    return { binary, env, model: opts.model, system: opts.system, enableTools: opts.enableTools === true, contextKey: dir, useShell };
}

/**
 * The client-side problem with this request's `session_id`, or null when there is none. Session
 * mode is Claude-only, so any other adapter ignores the field. Both handlers run this BEFORE a
 * streaming head is written, which is the only moment a real status code can still be sent.
 */
function sessionRequestError(adapter: AgentAdapter, opts: CompletionOptions): RequestError | null {
    if (!opts.sessionId || adapter.tool !== "claude") return null;
    if (!SESSION_UUID_RE.test(opts.sessionId)) return new RequestError(400, "session_id must be a UUID (omit it for a stateless request).");
    if (isSessionBusy(opts.sessionId)) return new RequestError(409, "session busy: a turn is already in progress for this session");
    return null;
}

/**
 * Route one request to the warm session runtime or a fresh stateless run - both return the same
 * RunResult shape. A `session_id` (a UUID) selects session mode: the caller sends only the newest
 * user message and the warm process holds the thread. Only Claude Code has the persistent
 * stream-json interface the warm runtime needs; other agents fall back to a stateless run that
 * carries the whole transcript. A session refusal (busy, wrong context, a turn that timed out)
 * arrives as a typed SessionError and becomes the matching status; the handlers run the same
 * up-front check before any streaming head, where that status can still be sent.
 */
async function drive(adapter: AgentAdapter, messages: ChatMessage[], prompt: string, opts: CompletionOptions, onText?: (t: string) => Promise<void> | void): Promise<RunResult> {
    if (opts.sessionId && adapter.tool === "claude") {
        const bad = sessionRequestError(adapter, opts);
        if (bad) throw bad;
        const spec = await buildClaudeSessionSpec(opts);
        try {
            return await runSessionTurn(spec, opts.sessionId, { prompt: lastUserText(messages), images: opts.images }, onText, DEFAULT_SESSION_CONFIG);
        } catch (err) {
            if (err instanceof SessionError) {
                const timedOut = err.code === "timeout";
                throw new RequestError(timedOut ? 504 : 409, err.message, timedOut ? "api_error" : "invalid_request_error");
            }
            throw err;
        }
    }
    return runAgent(adapter, prompt, opts, onText);
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
    let picked: ReturnType<typeof contextOf>;
    try { picked = contextOf(body, defaults, adapter.tool); }
    catch (err) { if (err instanceof RequestError) return apiError(res, err.status, err.message, err.apiType); throw err; }
    const opts: CompletionOptions = { model, system, sessionId: (body.session_id as string) ?? null, enableTools: body.enable_tools === true, stream: body.stream === true, images: extractImages(messages), ...picked.ctx };
    // A session problem has to fail before any streaming head is written, so check it up front:
    // afterwards the 200 is already on the wire and the client would read the error as content.
    const sessionProblem = sessionRequestError(adapter, opts);
    if (sessionProblem) return apiError(res, sessionProblem.status, sessionProblem.message, sessionProblem.apiType);
    const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(streamChunk(id, model, { role: "assistant" }));
        try {
            const result = await driveRotating(adapter, messages, prompt, opts, defaults, picked.rotated, (t) => writeSse(res, streamChunk(id, model, { content: t })));
            touchSession(result.sessionId, messages.length + 1);
            if (result.isError) res.write(streamChunk(id, model, { content: `\n[error] ${result.errorMessage ?? "unknown error"}` }));
            const includeUsage = (body.stream_options as { include_usage?: boolean; } | undefined)?.include_usage === true;
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
        const result = await driveRotating(adapter, messages, prompt, opts, defaults, picked.rotated);
        touchSession(result.sessionId, messages.length + 1);
        if (result.isError) return apiError(res, 502, result.errorMessage ?? `${adapter.tool} returned an error.`, "api_error");
        sendJson(res, 200, {
            id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
            usage: { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens },
            system_fingerprint: result.sessionId ? `session_${result.sessionId}` : null,
            session_id: result.sessionId,
        }, accountHeader(result.account));
    } catch (err) {
        if (err instanceof RequestError) return apiError(res, err.status, err.message, err.apiType);
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
    let picked: ReturnType<typeof contextOf>;
    try { picked = contextOf(body, defaults, adapter.tool); }
    catch (err) { if (err instanceof RequestError) return apiError(res, err.status, err.message, err.apiType); throw err; }
    const opts: CompletionOptions = { model, system, sessionId: (body.session_id as string) ?? null, enableTools: body.enable_tools === true, stream: body.stream === true, images: extractImages(rawMessages), ...picked.ctx };
    const sessionProblem = sessionRequestError(adapter, opts);
    if (sessionProblem) return apiError(res, sessionProblem.status, sessionProblem.message, sessionProblem.apiType);
    const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const send = (event: string, data: unknown): void => { res.write(frame(event, data)); };
        send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        try {
            const result = await driveRotating(adapter, rawMessages, prompt, opts, defaults, picked.rotated, (t) => writeSse(res, frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })));
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
        const result = await driveRotating(adapter, rawMessages, prompt, opts, defaults, picked.rotated);
        if (result.isError) return apiError(res, 502, result.errorMessage ?? `${adapter.tool} returned an error.`, "api_error");
        sendJson(res, 200, {
            id, type: "message", role: "assistant", model,
            content: [{ type: "text", text: result.text }],
            stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
            session_id: result.sessionId,
        }, accountHeader(result.account));
    } catch (err) {
        if (err instanceof RequestError) return apiError(res, err.status, err.message, err.apiType);
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
    /** Account rotation for requests that name no context (default "off"). */
    rotation?: ApiRotation;
    /** Accounts the rotation may use, in order; empty = every account of the tool. */
    pool?: string[];
    /** Whether callers may pick account/profile/pack per request (default true). */
    clientContext?: boolean;
}

/** Result of a started server: the bound URL/port and a close handle. */
export interface RunningApi { url: string; port: number; close: () => void; }

/**
 * Start the loopback OpenAI-compatible API server. Resolves once it is listening. Each request
 * is routed by its `model` field to the matching agent adapter (default: `tool`), so the one
 * server can back Claude Code, Codex and OpenCode concurrently.
 */
export function startApiServer(options: ApiServerOptions): Promise<RunningApi> {
    const apiKey = options.apiKey?.trim() || null;
    const defaultTool = options.tool || "claude";
    const defaults: ServerDefaults = {
        tool: defaultTool, account: options.account ?? null, profile: options.profile ?? null, pack: options.pack ?? null,
        rotator: createRotator(options.rotation ?? "off", options.pool ?? []), clientContext: options.clientContext !== false,
    };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
            const path = (req.url || "").split("?")[0] || "/";
            const method = req.method || "GET";
            try {
                const defaultContext = { account: defaults.account, profile: defaults.profile, pack: defaults.pack };
                if (method === "GET" && path === "/health") {
                    // Account names and cooldowns only go to a caller the server would serve.
                    const rotation = authorized(req, apiKey) ? { ...defaults.rotator.snapshot(), clientContext: defaults.clientContext } : { strategy: defaults.rotator.strategy };
                    return sendJson(res, 200, { status: "ok", service: "enigma-api", defaultBackend: defaultTool, agents: availableAdapters().map((a) => a.tool), defaultContext, rotation });
                }
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
            const port = (server.address() as { port: number; }).port;
            resolve({ url: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); } catch { /* */ } closeAllSessions(); } });
        });
    });
}
