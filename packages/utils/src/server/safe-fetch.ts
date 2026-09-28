/**
 * An HTTP client for URLs somebody else chose: a link to preview, a webhook to call, an
 * icon to fetch, an image to import. It refuses to reach this machine, its network, or the
 * cloud metadata service, and it cannot be talked past that refusal.
 *
 * The usual guard gets one thing wrong, and it is the whole attack: it resolves the host,
 * checks the addresses, then hands the HOSTNAME to `fetch`, which resolves it again. The two
 * answers are independent, so a name that is public on the check and private on the connect
 * (DNS rebinding) walks straight through. Here there is one resolution per connection: the
 * address is vetted inside the socket's own `lookup`, so the address checked is the address
 * connected to. An IP literal never reaches `lookup`, so it is vetted before the request.
 *
 * Every redirect is a new request to a new host and goes through the same gate, and the
 * credentials the caller attached are dropped when a redirect leaves the origin.
 *
 * Node only (`node:http`/`node:https`), with no dependencies: bringing undici in to pin the
 * address is how the same guard broke before, when the runtime's built-in fetch refused an
 * Agent built by a second copy of undici.
 */

import { isIP } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns";

export type SafeFetchFailure =
    | "invalid-url"
    | "blocked-scheme"
    | "blocked-port"
    | "credentials-in-url"
    | "blocked-address"
    | "unresolvable"
    | "too-many-redirects"
    | "redirect-refused"
    | "too-large"
    | "timeout"
    | "network";

/** Every refusal and failure, with a reason a caller can branch on. Never a guess of "fine". */
export class SafeFetchError extends Error {
    readonly reason: SafeFetchFailure;

    constructor(reason: SafeFetchFailure, message: string, options?: { cause?: unknown; }) {
        super(message, options);
        this.name = "SafeFetchError";
        this.reason = reason;
    }
}

