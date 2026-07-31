/**
 * OpenCode backend: starts a persistent HTTP server via `opencode serve` and
 * drives it over REST with SSE streaming.
 *
 * Faithful port of the Go `internal/agent/opencode.go` plus its folded-in
 * companions `opencode_http.go`, `opencode_stream.go`, and `opencode_types.go`.
 * The server is started once per agent (synchronized), reused across Run calls,
 * and torn down on Close or a "connection refused" transient retry.
 *
 * Divergences (intentional):
 * - The Go `context.Context` is an `AbortSignal`; the concurrent send-message
 *   goroutine becomes a Promise whose settled state is polled exactly where Go
 *   used a non-blocking channel select.
 * - `claudeMaxRetries` (defined in the not-yet-ported claude backend) is
 *   replicated as a local constant so the retry budget matches the original.
 * - The factory wires PID tracking from the passed Paths (in Go the daemon does
 *   this once via SetServerPIDsDir); see createOpencode.
 */

import { Paths } from "../paths";
import { Config } from "../config";
import { doJSON } from "./rovodev";
import { AGENT_OPENCODE } from "../types";
import { setServerPIDsDir } from "./serverpid";
import { parseSSE, type SSEEvent } from "./sse";
import { runWithRetry, classifyTransient } from "./retry";
import { ManagedServer, getAvailablePort } from "./server";
import {
    type Agent,
    type Result,
    type Options,
    type RunOpts,
    type TokenUsage,
    addTokenUsage,
    emptyTokenUsage,
    finalizeTextResult
} from "./agent";

const claudeMaxRetries = 3;

// -- Wire types ---------------------------------------------------------------

interface OpencodeCache {
    read: number;
    write: number;
}

interface OpencodeTokens {
    input: number;
    output: number;
    cache?: OpencodeCache;
}

interface OpencodeOpenAI {
    phase?: string;
}

interface OpencodeMetadata {
    openai?: OpencodeOpenAI;
}

interface OpencodeMessageInfo {
    id?: string;
    role?: string;
    structured?: unknown;
    tokens?: OpencodeTokens;
}

interface OpencodeMessagePart {
    type?: string;
    text?: string;
    metadata?: OpencodeMetadata;
}

interface OpencodeMessageResponse {
    info?: OpencodeMessageInfo;
    parts?: OpencodeMessagePart[];
}

interface OpencodeEventPart {
    id?: string;
    messageID?: string;
    type?: string;
    text?: string;
    tokens?: OpencodeTokens;
    metadata?: OpencodeMetadata;
}

interface OpencodeEventInfo {
    id?: string;
    role?: string;
    tokens?: OpencodeTokens;
}

interface OpencodeStreamEventProperties {
    sessionID?: string;
    field?: string;
    delta?: string;
    partID?: string;
    part?: OpencodeEventPart;
    info?: OpencodeEventInfo;
}

interface OpencodeStreamEventPayload {
    type: string;
    properties?: OpencodeStreamEventProperties;
}

interface OpencodeStreamEvent {
    directory?: string;
    payload?: OpencodeStreamEventPayload;
}

/** Tracks accumulated text for a part ID during streaming. */
interface OpencodeTextPart {
    text: string;
    phase: string;
    messageID: string;
    emittedText: string;
}

function newTextPart(): OpencodeTextPart {
    return { text: "", phase: "", messageID: "", emittedText: "" };
}

// -- Usage helpers ------------------------------------------------------------

function opencodeTokensToUsage(t: OpencodeTokens): TokenUsage {
    const u = emptyTokenUsage();
    u.inputTokens = t.input;
    u.outputTokens = t.output;
    if (t.cache) {
        u.cacheReadTokens = t.cache.read;
        u.cacheCreationTokens = t.cache.write;
    }
    return u;
}

function accumulateUsage(byMsg: Map<string, TokenUsage>): TokenUsage {
    const total = emptyTokenUsage();
    for (const u of byMsg.values()) addTokenUsage(total, u);
    return total;
}

// -- Stream state -------------------------------------------------------------

