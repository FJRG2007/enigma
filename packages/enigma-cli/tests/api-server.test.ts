/**
 * Pure translation + routing layer of the local agent API. Covers OpenAI messages -> an agent
 * prompt, the OpenAI streaming chunk envelope, per-agent stream parsing (Claude Code + Codex),
 * model-id forwarding, and model-based routing to the right adapter. These never spawn a CLI, so
 * the test stays offline and deterministic (the spawn/HTTP path is exercised manually, not in CI).
 */
import { test, expect } from "bun:test";
import { contentToText, messagesToPrompt, streamChunk, extractImages, type ChatMessage } from "../src/api-server";
import {
    resolveClaudeModel,
    stripToolPrefix,
    parseClaudeLine,
    parseCodexLine,
    resolveAdapter,
    adapterFor,
    estimateTokens,
    CLAUDE_MODELS,
    DEFAULT_MODEL,
} from "../src/api-agents";

test("contentToText flattens string and text-part content", () => {
    expect(contentToText("hi")).toBe("hi");
    expect(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(contentToText([{ type: "image", text: "x" } as never])).toBe("");
});

test("messagesToPrompt sends a single user turn verbatim and extracts system", () => {
    const msgs: ChatMessage[] = [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hello" },
    ];
    const { prompt, system } = messagesToPrompt(msgs);
    expect(prompt).toBe("Hello");
    expect(system).toBe("Be terse.");
});

test("messagesToPrompt builds a labelled transcript for multi-turn", () => {
    const msgs: ChatMessage[] = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hey" },
        { role: "user", content: "More" },
    ];
    expect(messagesToPrompt(msgs).prompt).toBe("Human: Hi\n\nAssistant: Hey\n\nHuman: More");
});

test("messagesToPrompt appends a continue prompt when the last turn is not the user", () => {
    const msgs: ChatMessage[] = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hey" },
    ];
    expect(messagesToPrompt(msgs).prompt.endsWith("Human: Please continue.")).toBe(true);
});

test("resolveClaudeModel forwards Claude ids/aliases and drops foreign names", () => {
    expect(resolveClaudeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveClaudeModel("sonnet")).toBe("sonnet");
    expect(resolveClaudeModel("gpt-4o")).toBeNull();
    expect(resolveClaudeModel("")).toBeNull();
    expect(resolveClaudeModel(null)).toBeNull();
    for (const m of CLAUDE_MODELS) expect(resolveClaudeModel(m)).toBe(m);
});

test("stripToolPrefix removes a tool:/tool/ routing prefix", () => {
    expect(stripToolPrefix("codex/gpt-5", "codex")).toBe("gpt-5");
    expect(stripToolPrefix("codex:gpt-5", "codex")).toBe("gpt-5");
    expect(stripToolPrefix("codex", "codex")).toBeNull();
    expect(stripToolPrefix("opencode/anthropic/claude", "opencode")).toBe("anthropic/claude");
    expect(stripToolPrefix("claude-sonnet-5", "codex")).toBe("claude-sonnet-5");
});

test("resolveAdapter routes by model, defaulting to the given tool", () => {
    expect(resolveAdapter("claude-sonnet-5", "claude").tool).toBe("claude");
    expect(resolveAdapter("opus", "codex").tool).toBe("claude");
    expect(resolveAdapter("codex", "claude").tool).toBe("codex");
    expect(resolveAdapter("codex/gpt-5", "claude").tool).toBe("codex");
    expect(resolveAdapter("opencode", "claude").tool).toBe("opencode");
    expect(resolveAdapter("opencode/anthropic/claude", "claude").tool).toBe("opencode");
    // Unknown / empty model falls back to the default tool.
    expect(resolveAdapter("gpt-4o", "opencode").tool).toBe("opencode");
    expect(resolveAdapter("", "codex").tool).toBe("codex");
    expect(resolveAdapter(null, "claude").tool).toBe("claude");
});

