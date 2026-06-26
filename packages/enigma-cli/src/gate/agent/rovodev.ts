/**
 * Rovo Dev backend: starts a persistent HTTP server via `acli rovodev serve`
 * and drives it over REST with SSE streaming.
 *
 * Faithful port of the Go `internal/agent/rovodev.go`, including the shared
 * `doJSON` HTTP helper (defined here in Go and reused by the opencode backend).
 * The server is started once per agent (synchronized), reused across Run calls,
 * and torn down on Close or a "connection refused" transient retry.
 *
 * Divergences (intentional):
 * - The Go `context.Context` is an `AbortSignal`.
 * - SSE text pointers (`*string`) become a returned value; `*TokenUsage` becomes
 *   an in-place accumulation via addTokenUsage.
 * - `claudeMaxRetries` (defined in the not-yet-ported claude backend) is
 *   replicated as a local constant so the retry budget matches the original.
 * - The factory wires PID tracking from the passed Paths; see createRovodev.
 */

import { Paths } from "../paths";
import { Config } from "../config";
import { AGENT_ROVODEV } from "../types";
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

/**
 * Starts a persistent HTTP server via `acli rovodev serve` and sends requests
 * via REST with SSE streaming.
 */
export class RovodevAgent implements Agent {
    private readonly bin: string;
    private readonly extraArgs: string[];
    private server: ManagedServer | null = null;
    private starting: Promise<ManagedServer> | null = null;

    constructor(bin: string, extraArgs: string[]) {
        this.bin = bin;
        this.extraArgs = extraArgs;
    }

    name(): string {
        return "rovodev";
    }

