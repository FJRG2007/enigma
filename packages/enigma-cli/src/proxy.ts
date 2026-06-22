/**
 * Optional MEASURING proxy for Claude Code. Opt-in, default OFF, Claude Code only,
 * experimental. Claude Code honors ANTHROPIC_BASE_URL; when the `proxy` toggle is on,
 * `enigma claude` starts this loopback proxy and points Claude Code at it for that launch
 * only (no global env change). It forwards every request verbatim to api.anthropic.com -
 * method, path, headers (incl. auth), body, streaming - and streams the response straight
 * back. It ONLY reads token usage from the response to record real stats.
 *
 * Safety / faithfulness (this must NEVER break Claude Code):
 *  - Transparent pass-through: request and response bytes are forwarded unchanged.
 *  - The single deviation is dropping `accept-encoding` so the response is identity-coded
 *    and usage is readable without gunzip; the client still gets a correct, complete reply.
 *  - Measurement is best-effort and fully isolated: any parse/record error is swallowed and
 *    never affects the forwarded bytes.
 *  - Auth headers and message content are NEVER stored - only token counts and the model id.
 *  - Loopback bind only (127.0.0.1); upstream is hardcoded to api.anthropic.com over HTTPS.
 *
 * By default this is a faithful relay (no compression/cache rewriting) - measurement must
 * not change what Claude receives. The ONE opt-in exception is the prompt secret guard
 * (off by default): when enabled it buffers POST /v1/messages bodies and redacts or rejects
 * detected credentials before forwarding, so a secret pasted into chat never reaches the
 * model. Everything else still streams through verbatim. Detection reuses guard.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildSecretMatchers, findSecrets, redactSecrets, type SecretMatcher } from "./guard";

const UPSTREAM_HOST = "api.anthropic.com";

/**
 * Where the proxy forwards. Hardcoded to api.anthropic.com over HTTPS; `ENIGMA_PROXY_UPSTREAM`
 * (e.g. http://127.0.0.1:PORT for tests, or an https mirror) overrides it. The override is
 * the only way the upstream changes, so the default install can only ever reach Anthropic.
 */
function upstream(): { host: string; port: number; request: typeof httpsRequest } {
    const raw = process.env.ENIGMA_PROXY_UPSTREAM;
    if (raw) {
        try {
            const u = new URL(raw);
            const isHttp = u.protocol === "http:";
            return { host: u.hostname, port: Number(u.port) || (isHttp ? 80 : 443), request: isHttp ? httpRequest : httpsRequest };
        } catch { /* malformed override: fall back to Anthropic */ }
    }
    return { host: UPSTREAM_HOST, port: 443, request: httpsRequest };
}

export interface ProxyUsage {
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    /** Epoch ms of the last measured request to Claude; 0 if the proxy has never recorded one. */
    lastRequestAt: number;
    /** Prompt secret guard: how many outgoing messages had a secret redacted out. */
    redacted: number;
    /** Prompt secret guard: how many outgoing requests were rejected entirely. */
    rejected: number;
    /** Epoch ms of the last time the prompt secret guard acted (redact or reject). */
    lastBlockedAt: number;
    byModel: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheCreation: number }>;
}

const EMPTY: ProxyUsage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, lastRequestAt: 0, redacted: 0, rejected: 0, lastBlockedAt: 0, byModel: {} };

/** Directory for the proxy's stats/limits files. `ENIGMA_PROXY_DIR` overrides it (tests). */
function proxyDir(): string {
    return process.env.ENIGMA_PROXY_DIR || join(homedir(), ".enigma", "proxy");
}

function statsPath(): string {
    return join(proxyDir(), "stats.json");
}

/** Cumulative token usage measured by the proxy so far. */
export function readProxyStats(): ProxyUsage {
    try { return { ...EMPTY, ...JSON.parse(readFileSync(statsPath(), "utf8")) }; } catch { return { ...EMPTY }; }
}

/** One rate-limit window from Anthropic's response headers: utilization (0..1) + reset (ms). */
export interface ProxyLimitWindow { utilization: number; resetsAt: number; }

/**
 * The REAL usage limits Anthropic reports in `/v1/messages` response headers - the same
 * numbers Claude Code's own UI shows. Captured by the proxy from genuine traffic (no extra
 * API call). Per-model (opus/sonnet) windows are only present when Anthropic sends them.
 */
export interface ProxyLimits {
    session: ProxyLimitWindow | null;
    weekly: ProxyLimitWindow | null;
    weeklyOpus: ProxyLimitWindow | null;
    weeklySonnet: ProxyLimitWindow | null;
    capturedAt: number;
}

function limitsPath(): string {
    return join(proxyDir(), "limits.json");
}

/** The last captured real rate-limit windows, or null if none seen yet. */
export function readProxyLimits(): ProxyLimits | null {
    try { return JSON.parse(readFileSync(limitsPath(), "utf8")) as ProxyLimits; } catch { return null; }
}

