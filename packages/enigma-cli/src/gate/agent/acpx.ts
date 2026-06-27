/**
 * ACP (Agent Client Protocol) backend that drives `acpx <target>` for
 * `acp:<target>` agents.
 *
 * Faithful 1:1 port of the Go `internal/agent/acpx.go`: it spawns the
 * user-installed `acpx` CLI in JSON mode, streams its newline-delimited
 * JSON-RPC events from stdout (`session/update` notifications carrying
 * `agent_message_chunk` text and `usage_update` token counts, plus top-level
 * `result.usage` and `error` objects), accumulates the assistant text, and
 * tracks token usage across the many snake_case/camelCase field spellings acpx
 * targets emit.
 *
 * Divergences from the Go original (all intentional):
 * - `context.Context` becomes an `AbortSignal`: the scan loop checks
 *   `signal.aborted` and rejects with the abort reason, mirroring the Go
 *   `ctx.Done()` early return; `spawnConfigured` also kills the whole process
 *   tree on abort.
 * - JSONSchema is a parsed JSON value (`unknown`), so the structured-output
 *   contract is appended via `JSON.stringify`, and "no schema" is
 *   `undefined`/`null` rather than Go's `len(schema) == 0`.
 * - The Go scanner caps a single line at 256 MiB; Node's stream reader has no
 *   such cap (an over-long line is just buffered), which only relaxes a bound.
 * - The output-token fallback estimate counts UTF-8 bytes (`Buffer.byteLength`)
 *   to match Go's `len(string)` byte semantics.
 */

import { gitSafeEnv } from "./env";
import type { Readable } from "node:stream";
import { spawnConfigured } from "../shellenv";
import { agentPath, type Config } from "../config";
import type { ChildProcess } from "node:child_process";
import { classifyTransient, runWithRetry } from "./retry";
import {
    type Agent,
    type RunOpts,
    type Result,
    type Options,
    type TokenUsage,
    emptyTokenUsage,
    finalizeTextResult
} from "./agent";

/**
 * Additional attempts past the initial run, retried only on transient errors.
 * Mirrors the Go `claudeMaxRetries` constant shared by every backend.
 */
const ACPX_MAX_RETRIES = 3;

/** Runs an `acp:<target>` agent through the user-installed acpx CLI. */
export class AcpxAgent implements Agent {
    private readonly bin: string;
    private readonly target: string;
    private readonly rawCommand: string;

    constructor(bin: string, target: string, rawCommand: string) {
        this.bin = bin;
        this.target = target;
        this.rawCommand = rawCommand;
    }

    name(): string {
        return `acp:${this.target}`;
    }

    run(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        return runWithRetry(signal, this.name(), opts, ACPX_MAX_RETRIES, classifyTransient, undefined, () =>
            this.runOnce(opts, signal)
        );
    }

    async close(): Promise<void> {}

    private async runOnce(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        const args = this.buildArgs(opts);
        // Run in a dedicated process group so cancelling the signal reaps the
        // acpx CLI and any subprocesses it spawns, not just the direct child.
        const child = spawnConfigured(this.bin, args, {
            cwd: opts.cwd,
            env: gitSafeEnv(opts.cwd),
            stdio: ["ignore", "pipe", "pipe"],
            signal
        });

        const stderrChunks: Buffer[] = [];
        child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));

        const exited = waitForExit(child);

        const usage = emptyTokenUsage();
        let text = "";
        let stdoutErr = "";
        let parseErr: unknown;
        if (child.stdout) {
            try {
                const res = await parseAcpxJSONEvents(signal, child.stdout, opts.onChunk, usage);
                text = res.text;
                stdoutErr = res.stdoutErr;
            } catch (err) {
                parseErr = err;
            }
        }

        const exit = await exited;
        const stderrText = Buffer.concat(stderrChunks).toString("utf8");

        if (exit.error) {
            throw new Error(`acpx start: ${errMessage(exit.error)}`);
        }
        if (parseErr !== undefined) {
            throw new Error(`acpx parse events: ${errMessage(parseErr)}`);
        }
        const exitErr = exitErrorMessage(exit.code, exit.signal);
        if (exitErr !== null) {
            throw new Error(`acpx exited: ${exitErr}: ${acpxProcessErrorOutput(stderrText, stdoutErr)}`);
        }

        if (usage.outputTokens === 0) {
            usage.outputTokens = estimateAcpxTokens(Buffer.byteLength(text, "utf8"));
        }
        return finalizeTextResult(this.name(), text, opts.jsonSchema, usage);
    }

    private buildArgs(opts: RunOpts): string[] {
        let prompt = opts.prompt;
        if (opts.jsonSchema !== undefined && opts.jsonSchema !== null) {
            prompt = buildACPStructuredPrompt(prompt, opts.jsonSchema);
        }

        const args: string[] = [];
        if (this.rawCommand !== "") {
            args.push("--agent", this.rawCommand);
        }
        if (opts.cwd !== "") {
            args.push("--cwd", opts.cwd);
        }
        args.push(
            "--format", "json",
            "--json-strict",
            "--approve-all",
            "--non-interactive-permissions", "deny",
            "--suppress-reads"
        );
        if (this.rawCommand === "") {
            args.push(this.target);
        }
        args.push("exec", prompt);
        return args;
    }
}