/** Mutable state during SSE event processing. */
class OpencodeStreamState {
    readonly sessionID: string;
    readonly onChunk?: (text: string) => void;
    readonly textParts = new Map<string, OpencodeTextPart>();
    readonly textPartOrder: string[] = [];
    readonly usageByMsg = new Map<string, TokenUsage>();
    usage: TokenUsage = emptyTokenUsage();
    lastText = "";
    lastFinalText = "";
    readonly userMsgIDs = new Set<string>();
    readonly assistantMsgIDs = new Set<string>();
    readonly filteredPartIDs = new Set<string>();
    hasEmittedText = false;
    hadToolActivity = false;

    constructor(sessionID: string, onChunk?: (text: string) => void) {
        this.sessionID = sessionID;
        this.onChunk = onChunk;
    }

    emitSeparatorIfNeeded(): void {
        if (!this.hadToolActivity || !this.onChunk) return;
        if (this.hasEmittedText) this.onChunk("\n\n");
        this.hadToolActivity = false;
    }

    emitTextPartChunk(part: OpencodeTextPart, partID: string): void {
        if (!this.shouldEmitTextPart(part)) return;
        let chunk = "";
        if (part.text.startsWith(part.emittedText)) {
            chunk = part.text.slice(part.emittedText.length);
        } else if (part.text !== "") {
            chunk = part.text;
        }
        this.updateText(part.text, part.phase);
        if (this.onChunk && chunk !== "") {
            this.emitSeparatorIfNeeded();
            this.onChunk(chunk);
            this.hasEmittedText = true;
        }
        part.emittedText = part.text;
        this.textParts.set(partID, part);
    }

    shouldEmitTextPart(part: OpencodeTextPart): boolean {
        if (part.messageID === "") return false;
        if (this.userMsgIDs.has(part.messageID)) return false;
        return this.assistantMsgIDs.has(part.messageID);
    }

    dropMessageParts(messageID: string): void {
        for (const [partID, part] of this.textParts) {
            if (part.messageID === messageID) {
                this.markPartFiltered(partID);
                this.textParts.delete(partID);
            }
        }
    }

    emitBufferedMessageParts(messageID: string): void {
        for (const partID of this.textPartOrder) {
            const part = this.textParts.get(partID);
            if (part && part.messageID === messageID) this.emitTextPartChunk(part, partID);
        }
    }

    trackTextPart(partID: string): void {
        if (this.textPartOrder.includes(partID)) return;
        this.textPartOrder.push(partID);
    }

    markPartFiltered(partID: string): void {
        this.filteredPartIDs.add(partID);
    }

    updateText(text: string, phase: string): void {
        if (text.trim() === "") return;
        this.lastText = text;
        if (phase === "final_answer") this.lastFinalText = text;
    }
}

