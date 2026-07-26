/**
 * Claude Code native-CLI agent backend.
 *
 * Faithful 1:1 port of the Go `internal/agent/claude.go`: spawns `claude -p
 * --verbose --output-format stream-json [--json-schema <schema>] [--dangerously-
 * skip-permissions]` per invocation, streams the JSONL `assistant`/`result`
 * events, accumulates token usage, and resolves the structured/text output. The
 * run is retried for transient API errors and for a successful run that omitted
 * structured output (the `NoStructuredOutputError` case).
 *
 * Divergences from Go (all intentional, see also ../agent.ts):
 * - `context.Context` -> `AbortSignal`; whole-tree cancellation is wired by
 *   `spawnConfigured`.
 * - `opts.jsonSchema` is a parsed JSON value, so it is re-serialized for the
 *   `--json-schema` flag and "no schema" is undefined/null (Go's `len == 0`).
 * - `result.structuredOutput` is the parsed `structured_output` value; absence
 *   (Go's nil RawMessage) is represented by `undefined`.
 */

import { gitSafeEnv } from "./env";
import { promptFitsArgv } from "./argv";
import type { Readable } from "node:stream";
import { spawnConfigured } from "../shellenv";
import { type Config, agentArgs, agentPath } from "../config";
import { NoStructuredOutputError, claudeRetryClassifier, runWithRetry } from "./retry";
import {
    type Result,
    type Options,
    type RunOpts,
    type TokenUsage,
    addTokenUsage,
    emptyTokenUsage,
    type Agent
} from "./agent";
import {
    hasOwn,
    asRecord,
    hasSchema,
    errMessage,
    collectStream,
    numberField,
    streamLines,
    awaitProcessOutcome
} from "./proc";

/**
 * Additional attempts past the initial invocation. With 3 retries the agent
 * makes up to 4 total attempts before surfacing a transient API error.
 */
export const CLAUDE_MAX_RETRIES = 3;

/** Parsed `result` event captured from the claude JSONL stream. */
interface ClaudeResult {
    subtype: string;
    isError: boolean;
    /** Parsed `structured_output`; undefined when the field is absent. */
    structuredOutput: unknown;
    /** Accumulated text from the `assistant` events. */
    text: string;
    /** The raw `result` JSONL line, for missing-output diagnostics. */
    rawEvent: string;
}

/** Spawns the claude CLI for each invocation. */
export class ClaudeAgent implements Agent {
    constructor(
        private readonly bin: string,
        private readonly extraArgs: string[]
    ) {}

    name(): string {
        return "claude";
    }

    run(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        return runWithRetry(signal, "claude", opts, CLAUDE_MAX_RETRIES, claudeRetryClassifier, undefined, () =>
            this.runOnce(opts, signal)
        );
    }

    async close(): Promise<void> {}

    private async runOnce(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        // A prompt too large for argv is piped to stdin instead, which claude reads when its
        // input is not a TTY. Only oversized prompts take this path - see ./argv.
        const viaStdin = !promptFitsArgv(opts.prompt, this.extraArgs);
        const args = this.buildArgs(viaStdin ? "" : opts.prompt, opts.jsonSchema);
        const child = spawnConfigured(this.bin, args, {
            cwd: opts.cwd,
            env: gitSafeEnv(opts.cwd),
            stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
            signal
        });
        if (!child.stdout || !child.stderr) throw new Error("claude pipes unavailable");
        if (viaStdin) {
            if (!child.stdin) throw new Error("claude stdin unavailable");
            // An EPIPE here means the child died before reading; the exit error below says why.
            child.stdin.on("error", () => { /* reported through the process outcome */ });
            child.stdin.end(opts.prompt);
        }

        const outcome = awaitProcessOutcome(child);
        const stderrPromise = collectStream(child.stderr);

        const usage = emptyTokenUsage();
        let result: ClaudeResult | undefined;
        try {
            result = await parseClaudeEvents(child.stdout, signal, opts.onChunk, usage);
        } catch (err) {
            await stderrPromise;
            await outcome;
            throw new Error(`claude parse events: ${errMessage(err)}`);
        }

        const stderr = await stderrPromise;
        const settled = await outcome;
        if (settled.startError) throw new Error(`claude start: ${errMessage(settled.startError)}`);
        if (settled.exitError) throw new Error(`claude exited: ${errMessage(settled.exitError)}: ${stderr}`);

        if (result === undefined) throw new Error("claude returned no result event");

        try {
            return finalizeClaudeResult(result, opts.jsonSchema, usage);
        } catch (err) {
            if (err instanceof NoStructuredOutputError && opts.onChunk) {
                opts.onChunk(
                    `structured output missing: subtype=${result.subtype}, text_len=${result.text.length}, input_tokens=${usage.inputTokens}, output_tokens=${usage.outputTokens}`
                );
                opts.onChunk(`raw result event: ${result.rawEvent}`);
            }
            throw err;
        }
    }