/**
 * Constructs an acpx backend for `acp:<target>`. The binary comes from the
 * config (`acpx_path`, defaulting to `acpx`); `acpRegistryOverrides` maps the
 * target to a raw ACP agent command run via `--agent` instead of the bare
 * target name.
 */
export function createAcpx(cfg: Config, target: string, opts: Options = {}): AcpxAgent {
    const bin = agentPath(cfg);
    const rawCommand = opts.acpRegistryOverrides?.[target] ?? "";
    return new AcpxAgent(bin, target, rawCommand);
}

/** Exit details of a spawned acpx process (or the spawn error itself). */
interface ExitInfo {
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
}

/** Resolves on process close, or on a spawn error (whichever fires first). */
function waitForExit(child: ChildProcess): Promise<ExitInfo> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (info: ExitInfo): void => {
            if (settled) return;
            settled = true;
            resolve(info);
        };
        child.once("error", (err: Error) => finish({ code: null, signal: null, error: err }));
        child.once("close", (code, signal) => finish({ code, signal }));
    });
}

/**
 * Reads acpx's newline-delimited JSON-RPC events from `stdout`, appending
 * `agent_message_chunk` text to the output and tracking the maximum token usage
 * seen. Returns the accumulated text plus the first reported error message.
 * Rejects with the abort reason when `signal` fires mid-stream.
 */
async function parseAcpxJSONEvents(
    signal: AbortSignal | undefined,
    stdout: Readable,
    onChunk: ((text: string) => void) | undefined,
    usage: TokenUsage
): Promise<{ text: string; stdoutErr: string }> {
    stdout.setEncoding("utf8");
    let output = "";
    let stdoutErr = "";

    const handleLine = (raw: string): void => {
        let line = raw;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) return;

        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        const obj = asObject(msg);
        if (!obj) return;

        const errObj = asObject(obj.error);
        const errMsg = errObj?.message;
        if (typeof errMsg === "string" && errMsg !== "" && stdoutErr === "") {
            stdoutErr = errMsg;
        }

        const result = asObject(obj.result);
        maxUsageInto(usage, acpxUsageFieldsToTokenUsage(asObject(result?.usage)));

        if (obj.method !== "session/update") return;

        const params = asObject(obj.params);
        const update = asObject(params?.update);
        if (!update) return;

        switch (update.sessionUpdate) {
            case "usage_update":
                maxUsageInto(usage, acpxUpdateUsage(update));
                break;
            case "agent_message_chunk": {
                const text = acpxUpdateText(update);
                if (text === "") return;
                output += text;
                onChunk?.(text);
                break;
            }
        }
    };

    let buffer = "";
    for await (const chunk of stdout) {
        if (signal?.aborted) throw abortError(signal);
        buffer += chunk as string;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (signal?.aborted) throw abortError(signal);
            handleLine(line);
        }
    }
    if (signal?.aborted) throw abortError(signal);
    if (buffer.length > 0) handleLine(buffer);
    return { text: output, stdoutErr };
}

/** Derives token usage from a `usage_update` session update. */
function acpxUpdateUsage(update: Record<string, unknown>): TokenUsage {
    let usage = acpxUsageFieldsToTokenUsage(update);
    const meta = asObject(update._meta);
    const metaUsage = acpxUsageFieldsToTokenUsage(asObject(meta?.usage));
    usage = acpxMaxUsage(usage, metaUsage);
    const used = numField(update, "used");
    if (used > usage.inputTokens) usage.inputTokens = used;
    return usage;
}