/** Processes the SSE stream from OpenCode's /global/event endpoint. */
async function parseOpencodeSSE(
    source: AsyncIterable<Uint8Array | string>,
    state: OpencodeStreamState
): Promise<void> {
    await parseSSE(source, (ev: SSEEvent): boolean => {
        if (ev.data === "") return true;

        let event: OpencodeStreamEvent;
        try {
            event = JSON.parse(ev.data) as OpencodeStreamEvent;
        } catch {
            return true; // skip malformed events
        }

        const payload = event.payload;
        if (!payload) return true;
        const props = payload.properties;

        // Filter by session ID.
        if (props && props.sessionID && props.sessionID !== state.sessionID) return true;

        switch (payload.type) {
            case "message.part.delta":
                if (props && props.field === "text" && props.partID && props.delta) {
                    if (state.filteredPartIDs.has(props.partID)) break;
                    let part = state.textParts.get(props.partID);
                    if (!part) {
                        part = newTextPart();
                        state.textParts.set(props.partID, part);
                        state.trackTextPart(props.partID);
                    }
                    part.text += props.delta;
                    state.emitTextPartChunk(part, props.partID);
                }
                break;

            case "message.part.updated":
                if (props && props.part) {
                    const p = props.part;
                    if (p.type === "text" && p.id) {
                        const phase = p.metadata?.openai?.phase ?? "";
                        let part = state.textParts.get(p.id);
                        if (!part) {
                            part = newTextPart();
                            state.textParts.set(p.id, part);
                            state.trackTextPart(p.id);
                        }
                        part.text = p.text ?? "";
                        part.phase = phase;
                        if (p.messageID) part.messageID = p.messageID;
                        if (part.messageID !== "" && state.userMsgIDs.has(part.messageID)) {
                            state.markPartFiltered(p.id);
                            state.textParts.delete(p.id);
                            break;
                        }
                        state.emitTextPartChunk(part, p.id);
                    }
                    if (p.type === "step-finish") {
                        state.hadToolActivity = true;
                        if (p.messageID && p.tokens) {
                            state.usageByMsg.set(p.messageID, opencodeTokensToUsage(p.tokens));
                            state.usage = accumulateUsage(state.usageByMsg);
                        }
                    }
                }
                break;

            case "message.updated":
                if (props && props.info) {
                    const info = props.info;
                    if (info.role === "user" && info.id) {
                        state.userMsgIDs.add(info.id);
                        state.dropMessageParts(info.id);
                    }
                    if (info.role === "assistant" && info.id) {
                        state.assistantMsgIDs.add(info.id);
                        state.emitBufferedMessageParts(info.id);
                    }
                    if (info.role === "assistant" && info.id && info.tokens) {
                        state.usageByMsg.set(info.id, opencodeTokensToUsage(info.tokens));
                        state.usage = accumulateUsage(state.usageByMsg);
                    }
                }
                break;

            case "session.idle":
                return false;
        }

        return true;
    });
}

// -- Agent --------------------------------------------------------------------

/**
 * Starts a persistent HTTP server via `opencode serve` and sends requests via
 * REST with SSE streaming.
 */
export class OpencodeAgent implements Agent {
    private readonly bin: string;
    private readonly extraArgs: string[];
    private server: ManagedServer | null = null;
    private starting: Promise<ManagedServer> | null = null;

    constructor(bin: string, extraArgs: string[]) {
        this.bin = bin;
        this.extraArgs = extraArgs;
    }

    name(): string {
        return "opencode";
    }

    async run(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        return runWithRetry(
            signal,
            "opencode",
            opts,
            claudeMaxRetries,
            classifyTransient,
            label => this.recoverTransientRetry(label),
            () => this.runOnce(opts, signal)
        );
    }

    private recoverTransientRetry(label: string): void {
        if (label !== "connection refused") return;
        const srv = this.server;
        this.server = null;
        this.starting = null;
        if (srv) void srv.shutdown();
    }

    private async runOnce(opts: RunOpts, signal: AbortSignal | undefined): Promise<Result> {
        const baseURL = await this.ensureServer(signal, opts.cwd);

        const sessionID = await this.createSession(signal, baseURL, opts.cwd);
        try {
            let prompt = opts.prompt;
            if (hasSchema(opts.jsonSchema)) prompt = buildOpencodePrompt(prompt, opts.jsonSchema);

            const streamController = derivedController(signal);
            const eventResp = await this.connectEventStream(streamController.signal, baseURL);
            try {
                const msgController = derivedController(signal);
                let msgValue: { resp?: OpencodeMessageResponse; err?: unknown; } | undefined;
                const msgPromise = this.sendMessage(msgController.signal, baseURL, sessionID, prompt, opts.jsonSchema)
                    .then(resp => { msgValue = { resp }; })
                    .catch(err => { msgValue = { err }; });

                const state = new OpencodeStreamState(sessionID, opts.onChunk);
                let parseErr: unknown;
                try {
                    await parseOpencodeSSE(eventResp.body as AsyncIterable<Uint8Array>, state);
                } catch (err) {
                    parseErr = err;
                }
                streamController.abort();

                if (parseErr !== undefined) {
                    if (msgValue && msgValue.err) {
                        throw new Error(`opencode message: ${errMessage(msgValue.err)}`);
                    }
                    this.abortSession(baseURL, sessionID);
                    throw new Error(`opencode events: ${errMessage(parseErr)}`);
                }

                await msgPromise;
                if (msgValue && msgValue.err) {
                    throw new Error(`opencode message: ${errMessage(msgValue.err)}`);
                }
                const resp = msgValue?.resp;

                return finalizeOpencodeResult(state, resp, opts);
            } finally {
                streamController.abort();
            }
        } finally {
            this.deleteSession(baseURL, sessionID);
        }
    }

