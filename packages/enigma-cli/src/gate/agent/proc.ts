/**
 * Shared subprocess plumbing for the native-CLI agent backends (claude, codex,
 * pi). These ports replace Go's `cmd.StdoutPipe`/`StderrPipe`/`Wait` and the
 * concurrent stderr goroutine with Node stream primitives:
 *
 * - `awaitProcessOutcome` mirrors `cmd.Start`/`cmd.Wait`, distinguishing a spawn
 *   failure (Go's Start error) from a non-zero/signal exit (Go's Wait error).
 * - `collectStream` mirrors the stderr `io.ReadAll` goroutine and, like Go,
 *   ignores read errors (best-effort capture).
 * - `streamLines` mirrors `bufio.Scanner` over stdout: it yields each non-empty
 *   line and honors the AbortSignal between lines (the equivalent of Go's
 *   `select { case <-ctx.Done(): return ctx.Err() }`).
 *
 * Node-builtins only; the abort itself (whole-tree kill) is wired by
 * `spawnConfigured` in `../shellenv`.
 */

import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";

/** Outcome of a spawned process: a start failure xor an exit failure. */
export interface ProcessOutcome {
    /** Set when the binary could not be spawned (Go's `cmd.Start` error). */
    startError?: Error;
    /** Set when the process exited non-zero or was killed by a signal. */
    exitError?: Error;
}

/**
 * Resolves once the child has fully settled. Listeners are attached eagerly by
 * the caller (before any output is consumed) so neither the `error` nor the
 * `close` event can be missed.
 */
export function awaitProcessOutcome(child: ChildProcess): Promise<ProcessOutcome> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (outcome: ProcessOutcome): void => {
            if (settled) return;
            settled = true;
            resolve(outcome);
        };
        child.once("error", err => finish({ startError: err as Error }));
        child.once("close", (code, signal) => {
            if (code === 0) finish({});
            else finish({ exitError: new Error(describeExit(code, signal)) });
        });
    });
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) return `signal: ${signal}`;
    return `exit status ${code ?? -1}`;
}

/**
 * Reads a stream fully to a UTF-8 string. A read error resolves with whatever
 * was buffered so far, matching Go's `stderrBuf, _ = io.ReadAll(stderrR)`.
 */
export function collectStream(stream: Readable): Promise<string> {
    return new Promise(resolve => {
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", chunk => {
            data += chunk;
        });
        stream.once("end", () => resolve(data));
        stream.once("error", () => resolve(data));
    });
}

/**
 * Reads newline-delimited JSONL from `stream`, invoking `onLine` for each
 * non-empty line. Throws the abort reason when `signal` fires between lines, so
 * a cancelled run surfaces as a parse error (Go's `ctx.Err()`).
 */
export async function streamLines(
    stream: Readable,
    signal: AbortSignal | undefined,
    onLine: (line: string) => void
): Promise<void> {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            if (signal?.aborted) throw abortReason(signal);
            if (line.length === 0) continue;
            onLine(line);
        }
    } finally {
        rl.close();
    }
}

/** Returns the abort signal's reason, or a synthetic AbortError. */
export function abortReason(signal: AbortSignal): unknown {
    const reason = signal.reason;
    if (reason !== undefined && reason !== null) return reason;
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
}

/** Narrows an unknown JSON value to a plain object, or returns undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Reads a numeric field, defaulting to 0 for absent/non-numeric values. */
export function numberField(obj: Record<string, unknown>, key: string): number {
    const v = obj[key];
    return typeof v === "number" ? v : 0;
}

/** Reports whether a parsed JSON Schema is present (not undefined/null). */
export function hasSchema(schema: unknown): boolean {
    return schema !== undefined && schema !== null;
}

/** Extracts an error message, mirroring Go's `%w`/`%s` formatting. */
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Reports whether `obj` has its own `key` (Go's map-membership check). */
export function hasOwn(obj: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}