/** Maps acpx's many usage-field spellings to a normalized TokenUsage. */
function acpxUsageFieldsToTokenUsage(fields: Record<string, unknown> | undefined): TokenUsage {
    return {
        inputTokens: acpxFirstPositive(numField(fields, "input_tokens"), numField(fields, "inputTokens")),
        outputTokens: acpxFirstPositive(numField(fields, "output_tokens"), numField(fields, "outputTokens")),
        cacheReadTokens: acpxFirstPositive(
            numField(fields, "cache_read_input_tokens"),
            numField(fields, "cache_read_tokens"),
            numField(fields, "cached_input_tokens"),
            numField(fields, "cacheReadInputTokens"),
            numField(fields, "cachedInputTokens"),
            numField(fields, "cacheReadTokens"),
            numField(fields, "cachedReadTokens")
        ),
        cacheCreationTokens: acpxFirstPositive(
            numField(fields, "cache_creation_input_tokens"),
            numField(fields, "cache_write_input_tokens"),
            numField(fields, "cache_write_tokens"),
            numField(fields, "cacheCreationInputTokens"),
            numField(fields, "cacheCreationTokens"),
            numField(fields, "cacheWriteTokens"),
            numField(fields, "cachedWriteTokens")
        )
    };
}

/** Returns the field-wise maximum of two usages. */
function acpxMaxUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        inputTokens: Math.max(a.inputTokens, b.inputTokens),
        outputTokens: Math.max(a.outputTokens, b.outputTokens),
        cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
        cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens)
    };
}

/** Merges the field-wise maximum of `other` into `into` (mutates `into`). */
function maxUsageInto(into: TokenUsage, other: TokenUsage): void {
    const m = acpxMaxUsage(into, other);
    into.inputTokens = m.inputTokens;
    into.outputTokens = m.outputTokens;
    into.cacheReadTokens = m.cacheReadTokens;
    into.cacheCreationTokens = m.cacheCreationTokens;
}

/** Returns the first strictly positive value, or 0 when none qualify. */
function acpxFirstPositive(...values: number[]): number {
    for (const value of values) {
        if (value > 0) return value;
    }
    return 0;
}

/** Extracts the text of an `agent_message_chunk` update. */
function acpxUpdateText(update: Record<string, unknown>): string {
    const text = update.text;
    if (typeof text === "string" && text !== "") return text;

    const content = update.content;
    if (content === undefined || content === null) return "";

    const single = asObject(content);
    if (single) {
        const t = single.text;
        return typeof t === "string" && t !== "" ? t : "";
    }
    if (Array.isArray(content)) {
        let b = "";
        for (const part of content) {
            const pt = asObject(part)?.text;
            if (typeof pt === "string" && pt !== "") b += pt;
        }
        return b;
    }
    return "";
}

/** Estimates token count from a byte count (~4 bytes/token, rounded up). */
function estimateAcpxTokens(charCount: number): number {
    if (charCount <= 0) return 0;
    return Math.trunc((charCount + 3) / 4);
}

/** Joins trimmed stderr and the first stdout error message into one diagnostic. */
function acpxProcessErrorOutput(stderr: string, stdoutErr: string): string {
    const parts: string[] = [];
    const stderrText = stderr.trim();
    if (stderrText !== "") parts.push(stderrText);
    if (stdoutErr !== "") parts.push(stdoutErr);
    return parts.join("\n");
}

/** Appends the structured-output contract (JSON Schema) to a prompt. */
function buildACPStructuredPrompt(prompt: string, schema: unknown): string {
    return `${prompt}\n\n## enigma final output contract\n\nWhen the task is complete, your final assistant message must be a single JSON object that matches this JSON Schema. Return only the JSON object. Do not wrap it in Markdown fences. Do not include prose before or after the JSON.\n\n${JSON.stringify(schema)}`;
}

/** Formats a Go-style process exit error, or null on clean exit. */
function exitErrorMessage(code: number | null, signal: NodeJS.Signals | null): string | null {
    if (signal) return `signal: ${signal}`;
    if (code !== null && code !== 0) return `exit status ${code}`;
    return null;
}

/** Reads a numeric field from an object, treating non-numbers as 0. */
function numField(obj: Record<string, unknown> | undefined, key: string): number {
    const v = obj?.[key];
    return typeof v === "number" ? v : 0;
}

/** Returns `value` as a plain object, or undefined for arrays/null/non-objects. */
function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Builds the abort error to reject with when the run's signal fires. */
function abortError(signal: AbortSignal | undefined): Error {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