    async close(): Promise<void> {
        const srv = this.server;
        this.server = null;
        this.starting = null;
        if (srv) await srv.shutdown();
    }

    private async ensureServer(signal: AbortSignal | undefined, cwd: string): Promise<string> {
        if (this.server) return this.server.baseURL();
        if (!this.starting) {
            this.starting = (async () => {
                let port: number;
                try {
                    port = await getAvailablePort();
                } catch (err) {
                    throw new Error(`opencode port: ${errMessage(err)}`);
                }
                const args = buildOpencodeServeArgs(this.extraArgs, port);
                try {
                    return await ManagedServer.start(signal, "opencode", this.bin, args, cwd, "/global/health", port);
                } catch (err) {
                    throw new Error(`opencode server: ${errMessage(err)}`);
                }
            })();
        }
        try {
            const srv = await this.starting;
            this.server = srv;
            return srv.baseURL();
        } catch (err) {
            this.starting = null;
            throw err;
        }
    }

    private async createSession(signal: AbortSignal | undefined, baseURL: string, cwd: string): Promise<string> {
        const body = {
            directory: cwd,
            permission: [{ permission: "*", pattern: "*", action: "allow" }]
        };
        let resp: string;
        try {
            resp = await doJSON(signal, "POST", `${baseURL}/session`, undefined, body);
        } catch (err) {
            throw new Error(`opencode create session: ${errMessage(err)}`);
        }
        try {
            const result = JSON.parse(resp) as { id?: string; };
            return result.id ?? "";
        } catch (err) {
            throw new Error(`opencode create session parse: ${errMessage(err)}`);
        }
    }

    private async connectEventStream(signal: AbortSignal, baseURL: string): Promise<Response> {
        let resp: Response;
        try {
            resp = await fetch(`${baseURL}/global/event`, {
                method: "GET",
                headers: { Accept: "text/event-stream" },
                signal
            });
        } catch (err) {
            throw new Error(`opencode event stream: ${errMessage(err)}`);
        }
        if (resp.status !== 200) {
            const body = await resp.text().catch(() => "");
            throw new Error(`opencode event stream failed with ${resp.status}: ${body}`);
        }
        if (!resp.body) throw new Error("opencode event stream: empty body");
        return resp;
    }

    private async sendMessage(
        signal: AbortSignal,
        baseURL: string,
        sessionID: string,
        prompt: string,
        schema: unknown
    ): Promise<OpencodeMessageResponse> {
        const body: Record<string, unknown> = {
            role: "user",
            parts: [{ type: "text", text: prompt }]
        };
        if (hasSchema(schema)) {
            body.format = { type: "json_schema", schema, retryCount: 1 };
        }
        const respBytes = await doJSON(signal, "POST", `${baseURL}/session/${sessionID}/message`, undefined, body);
        try {
            return JSON.parse(respBytes) as OpencodeMessageResponse;
        } catch (err) {
            throw new Error(`opencode message parse: ${errMessage(err)}`);
        }
    }

    private abortSession(baseURL: string, sessionID: string): void {
        void doJSON(AbortSignal.timeout(1000), "POST", `${baseURL}/session/${sessionID}/abort`, undefined, undefined)
            .catch(() => {});
    }

    private deleteSession(baseURL: string, sessionID: string): void {
        fetch(`${baseURL}/session/${sessionID}`, { method: "DELETE", signal: AbortSignal.timeout(1000) }).catch(() => {});
    }
}

