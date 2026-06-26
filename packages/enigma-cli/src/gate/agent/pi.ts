/**
 * Pi native-CLI agent backend.
 *
 * Faithful 1:1 port of the Go `internal/agent/pi.go`: spawns `pi [user args]
 * --mode json --no-session`, writes the (optionally schema-augmented) prompt to
 * stdin, streams the JSONL events, accumulates token usage with de-duplication,
 * surfaces an assistant-reported error, and resolves the final text via the
 * shared text->JSON extractor. Lifecycle is codex-shaped: one process per run.
 *
 * Divergences from Go (intentional): `context.Context` -> `AbortSignal`; the
 * parsed `opts.jsonSchema` is pretty-printed and inlined in the prompt (Pi has
 * no --output-schema flag); "no schema" is undefined/null (Go's `len == 0`).
 * Go's `map[int]string` becomes a `Map<number, string>`.
 */

import { gitSafeEnv } from "./env";
import type { Readable } from "node:stream";
import { spawnConfigured } from "../shellenv";
import { CLAUDE_MAX_RETRIES } from "./claude";
import { classifyTransient, runWithRetry } from "./retry";
import { type Config, agentArgs, agentPath } from "../config";
import {
    asRecord,
    hasSchema,
    errMessage,
    collectStream,
    numberField,
    streamLines,
    awaitProcessOutcome
} from "./proc";
import {
    type Agent,
    type Result,
    type Options,
    type RunOpts,
    type TokenUsage,
    emptyTokenUsage,
    finalizeTextResult
} from "./agent";

/**
 * Spawns the pi CLI for each invocation. Pi reads its prompt from stdin and
 * emits JSONL on stdout when --mode json is set.
 */
export class PiAgent implements Agent {
    constructor(
        private readonly bin: string,
        private readonly extraArgs: string[]
    ) {}

    name(): string {
        return "pi";
    }

    run(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        return runWithRetry(signal, "pi", opts, CLAUDE_MAX_RETRIES, classifyTransient, undefined, () =>
            this.runOnce(opts, signal)
        );
    }

    async close(): Promise<void> {}

    private async runOnce(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        const args = this.buildArgs();
        const child = spawnConfigured(this.bin, args, {
            cwd: opts.cwd,
            env: gitSafeEnv(opts.cwd),
            stdio: ["pipe", "pipe", "pipe"],
            signal
        });
        if (!child.stdin || !child.stdout || !child.stderr) throw new Error("pi pipes unavailable");

        const outcome = awaitProcessOutcome(child);

        // Write the prompt and close stdin, mirroring Go's writer goroutine. A
        // broken-pipe error is ignored, matching `_, _ = io.WriteString`.
        child.stdin.on("error", () => {});
        child.stdin.end(buildPiPrompt(opts.prompt, opts.jsonSchema));

        const stderrPromise = collectStream(child.stderr);

        const parser = new PiParser(opts.onChunk);
        try {
            await parser.parse(child.stdout, signal);
        } catch (err) {
            await stderrPromise;
            await outcome;
            throw new Error(`pi parse events: ${errMessage(err)}`);
        }

        const stderr = await stderrPromise;
        const settled = await outcome;
        if (settled.startError) throw new Error(`pi start: ${errMessage(settled.startError)}`);
        if (settled.exitError) {
            const trimmed = stderr.trim();
            if (trimmed !== "") throw new Error(`pi exited: ${errMessage(settled.exitError)}: ${trimmed}`);
            throw new Error(`pi exited: ${errMessage(settled.exitError)}`);
        }

        if (parser.assistantError !== "") throw new Error(`pi reported error: ${parser.assistantError}`);

        return finalizeTextResult("pi", parser.finalText(), opts.jsonSchema, parser.usage);
    }

    /**
     * Returns the Pi argv for one invocation. User extras come first (so user
     * --provider/--model take effect), then the managed flags enigma requires
     * for JSONL parsing.
     */
    private buildArgs(): string[] {
        return [...this.extraArgs, "--mode", "json", "--no-session"];
    }
}