/**
 * Capture Anthropic's `anthropic-ratelimit-unified-*` headers from a response and persist
 * them (merging with the previous snapshot so a response missing a window keeps the last
 * known value). Best-effort; never throws and never affects the forwarded response.
 */
function recordLimits(headers: import("node:http").IncomingHttpHeaders): void {
    try {
        const num = (k: string): number | null => {
            const v = headers[k];
            if (v == null) return null;
            const n = Number(Array.isArray(v) ? v[0] : v);
            return Number.isFinite(n) ? n : null;
        };
        const win = (u: number | null, r: number | null): ProxyLimitWindow | null => u == null ? null : { utilization: u, resetsAt: r != null && r > 0 ? r * 1000 : 0 };
        const session = win(num("anthropic-ratelimit-unified-5h-utilization"), num("anthropic-ratelimit-unified-5h-reset"));
        const weekly = win(num("anthropic-ratelimit-unified-7d-utilization"), num("anthropic-ratelimit-unified-7d-reset"));
        const weeklyOpus = win(num("anthropic-ratelimit-unified-7d-opus-utilization"), num("anthropic-ratelimit-unified-7d-opus-reset"));
        const weeklySonnet = win(num("anthropic-ratelimit-unified-7d-sonnet-utilization"), num("anthropic-ratelimit-unified-7d-sonnet-reset"));
        if (!session && !weekly && !weeklyOpus && !weeklySonnet) return; // no rate-limit headers on this response
        const prev = readProxyLimits();
        const next: ProxyLimits = {
            session: session ?? prev?.session ?? null,
            weekly: weekly ?? prev?.weekly ?? null,
            weeklyOpus: weeklyOpus ?? prev?.weeklyOpus ?? null,
            weeklySonnet: weeklySonnet ?? prev?.weeklySonnet ?? null,
            capturedAt: Date.now(),
        };
        const dir = proxyDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(limitsPath(), JSON.stringify(next, null, 2) + "\n");
    } catch { /* best-effort */ }
}

interface OneCall { model: string; input: number; output: number; cacheRead: number; cacheCreation: number; }

/** Fold one measured call into the cumulative store. Best-effort; never throws. */
function recordCall(c: OneCall): void {
    try {
        const cur = readProxyStats();
        const m = (cur.byModel[c.model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
        cur.calls++; cur.input += c.input; cur.output += c.output; cur.cacheRead += c.cacheRead; cur.cacheCreation += c.cacheCreation;
        cur.lastRequestAt = Date.now();
        m.calls++; m.input += c.input; m.output += c.output; m.cacheRead += c.cacheRead; m.cacheCreation += c.cacheCreation;
        const dir = proxyDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(statsPath(), JSON.stringify(cur, null, 2) + "\n");
    } catch { /* stats are best-effort */ }
}

/** Record one prompt secret guard action (a redaction or a full rejection). Best-effort. */
function recordBlock(mode: "redact" | "reject"): void {
    try {
        const cur = readProxyStats();
        if (mode === "redact") cur.redacted++; else cur.rejected++;
        cur.lastBlockedAt = Date.now();
        const dir = proxyDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(statsPath(), JSON.stringify(cur, null, 2) + "\n");
    } catch { /* stats are best-effort */ }
}

/** Pull the largest `usage` object and the model id out of a Messages API response body. */
export function parseUsage(path: string, body: string): OneCall | null {
    if (!path.includes("/v1/messages")) return null;
    let model = "";
    let input = 0, cacheRead = 0, cacheCreation = 0, output = 0;
    // Works for both streaming SSE (message_start carries input + model, message_delta the
    // final cumulative output) and a single non-streaming JSON body (one usage object).
    const usageRe = /"usage"\s*:\s*\{[^}]*\}/g;
    let m: RegExpExecArray | null;
    while ((m = usageRe.exec(body))) {
        const u = m[0];
        const n = (key: string): number => { const r = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(u); return r ? Number(r[1]) : 0; };
        input = Math.max(input, n("input_tokens"));
        cacheRead = Math.max(cacheRead, n("cache_read_input_tokens"));
        cacheCreation = Math.max(cacheCreation, n("cache_creation_input_tokens"));
        output = Math.max(output, n("output_tokens"));
    }
    const mm = /"model"\s*:\s*"([^"]+)"/.exec(body);
    if (mm) model = mm[1];
    if (!input && !output && !cacheRead && !cacheCreation) return null;
    return { model: model || "unknown", input, output, cacheRead, cacheCreation };
}

export interface RunningProxy { url: string; port: number; close: () => void; }

/** Prompt secret guard options. Omitted/off = byte-faithful pass-through (unchanged behavior). */
export interface ProxyOptions {
    /** Scan outgoing POST /v1/messages bodies for secrets and act on them. */
    scanPrompts?: boolean;
    /** On a hit: "redact" (default) strips each secret; "reject" blocks the whole request. */
    mode?: "redact" | "reject";
    /** Extra user secret regex sources to detect on top of the built-in patterns. */
    extraPatterns?: string[];
}