test("DEFAULT_MODEL is Opus and the claude adapter falls back to it", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-4-8");
    const claude = adapterFor("claude")!;
    // A bare "claude" or a foreign model routes to Claude but uses the default model.
    const bare = claude.build("hi", { model: "claude" });
    expect(bare.args[bare.args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    const foreign = claude.build("hi", { model: "gpt-4o" });
    expect(foreign.args[foreign.args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
});

test("the claude adapter switches to stream-json input when images are attached", () => {
    const claude = adapterFor("claude")!;
    const img = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AAAA" } };
    const cmd = claude.build("describe", { model: "claude-haiku-4-5", images: [img] });
    expect(cmd.args).toContain("--input-format");
    expect(cmd.args[cmd.args.indexOf("--input-format") + 1]).toBe("stream-json");
    const msg = JSON.parse((cmd.stdin as string).trim());
    expect(msg.type).toBe("user");
    expect(msg.message.content[0]).toEqual({ type: "text", text: "describe" });
    expect(msg.message.content[1]).toEqual(img);
});

test("extractImages reads OpenAI image_url (data + http) and Anthropic image blocks", () => {
    const oai: ChatMessage[] = [{ role: "user", content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "data:image/png;base64,ABC123" } },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
    ] }];
    const a = extractImages(oai);
    expect(a[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "ABC123" } });
    expect(a[1]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } });
    const anth: ChatMessage[] = [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZ" } },
    ] }];
    expect(extractImages(anth)[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZ" } });
    expect(extractImages([{ role: "user", content: "just text" }])).toEqual([]);
});

test("adapters expose the expected read mode and headless args", () => {
    const claude = adapterFor("claude")!;
    expect(claude.mode).toBe("stream-json");
    const cmd = claude.build("hi", { model: "claude-sonnet-5", system: "sys", sessionId: "s1" });
    expect(cmd.args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(cmd.args[cmd.args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(cmd.args).toContain("--append-system-prompt");
    expect(cmd.args[cmd.args.indexOf("--resume") + 1]).toBe("s1");
    expect(cmd.stdin).toBe("hi");

    const codex = adapterFor("codex")!;
    expect(codex.mode).toBe("stream-json");
    const ccmd = codex.build("hi", { model: "codex/gpt-5", system: "sys" });
    expect(ccmd.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(ccmd.args[ccmd.args.indexOf("-m") + 1]).toBe("gpt-5");
    // Codex has no system-prompt flag in exec, so it is folded into the positional prompt.
    expect(ccmd.args[ccmd.args.length - 1]).toBe("sys\n\nhi");
    expect(ccmd.stdin).toBeNull();

    const opencode = adapterFor("opencode")!;
    expect(opencode.mode).toBe("plain");
    expect(opencode.parseLine).toBeUndefined();
    const ocmd = opencode.build("hi", { model: "opencode/anthropic/claude" });
    expect(ocmd.args[0]).toBe("run");
    expect(ocmd.args[ocmd.args.indexOf("-m") + 1]).toBe("anthropic/claude");
});

test("parseClaudeLine maps init, assistant text, result and errors", () => {
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-8"}'))
        .toEqual({ kind: "init", sessionId: "s1", model: "claude-opus-4-8" });
    expect(parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "},{"type":"text","text":"world"}]}}'))
        .toEqual({ kind: "text", text: "Hello world" });
    expect(parseClaudeLine('{"type":"result","subtype":"success","result":"final","session_id":"s1","usage":{"input_tokens":12,"output_tokens":3}}'))
        .toMatchObject({ kind: "result", text: "final", sessionId: "s1", inputTokens: 12, outputTokens: 3, isError: false });
    expect(parseClaudeLine('{"type":"result","subtype":"error_during_execution","is_error":true,"error_message":"boom"}'))
        .toMatchObject({ kind: "result", isError: true, errorMessage: "boom" });
    expect(parseClaudeLine("")).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
    expect(parseClaudeLine('{"type":"assistant","message":{"content":[]}}')).toBeNull();
});

test("parseCodexLine maps thread start, agent_message, turn completed and failure", () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t1"}'))
        .toEqual({ kind: "init", sessionId: "t1", model: null });
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Done."}}'))
        .toEqual({ kind: "text", text: "Done." });
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}'))
        .toMatchObject({ kind: "result", inputTokens: 24763, outputTokens: 122, isError: false });
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"nope"}}'))
        .toMatchObject({ kind: "result", isError: true, errorMessage: "nope" });
    // Non-final items (reasoning, command output) are ignored.
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}')).toBeNull();
    expect(parseCodexLine('{"type":"turn.started"}')).toBeNull();
});

test("estimateTokens approximates ~4 chars/token with a floor of 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
});

test("streamChunk emits a valid OpenAI chunk SSE line", () => {
    const line = streamChunk("chatcmpl-x", "claude-opus-4-8", { content: "hi" });
    expect(line.startsWith("data: ")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(true);
    const obj = JSON.parse(line.slice("data: ".length).trim());
    expect(obj.object).toBe("chat.completion.chunk");
    expect(obj.choices[0].delta.content).toBe("hi");
    expect(obj.choices[0].finish_reason).toBeNull();
});
