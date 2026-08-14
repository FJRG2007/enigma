/**
 * Has this password appeared in a breach? Answered without sending the password anywhere.
 *
 * Have I Been Pwned's range API is k-anonymous: the password is hashed with SHA-1 in the
 * browser, the FIRST FIVE hex characters of that hash are sent, and the service returns
 * every hash suffix it knows starting with those five - somewhere around 500 to 1000 of
 * them. The match is done here, against a list. The service never learns which one was
 * being looked for, and never sees the password or its full hash.
 *
 * SHA-1 is not a security decision here and is not protecting anything; it is the index the
 * corpus is published under.
 *
 * This deliberately does NOT decide what to show the visitor. A breached password is a
 * warning in one form, a hard block in another, and a field-level error message in a third,
 * and each form already has its own way of rendering that. It reports a count and throws
 * what it cannot do.
 */

import { createCache, type Cache } from "@/core/cache";

const ENDPOINT = "https://api.pwnedpasswords.com/range";
/** The prefix length the API is built around; it is not a tunable. */
const PREFIX = 5;

export type BreachFailure = "insecure-context" | "network" | "service";

/** Thrown rather than swallowed, so the form decides what a failed check means. */
export class PasswordBreachError extends Error {
    readonly reason: BreachFailure;

    constructor(reason: BreachFailure, message: string, options?: { cause?: unknown; }) {
        super(message, options);
        this.name = "PasswordBreachError";
        this.reason = reason;
    }
}

export interface PasswordBreachOptions {
    /** Point at your own proxy. The path `${endpoint}/${prefix}` is requested. */
    endpoint?: string;
    /**
     * Ask the service to pad the response with decoy entries, so its size cannot be used
     * to narrow down which prefix was asked for. On by default; it costs a few KB.
     */
    padding?: boolean;
    signal?: AbortSignal;
    /** Swap the transport - for a test, or to route the request through your own stack. */
    fetch?: typeof globalThis.fetch;
    /**
     * Range responses are cached, so re-checking as someone types costs one request per
     * distinct prefix rather than one per keystroke. Pass your own to share or to disable.
     */
    cache?: Cache | null;
}

export interface PasswordBreachResult {
    breached: boolean;
    /** How many times it appears in the corpus. 0 when it does not. */
    count: number;
}

/** One cache per module, five minutes: long enough for a form, short enough to stay fresh. */
const ranges: Cache = createCache({ ttl: 5 * 60 * 1000 });

async function sha1Hex(text: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        // Not a browser quirk to work around: WebCrypto is absent on http:// pages, and
        // hashing in JavaScript instead would be slower and no more private.
        throw new PasswordBreachError("insecure-context", "Checking a password against Have I Been Pwned needs WebCrypto, which browsers only expose over HTTPS (or on localhost).");
    }
    const digest = await subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Look up one password.
 *
 * @returns how many breaches it appears in. An empty password is 0 without a request.
 * @throws PasswordBreachError when the answer cannot be obtained. Never guesses "safe".
 */
export async function checkPasswordBreach(password: string, options: PasswordBreachOptions = {}): Promise<PasswordBreachResult> {
    if (!password) return { breached: false, count: 0 };

    const { endpoint = ENDPOINT, padding = true, signal, cache = ranges } = options;
    const request = options.fetch ?? globalThis.fetch;
    if (typeof request !== "function") {
        throw new PasswordBreachError("network", "No fetch implementation is available in this runtime.");
    }

    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, PREFIX);
    const suffix = hash.slice(PREFIX);

    const load = async (): Promise<string> => {
        let response: Response;
        try {
            response = await request(`${endpoint}/${prefix}`, {
                headers: padding ? { "Add-Padding": "true" } : undefined,
                signal
            });
        } catch (cause) {
            // An abort is the caller's own doing and stays an AbortError, so a component
            // that cancels on the next keystroke does not report a network failure.
            if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
            throw new PasswordBreachError("network", "Could not reach the breach corpus.", { cause });
        }
        if (!response.ok) {
            throw new PasswordBreachError("service", `The breach corpus answered ${response.status}.`);
        }
        return response.text();
    };

    const body = cache ? await cache.read(`hibp:${prefix}`, load) : await load();
    const count = countIn(body, suffix);
    return { breached: count > 0, count };
}

/**
 * Find the suffix in a range response.
 *
 * Padded responses carry decoy entries with a count of 0; those are indistinguishable from
 * a real line except by that zero, so a hit has to be a hit with a count above it.
 */
function countIn(body: string, suffix: string): number {
    for (const line of body.split("\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        if (line.slice(0, separator).trim().toUpperCase() !== suffix) continue;
        const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
        return Number.isFinite(count) ? count : 0;
    }
    return 0;
}