/**
 * Start the loopback proxy and resolve once it is listening. The caller injects its url
 * as ANTHROPIC_BASE_URL for the Claude Code launch and closes it when Claude exits.
 *
 * With no options it is a byte-faithful measuring relay (behavior unchanged). When
 * `scanPrompts` is on, POST /v1/messages bodies are buffered and scanned for secrets
 * before forwarding: "redact" replaces each secret with a placeholder so the key never
 * reaches Claude but the turn still works; "reject" blocks the request with an
 * Anthropic-style 400 so nothing reaches Claude. Every other request, and the response,
 * is still forwarded verbatim, and usage is measured exactly as before.
 */
export function startMeasuringProxy(options: ProxyOptions = {}): Promise<RunningProxy> {
    const scanPrompts = !!options.scanPrompts;
    const mode: "redact" | "reject" = options.mode === "reject" ? "reject" : "redact";
    const matchers: SecretMatcher[] = scanPrompts ? buildSecretMatchers(options.extraPatterns || []) : [];

    // Forward one request to Anthropic and stream the response back, measuring usage.
    // `body` non-null = send that exact buffer (a scanned/redacted body); null = stream
    // the original request through unchanged (the faithful pass-through path).
    const forward = (req: IncomingMessage, res: ServerResponse, body: Buffer | null): void => {
        const up = upstream();
        const headers = { ...req.headers };
        headers.host = up.host;
        // Ask upstream for an un-encoded body so usage is readable; the client still gets a
        // complete, correct response (just not gzip-compressed).
        delete headers["accept-encoding"];
        if (body) {
            // A rewritten body has a new length and is no longer chunked.
            headers["content-length"] = String(body.length);
            delete headers["transfer-encoding"];
        }
        const upReq = up.request(
            { host: up.host, port: up.port, method: req.method, path: req.url, headers },
            (upRes) => {
                res.writeHead(upRes.statusCode || 502, upRes.headers);
                // Capture Anthropic's real rate-limit windows (the numbers Claude's UI shows).
                recordLimits(upRes.headers);
                const path = req.url || "";
                const chunks: Buffer[] = [];
                let captured = 0;
                const CAP = 16 * 1024 * 1024; // bound memory: stop capturing past 16 MB (still forwards)
                upRes.on("data", (chunk: Buffer) => {
                    res.write(chunk); // forward verbatim, always
                    if (captured < CAP) { chunks.push(chunk); captured += chunk.length; }
                });
                upRes.on("end", () => {
                    res.end();
                    try {
                        const call = parseUsage(path, Buffer.concat(chunks).toString("utf8"));
                        if (call) recordCall(call);
                    } catch { /* measurement must never affect the forwarded response */ }
                });
                upRes.on("error", () => { try { res.end(); } catch { /* already closed */ } });
            },
        );
        upReq.on("error", () => { try { if (!res.headersSent) res.writeHead(502); res.end(); } catch { /* already closed */ } });
        // If Claude Code disconnects (its own timeout, Ctrl+C, etc.), tear down the upstream
        // request so the proxy never leaks a hung socket waiting on Anthropic.
        res.on("close", () => { try { upReq.destroy(); } catch { /* already gone */ } });
        if (body) upReq.end(body); else req.pipe(upReq);
    };

    const server: Server = createServer((req, res) => {
        const path = req.url || "";
        const isMessages = req.method === "POST" && path.includes("/v1/messages");
        // Fast path: faithful pass-through unless there is a prompt to scan.
        if (!scanPrompts || !isMessages) { forward(req, res, null); return; }
        // Buffer the request body so we can scan/redact it before forwarding.
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("error", () => { try { if (!res.headersSent) res.writeHead(400); res.end(); } catch { /* already closed */ } });
        req.on("end", () => {
            const original = Buffer.concat(chunks).toString("utf8");
            const found = findSecrets(original, matchers);
            if (found.length === 0) { forward(req, res, Buffer.from(original, "utf8")); return; }
            if (mode === "reject") {
                recordBlock("reject");
                const payload = JSON.stringify({
                    type: "error",
                    error: {
                        type: "invalid_request_error",
                        message: `enigma prompt secret guard blocked this request: ${found.join(", ")} detected in the message. Remove the credential, or run 'enigma config prompt-secret-mode redact' to strip it automatically instead.`,
                    },
                });
                try { res.writeHead(400, { "content-type": "application/json" }); res.end(payload); } catch { /* already closed */ }
                return;
            }
            const { text } = redactSecrets(original, matchers);
            recordBlock("redact");
            forward(req, res, Buffer.from(text, "utf8"));
        });
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ url: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); } catch { /* */ } } });
        });
    });
}
