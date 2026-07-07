/**
 * Pure helpers of the dashboard API playground bridge: format->path mapping, request-body
 * shaping per API format, in-process result shaping into OpenAI/Anthropic envelopes, the curl
 * builder, and the loopback-target guard. None spawn an agent or open a socket, so the test
 * stays offline (the inproc/http run path is verified manually via the dashboard).
 */
import { test, expect } from "bun:test";
import type { CompleteResult } from "../src/api-server";
import {
    formatPath,
    buildRequestBody,
    shapeResult,
    buildCurl,
    isLoopbackTarget,
    type PlaygroundRequest,
} from "../src/dashboard-playground";

test("formatPath maps the format to the right endpoint", () => {
    expect(formatPath("openai")).toBe("/v1/chat/completions");
    expect(formatPath("anthropic")).toBe("/v1/messages");
    expect(formatPath("whatever")).toBe("/v1/chat/completions");
});

test("buildRequestBody shapes an OpenAI chat body with system + user", () => {
    const req: PlaygroundRequest = { format: "openai", model: "claude-sonnet-5", system: "Be terse.", message: "Hi", enableTools: true };
    const body = buildRequestBody(req) as { model: string; messages: Array<{ role: string; content: string }>; enable_tools?: boolean };
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.messages[0]).toEqual({ role: "system", content: "Be terse." });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
    expect(body.enable_tools).toBe(true);
});

test("buildRequestBody shapes an Anthropic messages body with system split out", () => {
    const req: PlaygroundRequest = { format: "anthropic", model: "claude", system: "Be terse.", message: "Hi" };
    const body = buildRequestBody(req) as { system?: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
    expect(body.system).toBe("Be terse.");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
});

test("buildRequestBody folds account/profile/pack context into both formats", () => {
    const oai = buildRequestBody({ format: "openai", model: "claude", message: "Hi", account: "work", pack: "helio" }) as { account?: string; pack?: string; profile?: string };
    expect(oai.account).toBe("work");
    expect(oai.pack).toBe("helio");
    expect(oai.profile).toBeUndefined();
    const anth = buildRequestBody({ format: "anthropic", model: "claude", message: "Hi", profile: "team" }) as { profile?: string };
    expect(anth.profile).toBe("team");
});

test("buildRequestBody attaches an image as parts (image_url for OpenAI, image block for Anthropic)", () => {
    const url = "data:image/png;base64,ABCD";
    const oai = buildRequestBody({ format: "openai", model: "claude", message: "what is this", imageDataUrl: url }) as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> };
    const parts = oai.messages[0].content;
    expect(parts[0]).toEqual({ type: "text", text: "what is this" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url } });

    const anth = buildRequestBody({ format: "anthropic", model: "claude", message: "what is this", imageDataUrl: url }) as { messages: Array<{ content: Array<{ type: string; source?: { data: string } }> }> };
    const ap = anth.messages[0].content;
    expect(ap[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "ABCD" } });
});

test("buildCurl truncates long base64 image data for readability", () => {
    const body = { messages: [{ content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(200)}` } }] }] };
    const curl = buildCurl("http://127.0.0.1:8000", "openai", body);
    expect(curl).toContain("base64,<base64 image data omitted>");
    expect(curl).not.toContain("A".repeat(200));
});

test("shapeResult wraps a result in the OpenAI or Anthropic envelope", () => {
    const result: CompleteResult = { tool: "claude", model: "claude-sonnet-5", text: "hello", inputTokens: 5, outputTokens: 2, sessionId: "s1", isError: false };
    const oai = shapeResult(result, "openai") as { object: string; choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
    expect(oai.object).toBe("chat.completion");
    expect(oai.choices[0].message.content).toBe("hello");
    expect(oai.usage.total_tokens).toBe(7);

    const anth = shapeResult(result, "anthropic") as { type: string; content: Array<{ text: string }>; usage: { input_tokens: number; output_tokens: number } };
    expect(anth.type).toBe("message");
    expect(anth.content[0].text).toBe("hello");
    expect(anth.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
});

test("buildCurl targets the format path and only adds auth when a key is given", () => {
    const body = { model: "claude", messages: [{ role: "user", content: "Hi" }] };
    const withKey = buildCurl("http://127.0.0.1:8000", "openai", body, "sk-test");
    expect(withKey).toContain("http://127.0.0.1:8000/v1/chat/completions");
    expect(withKey).toContain("Authorization: Bearer sk-test");
    const noKey = buildCurl("http://127.0.0.1:8000/", "anthropic", body);
    expect(noKey).toContain("http://127.0.0.1:8000/v1/messages");
    expect(noKey).not.toContain("Authorization");
});

test("isLoopbackTarget accepts loopback hosts and rejects the rest (SSRF guard)", () => {
    expect(isLoopbackTarget("http://127.0.0.1:8000")).toBe(true);
    expect(isLoopbackTarget("http://localhost:8000")).toBe(true);
    expect(isLoopbackTarget("http://enigma")).toBe(true);
    expect(isLoopbackTarget("http://example.com")).toBe(false);
    expect(isLoopbackTarget("http://169.254.169.254")).toBe(false);
    expect(isLoopbackTarget("not a url")).toBe(false);
});
