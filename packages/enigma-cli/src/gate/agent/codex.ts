/**
 * Codex native-CLI agent backend.
 *
 * Faithful 1:1 port of the Go `internal/agent/codex.go`: spawns `codex exec
 * [user args] <prompt> --json [--output-schema <file>] [--dangerously-bypass-
 * approvals-and-sandbox] --color never` per invocation, streams the JSONL
 * `error`/`item.completed`/`turn.completed` events, captures the last
 * agent_message text, accumulates token usage, and resolves the text/structured
 * output via the shared text->JSON extractor.
 *
 * Divergences from Go (intentional): `context.Context` -> `AbortSignal`; the
 * parsed `opts.jsonSchema` is normalized (additionalProperties:false + nullable
 * optionals) and written to a temp file, with the normalized value reused as the
 * validation schema; "no schema" is undefined/null (Go's `len == 0`).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSafeEnv } from "./env";
import type { Readable } from "node:stream";
import { spawnConfigured } from "../shellenv";
import { CLAUDE_MAX_RETRIES } from "./claude";
import { classifyTransient, runWithRetry } from "./retry";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Config, agentArgs, agentPath } from "../config";
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

/** Spawns the codex CLI for each invocation. */
export class CodexAgent implements Agent {
    constructor(
        private readonly bin: string,
        private readonly extraArgs: string[]
    ) {}

    name(): string {
        return "codex";
    }

    run(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        return runWithRetry(signal, "codex", opts, CLAUDE_MAX_RETRIES, classifyTransient, undefined, () =>
            this.runOnce(opts, signal)
        );
    }

    async close(): Promise<void> {}

    private async runOnce(opts: RunOpts, signal?: AbortSignal): Promise<Result> {
        let schemaPath = "";
        let cleanupDir = "";
        let validationSchema = opts.jsonSchema;
        if (hasSchema(opts.jsonSchema)) {
            let dir: string;
            try {
                dir = mkdtempSync(join(tmpdir(), "enigma-gate-codex-schema-"));
            } catch (err) {
                throw new Error(`codex schema temp file: ${errMessage(err)}`);
            }
            cleanupDir = dir;
            schemaPath = join(dir, "schema.json");
            let normalized: { value: unknown; json: string };
            try {
                normalized = codexOutputSchema(opts.jsonSchema);
            } catch (err) {
                rmSync(dir, { recursive: true, force: true });
                throw new Error(`codex schema normalize: ${errMessage(err)}`);
            }
            validationSchema = normalized.value;
            try {
                writeFileSync(schemaPath, normalized.json);
            } catch (err) {
                rmSync(dir, { recursive: true, force: true });
                throw new Error(`codex schema temp file write: ${errMessage(err)}`);
            }
        }

        try {
            return await this.invoke(opts, schemaPath, validationSchema, signal);
        } finally {
            if (cleanupDir !== "") rmSync(cleanupDir, { recursive: true, force: true });
        }
    }

    private async invoke(
        opts: RunOpts,
        schemaPath: string,
        validationSchema: unknown,
        signal?: AbortSignal
    ): Promise<Result> {
        const args = this.buildArgs(opts.prompt, schemaPath);
        const child = spawnConfigured(this.bin, args, {
            cwd: opts.cwd,
            env: gitSafeEnv(opts.cwd),
            stdio: ["ignore", "pipe", "pipe"],
            signal
        });
        if (!child.stdout || !child.stderr) throw new Error("codex pipes unavailable");

        const outcome = awaitProcessOutcome(child);
        const stderrPromise = collectStream(child.stderr);

        const usage = emptyTokenUsage();
        let parsed: { lastMessage: string; codexErr: string };
        try {
            parsed = await parseCodexEvents(child.stdout, signal, opts.onChunk, usage);
        } catch (err) {
            await stderrPromise;
            await outcome;
            throw new Error(`codex parse events: ${errMessage(err)}`);
        }

        const stderr = await stderrPromise;
        const settled = await outcome;
        if (settled.startError) throw new Error(`codex start: ${errMessage(settled.startError)}`);
        if (settled.exitError) {
            let detail = parsed.codexErr.trim();
            const trimmedStderr = stderr.trim();
            if (detail !== "" && trimmedStderr !== "") detail += `; ${trimmedStderr}`;
            else if (detail === "") detail = trimmedStderr;
            throw new Error(`codex exited: ${errMessage(settled.exitError)}: ${detail}`);
        }

        return finalizeTextResult("codex", parsed.lastMessage, validationSchema, usage);
    }