/** Builds a PiAgent from the resolved gate configuration. */
export function createPi(cfg: Config, _opts?: Options): PiAgent {
    return new PiAgent(agentPath(cfg), agentArgs(cfg));
}

/**
 * Appends a JSON-output contract to the user prompt when a schema is provided.
 * Pi has no equivalent of codex's --output-schema flag, so the schema is inlined.
 */
export function buildPiPrompt(prompt: string, schema: unknown): string {
    if (!hasSchema(schema)) return prompt;
    let pretty: string;
    try {
        pretty = JSON.stringify(schema, null, 2);
    } catch {
        pretty = String(schema);
    }
    return `${prompt}\n\n## enigma gate final output contract\n\nWhen the iteration is complete, your final assistant response must be only valid JSON matching this JSON Schema. Do not wrap it in Markdown fences. Do not include prose before or after the JSON object.\n\n${pretty}`;
}

/**
 * Tracks the streaming state of one Pi run: accumulates text deltas, captures
 * the final assistant text and de-duplicated usage, and surfaces any reported
 * assistant error.
 */
class PiParser {
    /** Set when the assistant message stops with an error/aborted reason. */
    assistantError = "";
    usage: TokenUsage = emptyTokenUsage();

    private readonly streamText = new Map<number, string>();
    private readonly completeText = new Map<number, string>();
    private finalAssistant: Record<string, unknown> | null = null;
    private seenUsage = new Set<string>();

    constructor(private readonly onChunk?: (text: string) => void) {}

    async parse(stream: Readable, signal: AbortSignal | undefined): Promise<void> {
        await streamLines(stream, signal, line => {
            let event: unknown;
            try {
                event = JSON.parse(line);
            } catch {
                return;
            }
            const ev = asRecord(event);
            if (!ev) return;
            this.handleEvent(ev);
        });
    }

    private handleEvent(event: Record<string, unknown>): void {
        switch (event.type) {
            case "message_update":
                this.rememberAssistant(event.message);
                this.handleAssistantEvent(event.assistantMessageEvent);
                break;
            case "message_end":
            case "turn_end":
                this.rememberAssistant(event.message);
                this.recordAssistantUsage(event.message);
                break;
            case "agent_end":
                this.rememberAgentEnd(event.messages);
                break;
        }
    }

    private rememberAssistant(raw: unknown): void {
        const msg = asRecord(raw);
        if (!msg) return;
        if (msg.role !== "assistant") return;
        this.finalAssistant = msg;

        const reason = typeof msg.stopReason === "string" ? msg.stopReason : "";
        if (reason === "error" || reason === "aborted") {
            this.assistantError = piFirstString(msg, "errorMessage", "error", "message");
            if (this.assistantError === "") this.assistantError = `stopReason=${reason}`;
        } else {
            this.assistantError = "";
        }
    }

