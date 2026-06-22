/**
 * Measuring-proxy usage parser: it must read token usage out of both a streaming SSE
 * /v1/messages response (input/cache from message_start, final cumulative output from
 * message_delta) and a non-streaming JSON body, and ignore non-messages paths / bodies
 * without usage. The parser is what feeds the dashboard's real proxy measurements.
 */
import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsage, startMeasuringProxy, readProxyStats } from "../src/proxy";

const SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":100,"cache_read_input_tokens":2000,"cache_creation_input_tokens":50,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":250}}',
    '',
].join("\n");

test("parses usage from a streaming SSE messages response", () => {
    const u = parseUsage("/v1/messages?beta=true", SSE);
    expect(u).not.toBeNull();
    expect(u!.model).toBe("claude-opus-4-8");
    expect(u!.input).toBe(100);
    expect(u!.cacheRead).toBe(2000);
    expect(u!.cacheCreation).toBe(50);
    expect(u!.output).toBe(250); // the cumulative final output from message_delta, not the 1 in message_start
});

test("parses usage from a non-streaming JSON messages response", () => {
    const body = '{"id":"msg_2","model":"claude-haiku-4-5","type":"message","usage":{"input_tokens":42,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}';
    const u = parseUsage("/v1/messages", body);
    expect(u).not.toBeNull();
    expect(u!.input).toBe(42);
    expect(u!.output).toBe(7);
    expect(u!.model).toBe("claude-haiku-4-5");
});

test("ignores non-messages paths and bodies without usage", () => {
    expect(parseUsage("/v1/models", SSE)).toBeNull();
    expect(parseUsage("/v1/messages", '{"id":"x","model":"y"}')).toBeNull();
});

test("forwards to the upstream verbatim and records the measured usage", async () => {
    const HOME = mkdtempSync(join(tmpdir(), "enigma-proxy-"));
    const prev = { home: process.env.HOME, profile: process.env.USERPROFILE, up: process.env.ENIGMA_PROXY_UPSTREAM };
    process.env.HOME = HOME; process.env.USERPROFILE = HOME;

    // A fake "Anthropic": echoes the request path back in an SSE messages body with usage.
    const upstream = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "x-seen-path": req.url || "" });
        res.end(SSE);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    process.env.ENIGMA_PROXY_UPSTREAM = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const proxy = await startMeasuringProxy();
    try {
        const r = await fetch(proxy.url + "/v1/messages?beta=1", { method: "POST", body: "{}" });
        const body = await r.text();
        expect(r.status).toBe(200);
        expect(r.headers.get("x-seen-path")).toBe("/v1/messages?beta=1"); // forwarded path verbatim
        expect(body).toContain("message_start");                          // response streamed back verbatim
        await new Promise((res) => setTimeout(res, 50));                  // let the end handler record
        const stats = readProxyStats();
        expect(stats.calls).toBe(1);
        expect(stats.input).toBe(100);
        expect(stats.output).toBe(250);
        expect(stats.byModel["claude-opus-4-8"].calls).toBe(1);
    } finally {
        proxy.close(); upstream.close();
        process.env.HOME = prev.home; process.env.USERPROFILE = prev.profile;
        if (prev.up === undefined) delete process.env.ENIGMA_PROXY_UPSTREAM; else process.env.ENIGMA_PROXY_UPSTREAM = prev.up;
        rmSync(HOME, { recursive: true, force: true });
    }
});