    /**
     * Constructs the codex CLI arguments. User-supplied extraArgs are inserted
     * between "exec" and the prompt so user flags take effect. When the user
     * declared their own execution-mode flag, the default
     * --dangerously-bypass-approvals-and-sandbox is not added.
     */
    private buildArgs(prompt: string, schemaPath: string): string[] {
        const args: string[] = ["exec", ...this.extraArgs, prompt, "--json"];
        if (schemaPath !== "") args.push("--output-schema", schemaPath);
        if (!codexUserSetExecutionMode(this.extraArgs)) args.push("--dangerously-bypass-approvals-and-sandbox");
        args.push("--color", "never");
        return args;
    }
}

/** Builds a CodexAgent from the resolved gate configuration. */
export function createCodex(cfg: Config, _opts?: Options): CodexAgent {
    return new CodexAgent(agentPath(cfg), agentArgs(cfg));
}

/**
 * Reports whether extraArgs already declare an execution/sandbox flag that
 * conflicts with the default bypass.
 */
function codexUserSetExecutionMode(extraArgs: string[]): boolean {
    return extraArgs.some(
        arg =>
            arg === "--dangerously-bypass-approvals-and-sandbox" ||
            arg === "--ask-for-approval" ||
            arg === "--sandbox" ||
            arg.startsWith("--ask-for-approval=") ||
            arg.startsWith("--sandbox=")
    );
}

/**
 * Reads JSONL from the stream and dispatches events: records the last error
 * message, captures the last agent_message text (streamed via onChunk), and
 * accumulates token usage.
 */
async function parseCodexEvents(
    stream: Readable,
    signal: AbortSignal | undefined,
    onChunk: ((text: string) => void) | undefined,
    usage: TokenUsage
): Promise<{ lastMessage: string; codexErr: string }> {
    let lastMessage = "";
    let codexErr = "";

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
            case "error":
                if (typeof ev.message === "string" && ev.message !== "") codexErr = ev.message;
                break;

            case "item.completed": {
                const item = asRecord(ev.item);
                if (item && item.type === "agent_message") {
                    const text = typeof item.text === "string" ? item.text : "";
                    lastMessage = text;
                    onChunk?.(text);
                }
                break;
            }

            case "turn.completed": {
                const u = asRecord(ev.usage);
                if (u) {
                    addTokenUsage(usage, {
                        inputTokens: numberField(u, "input_tokens"),
                        outputTokens: numberField(u, "output_tokens"),
                        cacheReadTokens: numberField(u, "cached_input_tokens"),
                        cacheCreationTokens: 0
                    });
                }
                break;
            }
        }
    });

    return { lastMessage, codexErr };
}

/** Normalizes a parsed JSON Schema for codex's --output-schema (clone + mutate). */
function codexOutputSchema(schema: unknown): { value: unknown; json: string } {
    const value: unknown = JSON.parse(JSON.stringify(schema));
    addAdditionalPropertiesFalse(value);
    return { value, json: JSON.stringify(value) };
}

function addAdditionalPropertiesFalse(value: unknown): void {
    const schema = asRecord(value);
    if (!schema) return;

    const required = requiredSet(schema);
    if (schema.type === "object" && !hasOwn(schema, "additionalProperties")) {
        schema.additionalProperties = false;
    }
    const properties = asRecord(schema.properties);
    if (properties) {
        const names = Object.keys(properties).sort();
        if (schema.type === "object") schema.required = names;
        for (const name of names) {
            const property = properties[name];
            addAdditionalPropertiesFalse(property);
            if (!required.has(name)) allowSchemaNull(property);
        }
    }
    if (hasOwn(schema, "items")) addAdditionalPropertiesFalse(schema.items);
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
    const required = new Set<string>();
    if (Array.isArray(schema.required)) {
        for (const item of schema.required) if (typeof item === "string") required.add(item);
    }
    return required;
}

function allowSchemaNull(value: unknown): void {
    const schema = asRecord(value);
    if (!schema) return;

    const enumValues = schema.enum;
    if (Array.isArray(enumValues) && !enumValues.includes(null)) {
        schema.enum = [...enumValues, null];
    }
    const typ = schema.type;
    if (typeof typ === "string") {
        if (typ !== "null") schema.type = [typ, "null"];
    } else if (Array.isArray(typ)) {
        if (!typ.includes("null")) schema.type = [...typ, "null"];
    }
}