    private rememberAgentEnd(raw: unknown): void {
        if (!Array.isArray(raw)) return;
        const messages = raw;

        let total = emptyTokenUsage();
        const seen = new Set<string>();
        let hasUsage = false;
        for (let i = 0; i < messages.length; i++) {
            const msg = asRecord(messages[i]);
            if (!msg || msg.role !== "assistant") continue;
            const usageMap = asRecord(msg.usage);
            if (!usageMap) continue;
            const usage = piUsageFrom(usageMap);
            if (piUsageIsZero(usage)) continue;
            let key = piUsageKey(msg);
            if (key === "") key = `agent_end:${i}`;
            if (seen.has(key)) continue;
            seen.add(key);
            total = piUsageAdd(total, usage);
            hasUsage = true;
        }
        if (hasUsage) {
            this.usage = total;
            this.seenUsage = new Set(seen);
        }

        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = asRecord(messages[i]);
            if (msg && msg.role === "assistant") {
                this.rememberAssistant(msg);
                return;
            }
        }
    }

    private recordAssistantUsage(raw: unknown): void {
        const msg = asRecord(raw);
        if (!msg || msg.role !== "assistant") return;
        const usageMap = asRecord(msg.usage);
        if (!usageMap) return;
        const usage = piUsageFrom(usageMap);
        if (piUsageIsZero(usage)) return;
        let key = piUsageKey(msg);
        if (key === "") key = JSON.stringify([msg.role, msg.stopReason, msg.content, msg.usage]);
        if (this.seenUsage.has(key)) return;
        this.seenUsage.add(key);
        this.usage = piUsageAdd(this.usage, usage);
    }

    private handleAssistantEvent(raw: unknown): void {
        const evt = asRecord(raw);
        if (!evt) return;
        const idx = piIntField(evt, "contentIndex", "content_index");
        switch (evt.type) {
            case "text_delta": {
                // Emit just the incremental delta; OnChunk consumers expect
                // appended text, not cumulative state.
                const delta = piFirstString(evt, "delta", "text", "content");
                if (delta === "") return;
                this.streamText.set(idx, (this.streamText.get(idx) ?? "") + delta);
                this.onChunk?.(delta);
                break;
            }
            case "text_end": {
                // Capture the complete text for final-result resolution without
                // re-emitting; prefer the authoritative full text when present.
                let text = piFirstString(evt, "text", "content");
                if (text === "") text = this.streamText.get(idx) ?? "";
                this.completeText.set(idx, text);
                break;
            }
        }
    }

    /**
     * Returns the final assistant text, preferring (in order) the last assistant
     * message content, the text_end-completed deltas, then the in-flight buffer.
     */
    finalText(): string {
        const fromMessage = textFromAssistantMessage(this.finalAssistant).trim();
        if (fromMessage !== "") return fromMessage;
        const fromComplete = joinByIndex(this.completeText).trim();
        if (fromComplete !== "") return fromComplete;
        return joinByIndex(this.streamText).trim();
    }
}

function textFromAssistantMessage(msg: Record<string, unknown> | null): string {
    if (msg === null) return "";
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        let out = "";
        for (const block of content) {
            if (typeof block === "string") {
                out += block;
                continue;
            }
            const obj = asRecord(block);
            if (!obj) continue;
            if (typeof obj.text === "string") {
                out += obj.text;
                continue;
            }
            if (typeof obj.content === "string") out += obj.content;
        }
        return out;
    }
    if (typeof msg.text === "string") return msg.text;
    return "";
}

function joinByIndex(parts: Map<number, string>): string {
    if (parts.size === 0) return "";
    let max = -1;
    for (const k of parts.keys()) if (k > max) max = k;
    let out = "";
    for (let i = 0; i <= max; i++) out += parts.get(i) ?? "";
    return out;
}

function piFirstString(m: Record<string, unknown>, ...names: string[]): string {
    for (const n of names) {
        const v = m[n];
        if (typeof v === "string") return v;
    }
    return "";
}

function piIntField(m: Record<string, unknown>, ...names: string[]): number {
    for (const n of names) {
        const v = m[n];
        if (typeof v === "number") return Math.trunc(v);
    }
    return 0;
}

function piUsageFrom(usage: Record<string, unknown>): TokenUsage {
    return {
        inputTokens: numberField(usage, "input"),
        outputTokens: numberField(usage, "output"),
        cacheReadTokens: numberField(usage, "cacheRead"),
        cacheCreationTokens: numberField(usage, "cacheWrite")
    };
}

function piUsageAdd(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens
    };
}

function piUsageIsZero(usage: TokenUsage): boolean {
    return (
        usage.inputTokens === 0 &&
        usage.outputTokens === 0 &&
        usage.cacheReadTokens === 0 &&
        usage.cacheCreationTokens === 0
    );
}

function piUsageKey(msg: Record<string, unknown>): string {
    for (const name of ["responseId", "id"]) {
        const value = msg[name];
        if (typeof value === "string" && value !== "") return `${name}:${value}`;
    }
    return "";
}