export interface SafeFetchOptions {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: string | Uint8Array | null;
    signal?: AbortSignal;
    /** Whole-request budget in ms, redirects included. Default 10 s. */
    timeout?: number;
    /** The body is read into memory up to this many bytes, then refused. Default 10 MiB. */
    maxBytes?: number;
    /** Redirects followed before giving up. Default 5. */
    maxRedirects?: number;
    /** "follow" (default), "manual" returns the 3xx as is, "error" refuses it. */
    redirect?: "follow" | "manual" | "error";
    /** Ports a URL may name. Default: any, since the address check is what keeps it off the network. */
    ports?: number[];
    /**
     * Widen the address policy, never replace it blindly: return true to allow an address the
     * default refuses (an internal service this feature is meant to reach). Default: public only.
     */
    allowAddress?: (address: string, family: 4 | 6) => boolean;
    /** The resolver. Default `dns.lookup` (honours the hosts file, like fetch does). For tests and custom DNS. */
    resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
/** Headers that carry the caller's identity and must not follow a redirect to another origin. */
const ORIGIN_BOUND_HEADERS = ["authorization", "cookie", "proxy-authorization"];

// --- the address policy ----------------------------------------------------------------

/** IPv4 ranges that are not the public internet (RFC 6890 special-purpose, plus multicast and reserved). */
const IPV4_BLOCKED: Array<[number, number]> = [
    [0x00000000, 8], // "this network"
    [0x0a000000, 8], // private
    [0x64400000, 10], // carrier-grade NAT
    [0x7f000000, 8], // loopback
    [0xa9fe0000, 16], // link-local, cloud metadata (169.254.169.254)
    [0xac100000, 12], // private
    [0xc0000000, 24], // IETF protocol assignments
    [0xc0000200, 24], // documentation
    [0xc0586300, 24], // 6to4 relay anycast
    [0xc0a80000, 16], // private
    [0xc6120000, 15], // benchmarking
    [0xc6336400, 24], // documentation
    [0xcb007100, 24], // documentation
    [0xe0000000, 4], // multicast
    [0xf0000000, 4] // reserved, broadcast
];

function ipv4ToInt(address: string): number | null {
    const parts = address.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

function publicIpv4(value: number): boolean {
    return !IPV4_BLOCKED.some(([base, bits]) => {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return ((value & mask) >>> 0) === base;
    });
}

/** Eight 16-bit groups, or null when it is not an IPv6 address. Accepts a zone id and an embedded IPv4 tail. */
function ipv6Groups(address: string): number[] | null {
    let text = address.replace(/^\[|\]$/g, "").split("%")[0]!;
    const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (tail) {
        const v4 = ipv4ToInt(tail[1]!);
        if (v4 === null) return null;
        text = `${text.slice(0, tail.index)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
}

function publicIpv6(groups: number[]): boolean {
    const [a, b] = groups as [number, number];
    const embedded = (): number => ((groups[6]! << 16) >>> 0) + groups[7]!;
    // ::ffff:a.b.c.d (mapped) and 64:ff9b::a.b.c.d (NAT64) reach the IPv4 address they carry.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return publicIpv4(embedded());
    if (a === 0x64 && b === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return publicIpv4(embedded());
    // 2002::/16 (6to4) carries its IPv4 address in the second and third groups.
    if (a === 0x2002) return publicIpv4(((b << 16) >>> 0) + groups[2]!);
    // Only global unicast (2000::/3) is public; ::, ::1, IPv4-compatible, ULA, link-local and
    // multicast all fall outside it. Inside it: IETF protocol assignments (incl. Teredo) and
    // documentation.
    if ((a & 0xe000) !== 0x2000) return false;
    if (a === 0x2001 && b < 0x0200) return false; // 2001::/23
    if (a === 0x2001 && b === 0x0db8) return false; // 2001:db8::/32
    if ((a & 0xfff0) === 0x3ff0) return false; // 3fff::/20 documentation
    return true;
}

/**
 * Is this address on the public internet? False for loopback, private, link-local (the cloud
 * metadata service), carrier-grade NAT, documentation, multicast and reserved ranges, and for
 * IPv6 forms that carry one of those IPv4 addresses (mapped, NAT64, 6to4). False for anything
 * that does not parse, too - an address this cannot read is not one it can vouch for.
 */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address.replace(/^\[|\]$/g, "").split("%")[0]!);
    if (family === 4) {
        const value = ipv4ToInt(address);
        return value !== null && publicIpv4(value);
    }
    if (family === 6) {
        const groups = ipv6Groups(address);
        return groups !== null && publicIpv6(groups);
    }
    return false;
}

// --- the request -----------------------------------------------------------------------

interface Policy {
    allow: (address: string, family: 4 | 6) => boolean;
    resolve: (hostname: string) => Promise<LookupAddress[]>;
}

function defaultResolve(hostname: string): Promise<LookupAddress[]> {
    return new Promise((done, fail) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? fail(error) : done(addresses)));
    });
}

/** The URL checks that need no network: scheme, embedded credentials, port. */
function checkUrl(url: URL, ports: number[] | undefined): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new SafeFetchError("blocked-scheme", `Only http and https URLs are fetched, not ${url.protocol}`);
    }
    if (url.username || url.password) {
        throw new SafeFetchError("credentials-in-url", "A URL carrying a user name or password is not fetched.");
    }
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (ports && !ports.includes(port)) throw new SafeFetchError("blocked-port", `Port ${port} is not allowed.`);
}

/**
 * The socket's resolver. It resolves once, refuses the whole answer when ANY address in it is
 * not allowed (a name answering with one public and one private record is an attack, not a
 * choice), and hands the socket exactly the addresses it checked - all of them when the
 * socket asks for all (Node's happy-eyeballs connect does), the first otherwise.
 */
function vettedLookup(policy: Policy): NonNullable<http.RequestOptions["lookup"]> {
    return ((hostname: string, options: { all?: boolean; }, callback: (...args: unknown[]) => void) => {
        policy.resolve(hostname).then((addresses) => {
            if (!addresses.length) {
                callback(new SafeFetchError("unresolvable", `${hostname} did not resolve.`));
                return;
            }
            const refused = addresses.find((entry) => !policy.allow(entry.address, entry.family as 4 | 6));
            if (refused) {
                callback(new SafeFetchError("blocked-address", `${hostname} resolves to an address that is not public.`));
                return;
            }
            if (options?.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
        }, (cause: unknown) => callback(new SafeFetchError("unresolvable", `${hostname} did not resolve.`, { cause })));
    }) as NonNullable<http.RequestOptions["lookup"]>;
}

interface Hop {
    status: number;
    statusText: string;
    headers: Headers;
    body: Uint8Array<ArrayBuffer> | null;
}

function toHeaders(raw: string[]): Headers {
    const headers = new Headers();
    for (let i = 0; i + 1 < raw.length; i += 2) {
        try {
            headers.append(raw[i]!, raw[i + 1]!);
        } catch {
            // A header value the fetch Headers class refuses (a control character): dropped,
            // since passing it through would hand the caller something no fetch ever returns.
        }
    }
    return headers;
}

function send(url: URL, method: string, headers: Headers, body: Uint8Array | null, policy: Policy, maxBytes: number, signal: AbortSignal): Promise<Hop> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    // A literal address never reaches `lookup`, so it is judged here.
    const literal = isIP(hostname);
    if (literal && !policy.allow(hostname, literal as 4 | 6)) {
        return Promise.reject(new SafeFetchError("blocked-address", `${hostname} is not a public address.`));
    }
    const client = url.protocol === "https:" ? https : http;
    const outgoing: Record<string, string> = {};
    headers.forEach((value, name) => { outgoing[name] = value; });
    // Identity only: this client does not decompress, and a compressed body would slip past maxBytes.
    outgoing["accept-encoding"] = "identity";
    if (body) outgoing["content-length"] = String(body.byteLength);

    return new Promise<Hop>((done, fail) => {
        const request = client.request(url, { method, headers: outgoing, agent: false, lookup: vettedLookup(policy), signal }, (response) => {
            const status = response.statusCode ?? 0;
            const declared = Number(response.headers["content-length"]);
            if (Number.isFinite(declared) && declared > maxBytes) {
                response.destroy();
                fail(new SafeFetchError("too-large", `The response is ${declared} bytes, over the ${maxBytes} byte limit.`));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                    response.destroy();
                    fail(new SafeFetchError("too-large", `The response is over the ${maxBytes} byte limit.`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("error", (cause) => fail(new SafeFetchError("network", "The response was cut off.", { cause })));
            response.on("end", () => {
                done({
                    status,
                    statusText: response.statusMessage ?? "",
                    headers: toHeaders(response.rawHeaders),
                    body: NULL_BODY_STATUS.has(status) || method === "HEAD" ? null : new Uint8Array(Buffer.concat(chunks))
                });
            });
        });
        request.on("error", (cause: Error) => {
            if (cause instanceof SafeFetchError) fail(cause);
            else if (signal.aborted) fail(signal.reason instanceof SafeFetchError ? signal.reason : cause);
            else fail(new SafeFetchError("network", `Could not reach ${url.host}.`, { cause }));
        });
        request.end(body ?? undefined);
    });
}

function encodeBody(body: SafeFetchOptions["body"]): Uint8Array | null {
    if (body === null || body === undefined) return null;
    return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * Fetch a URL that came from outside, the way `fetch` would, minus the ways it can be turned
 * against the network it runs in. Resolves to a standard `Response` whose body is already in
 * memory (capped by `maxBytes`); `response.url` is the final URL after redirects.
 *
 * @throws SafeFetchError with a `reason` for every refusal and failure.
 */
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<Response> {
    let url: URL;
    try {
        url = new URL(String(input));
    } catch (cause) {
        throw new SafeFetchError("invalid-url", "That is not a URL.", { cause });
    }
    const policy: Policy = {
        allow: (address, family) => isPublicAddress(address) || (options.allowAddress?.(address, family) ?? false),
        resolve: options.resolve ?? defaultResolve
    };
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const mode = options.redirect ?? "follow";

    // One deadline for the whole exchange, joined with the caller's own signal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SafeFetchError("timeout", "The request took too long.")), options.timeout ?? DEFAULT_TIMEOUT);
    const forward = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forward();
    options.signal?.addEventListener("abort", forward, { once: true });

    let method = (options.method ?? "GET").toUpperCase();
    let body = encodeBody(options.body);
    const headers = new Headers(options.headers);
    try {
        for (let hop = 0; ; hop++) {
            checkUrl(url, options.ports);
            const answer = await send(url, method, headers, body, policy, maxBytes, controller.signal);
            const location = answer.headers.get("location");
            if (!REDIRECT_STATUS.has(answer.status) || !location || mode === "manual") {
                const response = new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
                Object.defineProperty(response, "url", { value: url.href });
                Object.defineProperty(response, "redirected", { value: hop > 0 });
                return response;
            }
            if (mode === "error") throw new SafeFetchError("redirect-refused", `The server redirected to ${location}.`);
            if (hop >= maxRedirects) throw new SafeFetchError("too-many-redirects", `More than ${maxRedirects} redirects.`);
            let next: URL;
            try {
                next = new URL(location, url);
            } catch (cause) {
                throw new SafeFetchError("invalid-url", "The server redirected to something that is not a URL.", { cause });
            }
            if (next.origin !== url.origin) for (const name of ORIGIN_BOUND_HEADERS) headers.delete(name);
            // What browsers do: 303 always becomes a GET, and so does a POST answered with 301/302.
            if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method === "POST")) {
                if (method !== "HEAD") method = "GET";
                body = null;
                headers.delete("content-type");
            }
            url = next;
        }
    } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        if (controller.signal.aborted && !options.signal?.aborted) throw new SafeFetchError("timeout", "The request took too long.", { cause: error });
        throw error;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", forward);
    }
}