    /**
     * Constructs the claude CLI arguments. User-supplied extraArgs (from
     * agent_args_override) are inserted ahead of the managed flags, so user
     * choices win over enigma's defaults. When the user supplied their own
     * permission mode, the default --dangerously-skip-permissions is not added.
     */
    private buildArgs(prompt: string, schema: unknown): string[] {
        const args: string[] = [...this.extraArgs];
        // An empty prompt means the caller is piping it to stdin, where `-p` takes no value.
        if (prompt === "") args.push("-p");
        else args.push("-p", prompt);
        args.push("--verbose", "--output-format", "stream-json");
        if (hasSchema(schema)) args.push("--json-schema", JSON.stringify(schema));
        if (!claudeUserSetPermissionMode(this.extraArgs)) args.push("--dangerously-skip-permissions");
        return args;
    }
}

/** Builds a ClaudeAgent from the resolved gate configuration. */
export function createClaude(cfg: Config, _opts?: Options): ClaudeAgent {
    return new ClaudeAgent(agentPath(cfg), agentArgs(cfg));
}

/**
 * Reports whether extraArgs already declare a permission flag, in which case
 * buildArgs skips its --dangerously-skip-permissions default.
 */
function claudeUserSetPermissionMode(extraArgs: string[]): boolean {
    return extraArgs.some(
        arg =>
            arg === "--dangerously-skip-permissions" ||
            arg === "--permission-mode" ||
            arg.startsWith("--permission-mode=")
    );
}

function finalizeClaudeResult(result: ClaudeResult, schema: unknown, usage: TokenUsage): Result {
    if (result.isError || result.subtype !== "success") {
        throw new Error(`claude error: subtype=${result.subtype}`);
    }
    if (hasSchema(schema) && result.structuredOutput === undefined) {
        throw new NoStructuredOutputError("claude returned no structured output");
    }
    return { output: result.structuredOutput, text: result.text, usage };
}

/**
 * Reads JSONL from the stream and dispatches events: accumulates token usage,
 * streams assistant text via onChunk, and captures the final result event.
 */
async function parseClaudeEvents(
    stream: Readable,
    signal: AbortSignal | undefined,
    onChunk: ((text: string) => void) | undefined,
    usage: TokenUsage
): Promise<ClaudeResult | undefined> {
    let textBuf = "";
    let result: ClaudeResult | undefined;

    await streamLines(stream, signal, line => {
        let event: unknown;
        try {
            event = JSON.parse(line);
        } catch {
            return; // skip malformed lines
        }
        const ev = asRecord(event);
        if (!ev) return;

        switch (ev.type) {
            case "assistant": {
                const msg = asRecord(ev.message);
                if (!msg) return;
                const usageMap = asRecord(msg.usage);
                if (usageMap) {
                    addTokenUsage(usage, {
                        inputTokens: numberField(usageMap, "input_tokens"),
                        outputTokens: numberField(usageMap, "output_tokens"),
                        cacheReadTokens: numberField(usageMap, "cache_read_input_tokens"),
                        cacheCreationTokens: numberField(usageMap, "cache_creation_input_tokens")
                    });
                }
                if (Array.isArray(msg.content)) {
                    for (const raw of msg.content) {
                        const c = asRecord(raw);
                        if (!c) continue;
                        if (c.type === "text" && typeof c.text === "string" && c.text !== "") {
                            textBuf += c.text;
                            onChunk?.(c.text);
                        }
                    }
                }
                break;
            }

            case "result":
                result = {
                    subtype: typeof ev.subtype === "string" ? ev.subtype : "",
                    isError: ev.is_error === true,
                    structuredOutput: hasOwn(ev, "structured_output") ? ev.structured_output : undefined,
                    text: textBuf,
                    rawEvent: line
                };
                break;
        }
    });

    return result;
}