    async run(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        return runWithRetry(
            signal,
            "rovodev",
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

        const sessionID = await this.createSession(signal, baseURL);
        try {
            if (hasSchema(opts.jsonSchema)) {
                const prompt = buildRovodevSystemPrompt(opts.jsonSchema);
                await this.setSystemPrompt(signal, baseURL, sessionID, prompt);
            }

            await this.setChatMessage(signal, baseURL, sessionID, opts.prompt);

            const usage = emptyTokenUsage();
            let text: string;
            try {
                text = await this.streamChat(signal, baseURL, sessionID, opts.onChunk, usage);
            } catch (err) {
                this.cancelSession(baseURL, sessionID);
                throw err;
            }
            return finalizeTextResult("rovodev", text, opts.jsonSchema, usage);
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
                    throw new Error(`rovodev port: ${errMessage(err)}`);
                }
                const args = buildRovodevServeArgs(this.extraArgs, port);
                try {
                    return await ManagedServer.start(signal, "rovodev", this.bin, args, cwd, "/healthcheck", port);
                } catch (err) {
                    throw new Error(`rovodev server: ${errMessage(err)}`);
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

    private async createSession(signal: AbortSignal | undefined, baseURL: string): Promise<string> {
        const body = { custom_title: "no-mistakes" };
        let resp: string;
        try {
            resp = await doJSON(signal, "POST", `${baseURL}/v3/sessions/create`, undefined, body);
        } catch (err) {
            throw new Error(`rovodev create session: ${errMessage(err)}`);
        }
        try {
            const result = JSON.parse(resp) as { session_id?: string };
            return result.session_id ?? "";
        } catch (err) {
            throw new Error(`rovodev create session parse: ${errMessage(err)}`);
        }
    }

    private async setSystemPrompt(
        signal: AbortSignal | undefined,
        baseURL: string,
        sessionID: string,
        prompt: string
    ): Promise<void> {
        try {
            await doJSON(signal, "PUT", `${baseURL}/v3/inline-system-prompt`, { "x-session-id": sessionID }, { prompt });
        } catch (err) {
            throw new Error(`rovodev set system prompt: ${errMessage(err)}`);
        }
    }

    private async setChatMessage(
        signal: AbortSignal | undefined,
        baseURL: string,
        sessionID: string,
        message: string
    ): Promise<void> {
        try {
            await doJSON(signal, "POST", `${baseURL}/v3/set_chat_message`, { "x-session-id": sessionID }, { message });
        } catch (err) {
            throw new Error(`rovodev set chat message: ${errMessage(err)}`);
        }
    }

    private async streamChat(
        signal: AbortSignal | undefined,
        baseURL: string,
        sessionID: string,
        onChunk: ((text: string) => void) | undefined,
        usage: TokenUsage
    ): Promise<string> {
        let resp: Response;
        try {
            resp = await fetch(`${baseURL}/v3/stream_chat`, {
                method: "GET",
                headers: { Accept: "text/event-stream", "x-session-id": sessionID },
                signal
            });
        } catch (err) {
            throw new Error(`rovodev stream: ${errMessage(err)}`);
        }
        if (resp.status !== 200) {
            const body = await resp.text().catch(() => "");
            throw new Error(`rovodev stream failed with ${resp.status}: ${body}`);
        }
        if (!resp.body) throw new Error("rovodev stream: empty body");
        return parseRovodevSSE(resp.body as AsyncIterable<Uint8Array>, onChunk, usage);
    }

    private cancelSession(baseURL: string, sessionID: string): void {
        void doJSON(AbortSignal.timeout(1000), "POST", `${baseURL}/v3/cancel`, { "x-session-id": sessionID }, undefined)
            .catch(() => {});
    }

    private deleteSession(baseURL: string, sessionID: string): void {
        fetch(`${baseURL}/v3/sessions/${sessionID}`, { method: "DELETE", signal: AbortSignal.timeout(1000) }).catch(() => {});
    }
}

/**
 * Builds the Rovo Dev backend. bin/extraArgs come from the rovodev entry of the
 * config overrides; paths wires PID tracking so a future daemon can reap orphans
 * (in Go the daemon calls SetServerPIDsDir; here the factory does it).
 */
export function createRovodev(cfg: Config, paths: Paths, _opts?: Options): RovodevAgent {
    setServerPIDsDir(paths.serverPIDsDir());
    const bin = cfg.agentPathOverride?.[AGENT_ROVODEV] || "acli";
    const extraArgs = cfg.agentArgsOverride?.[AGENT_ROVODEV] ?? [];
    return new RovodevAgent(bin, extraArgs);
}

// -- Helpers ------------------------------------------------------------------

/**
 * Builds `acli`'s serve argv with user-supplied extras inserted after the
 * "rovodev serve" subcommands and before the managed flags.
 */
export function buildRovodevServeArgs(extraArgs: string[], port: number): string[] {
    return ["rovodev", "serve", ...extraArgs, "--disable-session-token", String(port)];
}

/**
 * Creates a system prompt that instructs the agent to return structured JSON
 * matching the given schema.
 */
export function buildRovodevSystemPrompt(schema: unknown): string {
    return [
        "When you finish, reply with only valid JSON.",
        "Do not wrap the JSON in markdown fences.",
        "Do not include any prose before or after the JSON.",
        `The JSON must match this schema exactly: ${JSON.stringify(schema)}`
    ].join("\n");
}

// -- SSE ----------------------------------------------------------------------

interface RovodevSSEPart {
    content?: string;
    part_kind?: string;
}

interface RovodevSSEDelta {
    content_delta?: string;
    part_delta_kind?: string;
}

interface RovodevSSEEvent {
    event_kind?: string;
    content?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    index?: number;
    part?: RovodevSSEPart;
    delta?: RovodevSSEDelta;
}

/**
 * Processes the SSE stream from rovodev, extracting text chunks and token usage
 * (accumulated into usage), and returns the latest assembled text for structured
 * output. Text arrives as "text" (full message), "part_start" (new part), or
 * "part_delta" (append); tool activity resets the buffer so only the final
 * post-tool segment is returned.
 */
export async function parseRovodevSSE(
    source: AsyncIterable<Uint8Array | string>,
    onChunk: ((text: string) => void) | undefined,
    usage: TokenUsage
): Promise<string> {
    let parts: string[] = [];
    let partIndex = new Map<number, number>();
    let hasEmittedText = false;
    let hadToolActivity = false;
    let latestText = "";

    const updateLatest = (): void => { latestText = parts.join(""); };
    const resetParts = (): void => {
        parts = [];
        partIndex = new Map<number, number>();
        latestText = "";
    };
    const emitSeparator = (): void => {
        if (hasEmittedText && hadToolActivity && onChunk) onChunk("\n\n");
        hadToolActivity = false;
    };
    const emitChunk = (s: string): void => {
        if (onChunk) {
            onChunk(s);
            hasEmittedText = true;
        }
    };

    await parseSSE(source, (ev: SSEEvent): boolean => {
        if (ev.data === "") return true;

        let kind = ev.name;
        let payload: RovodevSSEEvent;
        try {
            payload = JSON.parse(ev.data) as RovodevSSEEvent;
        } catch {
            return true;
        }
        if (kind === "" && payload.event_kind) kind = payload.event_kind;

        switch (kind) {
            case "request-usage": {
                const add = emptyTokenUsage();
                add.inputTokens = payload.input_tokens ?? 0;
                add.outputTokens = payload.output_tokens ?? 0;
                add.cacheReadTokens = payload.cache_read_tokens ?? 0;
                add.cacheCreationTokens = payload.cache_write_tokens ?? 0;
                addTokenUsage(usage, add);
                break;
            }

            case "text":
                if (payload.content) {
                    emitSeparator();
                    parts = [payload.content];
                    partIndex = new Map<number, number>([[0, 0]]);
                    updateLatest();
                    emitChunk(payload.content);
                }
                break;

            case "part_start":
                if (payload.part && payload.part.part_kind === "text" && payload.part.content) {
                    emitSeparator();
                    parts.push(payload.part.content);
                    partIndex.set(payload.index ?? 0, parts.length - 1);
                    updateLatest();
                    emitChunk(payload.part.content);
                }
                break;

            case "part_delta":
                if (payload.delta && payload.delta.part_delta_kind === "text" && payload.delta.content_delta) {
                    const index = payload.index ?? 0;
                    const idx = partIndex.get(index);
                    if (idx !== undefined) {
                        parts[idx] += payload.delta.content_delta;
                    } else {
                        emitSeparator();
                        parts.push(payload.delta.content_delta);
                        partIndex.set(index, parts.length - 1);
                    }
                    updateLatest();
                    emitChunk(payload.delta.content_delta);
                }
                break;

            case "tool-return":
            case "on_call_tools_start":
                resetParts();
                hadToolActivity = true;
                break;
        }

        return true;
    });

    return latestText;
}

// -- HTTP ---------------------------------------------------------------------

/** Makes an HTTP request with an optional JSON body and returns the response body text. */
export async function doJSON(
    signal: AbortSignal | undefined,
    method: string,
    url: string,
    headers: Record<string, string> | undefined,
    body: unknown
): Promise<string> {
    const init: RequestInit = { method, signal };
    const reqHeaders: Record<string, string> = { ...headers };
    if (body !== undefined && body !== null) {
        init.body = JSON.stringify(body);
        reqHeaders["Content-Type"] = "application/json";
    }
    init.headers = reqHeaders;

    const resp = await fetch(url, init);
    const respBody = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`${method} ${url} failed with ${resp.status}: ${respBody}`);
    }
    return respBody;
}

function hasSchema(schema: unknown): boolean {
    return schema !== undefined && schema !== null;
}

function errMessage(err: unknown): string {
    if (err === undefined || err === null) return "";
    return err instanceof Error ? err.message : String(err);
}
