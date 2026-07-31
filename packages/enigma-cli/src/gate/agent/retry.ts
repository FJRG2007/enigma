/**
 * Retry/backoff helper for agent invocations.
 *
 * Faithful port of the Go `internal/agent/retry.go`: runWithRetry drives up to
 * `maxRetries + 1` attempts, retrying only when the classifier marks the error
 * transient, with exponential (base, 4x, 16x, ...) backoff plus +/-25% jitter
 * and abort-signal cancellation between attempts. classifyTransient matches the
 * same Anthropic/CLI/network needles and HTTP 429/503/529 status codes.
 *
 * Divergences:
 * - Go's `context.Context` becomes an `AbortSignal`; cancellation surfaces by
 *   rejecting the backoff and is excluded from retry (like Go's ctx errors).
 * - `errNoStructuredOutput` (defined in the not-yet-ported claude backend) is
 *   represented by the `NoStructuredOutputError` sentinel defined here so the
 *   claude classifier is complete and ready for that backend.
 */

import { Result, RunOpts } from "./agent";

/** Marks a successful agent run that nonetheless omitted structured output. */
export class NoStructuredOutputError extends Error {
    constructor(message = "agent returned no structured output") {
        super(message);
        this.name = "NoStructuredOutputError";
    }
}

/** Classifies an error, reporting whether to retry plus a telemetry label. */
export type RetryClassifier = (err: unknown) => { label: string; retry: boolean; };

/**
 * Package-level backoff between retries; overridable in tests to stay fast
 * while preserving cancellation semantics. Rejects with the abort reason when
 * the signal fires.
 */
export let transientBackoff = async (signal: AbortSignal | undefined, attempt: number): Promise<void> => {
    let delay = transientBackoffBaseDuration(attempt, 1000);
    // Apply +/-25% jitter.
    if (delay > 0) {
        const span = Math.floor(delay / 2);
        if (span > 0) {
            delay += Math.floor(Math.random() * (span + 1)) - Math.floor(delay / 4);
        }
    }
    await sleep(delay, signal);
};

/** Overrides the backoff function (test hook mirroring the Go package var). */
export function setTransientBackoff(fn: typeof transientBackoff): void {
    transientBackoff = fn;
}

/**
 * Returns the un-jittered delay (ms) for a 1-indexed retry attempt.
 * Progression: base, 4*base, 16*base, ...
 */
export function transientBackoffBaseDuration(attempt: number, base: number): number {
    if (attempt < 1) return 0;
    let delay = base;
    for (let i = 1; i < attempt; i++) delay *= 4;
    return delay;
}

/**
 * Invokes `runOnce` up to `maxRetries + 1` times, retrying when `classify`
 * marks the error retriable. Between retries it backs off (via transientBackoff)
 * and respects abort. The attempt and label are surfaced to `opts.onChunk`.
 */
export async function runWithRetry(
    signal: AbortSignal | undefined,
    name: string,
    opts: RunOpts,
    maxRetries: number,
    classify: RetryClassifier,
    recoverRetry: ((label: string) => void) | undefined,
    runOnce: () => Promise<Result>
): Promise<Result> {
    let lastErr: unknown;
    let lastLabel = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            opts.onChunk?.(
                `${name} retrying after transient error "${lastLabel}" (attempt ${attempt + 1}/${maxRetries + 1})`
            );
            await transientBackoff(signal, attempt);
        }
        try {
            return await runOnce();
        } catch (err) {
            const { label, retry } = classify(err);
            if (!retry) throw err;
            recoverRetry?.(label);
            lastErr = err;
            lastLabel = label;
        }
    }
    throw lastErr;
}

/**
 * Retries both transient API errors and the no-structured-output case that the
 * claude run loop handles.
 */
export function claudeRetryClassifier(err: unknown): { label: string; retry: boolean; } {
    if (err instanceof NoStructuredOutputError) return { label: "missing structured output", retry: true };
    return classifyTransient(err);
}

const TRANSIENT_STATUS_RE = /\b(429|503|529)\b/;

// transientNeedles matches case-insensitive substrings emitted by Anthropic API
// errors, the agent CLIs, or the network stack when the failure is recoverable
// (load shed, network blip, DNS hiccup, etc.).
const TRANSIENT_NEEDLES: ReadonlyArray<{ needle: string; label: string; }> = [
    { needle: "overloaded_error", label: "overloaded_error" },
    { needle: '"type":"overloaded"', label: "overloaded_error" },
    { needle: "rate_limit_error", label: "rate_limit_error" },
    { needle: "rate_limited", label: "rate_limited" },
    { needle: "service_unavailable", label: "service_unavailable" },
    { needle: "connection refused", label: "connection refused" },
    { needle: "connection reset", label: "connection reset" },
    { needle: "i/o timeout", label: "i/o timeout" },
    { needle: "no such host", label: "dns lookup failed" },
    { needle: "temporary failure in name resolution", label: "dns temporary failure" },
    { needle: "tls handshake", label: "tls handshake failure" },
    { needle: "unexpected eof", label: "unexpected eof" }
];

/**
 * Reports whether an error looks like a transient API or network failure. Abort
 * (cancellation/timeout) errors are never retried, mirroring Go ignoring ctx
 * cancellation/deadline errors.
 */
export function classifyTransient(err: unknown): { label: string; retry: boolean; } {
    if (err === null || err === undefined) return { label: "", retry: false };
    if (isAbortError(err)) return { label: "", retry: false };
    const msg = errMessage(err).toLowerCase();
    for (const sig of TRANSIENT_NEEDLES) {
        if (msg.includes(sig.needle)) return { label: sig.label, retry: true };
    }
    const m = TRANSIENT_STATUS_RE.exec(msg);
    if (m) return { label: `http ${m[0]}`, retry: true };
    return { label: "", retry: false };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReason(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortReason(signal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function abortReason(signal: AbortSignal | undefined): unknown {
    const reason = signal?.reason;
    if (reason !== undefined && reason !== null) return reason;
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
}

function isAbortError(err: unknown): boolean {
    const name = (err as { name?: unknown; } | null | undefined)?.name;
    return name === "AbortError" || name === "TimeoutError";
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
