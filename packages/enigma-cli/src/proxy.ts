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
 * Node builtins only. This is deliberately a faithful relay, NOT headroom's transforming
 * proxy (no compression/cache rewriting) - measurement must not change what Claude receives.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
    byModel: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheCreation: number }>;
}

const EMPTY: ProxyUsage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, byModel: {} };

function statsPath(): string {
    return join(homedir(), ".enigma", "proxy", "stats.json");
}

/** Cumulative token usage measured by the proxy so far. */
export function readProxyStats(): ProxyUsage {
    try { return { ...EMPTY, ...JSON.parse(readFileSync(statsPath(), "utf8")) }; } catch { return { ...EMPTY }; }
}

interface OneCall { model: string; input: number; output: number; cacheRead: number; cacheCreation: number; }

/** Fold one measured call into the cumulative store. Best-effort; never throws. */
function recordCall(c: OneCall): void {
    try {
        const cur = readProxyStats();
        const m = (cur.byModel[c.model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
        cur.calls++; cur.input += c.input; cur.output += c.output; cur.cacheRead += c.cacheRead; cur.cacheCreation += c.cacheCreation;
        m.calls++; m.input += c.input; m.output += c.output; m.cacheRead += c.cacheRead; m.cacheCreation += c.cacheCreation;
        const dir = join(homedir(), ".enigma", "proxy");
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

/**
 * Start the loopback measuring proxy and resolve once it is listening. The caller injects
 * its url as ANTHROPIC_BASE_URL for the Claude Code launch and closes it when Claude exits.
 */
export function startMeasuringProxy(): Promise<RunningProxy> {
    const server: Server = createServer((req, res) => {
        const up = upstream();
        const headers = { ...req.headers };
        headers.host = up.host;
        // Ask upstream for an un-encoded body so usage is readable; the client still gets a
        // complete, correct response (just not gzip-compressed).
        delete headers["accept-encoding"];

        const upReq = up.request(
            { host: up.host, port: up.port, method: req.method, path: req.url, headers },
            (upRes) => {
                res.writeHead(upRes.statusCode || 502, upRes.headers);
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
        req.pipe(upReq);
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ url: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); } catch { /* */ } } });
        });
    });
}