/**
 * Builds the OpenCode backend. bin/extraArgs come from the opencode entry of the
 * config overrides; paths wires PID tracking so a future daemon can reap orphans
 * (in Go the daemon calls SetServerPIDsDir; here the factory does it).
 */
export function createOpencode(cfg: Config, paths: Paths, _opts?: Options): OpencodeAgent {
    setServerPIDsDir(paths.serverPIDsDir());
    const bin = cfg.agentPathOverride?.[AGENT_OPENCODE] || "opencode";
    const extraArgs = cfg.agentArgsOverride?.[AGENT_OPENCODE] ?? [];
    return new OpencodeAgent(bin, extraArgs);
}

// -- Helpers ------------------------------------------------------------------

/**
 * Builds `opencode serve`'s argv with user-supplied extras inserted after the
 * "serve" subcommand and before the managed flags.
 */
export function buildOpencodeServeArgs(extraArgs: string[], port: number): string[] {
    return ["serve", ...extraArgs, "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"];
}

/** Appends schema instructions to the prompt. */
export function buildOpencodePrompt(prompt: string, schema: unknown): string {
    return [
        prompt,
        "",
        "When you finish, reply with only valid JSON.",
        "Do not wrap the JSON in markdown fences.",
        "Do not include any prose before or after the JSON.",
        `The JSON must match this schema exactly: ${JSON.stringify(schema)}`
    ].join("\n");
}

/** Resolves the final Result from the stream state and message response. */
function finalizeOpencodeResult(
    state: OpencodeStreamState,
    resp: OpencodeMessageResponse | undefined,
    opts: RunOpts
): Result {
    let responseText = "";
    let responseFinalText = "";
    if (resp && resp.info) {
        const streamedText = state.lastText;
        const streamedFinalText = state.lastFinalText;
        const emitResponseChunk = (chunk: string): void => {
            if (!opts.onChunk || chunk === "") return;
            state.emitSeparatorIfNeeded();
            opts.onChunk(chunk);
            state.hasEmittedText = true;
        };
        if (resp.info.role === "assistant" && resp.info.id && resp.info.tokens) {
            state.usageByMsg.set(resp.info.id, opencodeTokensToUsage(resp.info.tokens));
            state.usage = accumulateUsage(state.usageByMsg);
        }
        for (const part of resp.parts ?? []) {
            if (part.type !== "text" || (part.text ?? "").trim() === "") continue;
            responseText += part.text ?? "";
            if (part.metadata?.openai?.phase === "final_answer") responseFinalText += part.text ?? "";
        }
        if (responseText !== "") state.lastText = responseText;
        if (responseFinalText !== "") state.lastFinalText = responseFinalText;
        if (responseFinalText !== "") responseText = responseFinalText;
        if (opts.onChunk && responseText !== "") {
            let streamedResponseText = streamedText;
            if (streamedFinalText !== "") streamedResponseText = streamedFinalText;
            if (!state.hasEmittedText) {
                emitResponseChunk(responseText);
            } else if (streamedResponseText === "") {
                emitResponseChunk(responseText);
            } else if (responseText.startsWith(streamedResponseText)) {
                emitResponseChunk(responseText.slice(streamedResponseText.length));
            }
        }
    }

    if (resp && resp.info && resp.info.structured !== undefined && resp.info.structured !== null) {
        return { output: resp.info.structured, text: state.lastText, usage: state.usage };
    }

    let outputText = state.lastFinalText;
    if (outputText === "") outputText = state.lastText;
    return finalizeTextResult("opencode", outputText, opts.jsonSchema, state.usage);
}

function hasSchema(schema: unknown): boolean {
    return schema !== undefined && schema !== null;
}

function derivedController(parent: AbortSignal | undefined): AbortController {
    const controller = new AbortController();
    if (parent) {
        if (parent.aborted) controller.abort(parent.reason);
        else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
    }
    return controller;
}

function errMessage(err: unknown): string {
    if (err === undefined || err === null) return "";
    return err instanceof Error ? err.message : String(err);
}
