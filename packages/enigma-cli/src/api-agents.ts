/**
 * Per-agent adapters for the local API server. Each coding agent (Claude Code, Codex,
 * OpenCode) has a different headless invocation and output format, so an adapter isolates
 * "how to run it" and "how to read its output" behind one interface. The API server routes
 * every request to an adapter by the request's `model` field, so a single server can back
 * several agents at once (e.g. `model: "claude-sonnet-5"` -> Claude Code, `model: "codex"`
 * -> Codex, `model: "opencode"` -> OpenCode).
 *
 * VERIFICATION STATUS: the Claude Code adapter is verified end-to-end against the real CLI.
 * The Codex adapter follows the documented `codex exec --json` ThreadEvent schema; the
 * OpenCode adapter uses `opencode run` plain-text output (its JSON event schema is not
 * publicly documented, and plain stdout is the reliable, honest surface). Both non-Claude
 * adapters are wired from documentation and may need a flag tweak once verified on a machine
 * that has them installed - keep that caveat until confirmed live.
 */
import { resolveBin } from "./util";
import { readConfig } from "./config";
import { getTool, isToolName } from "./accounts";

/** One normalized event, agent-agnostic, parsed from a stream-json adapter. */
export type AgentEvent =
    | { kind: "init"; sessionId: string | null; model: string | null }
    | { kind: "text"; text: string }
    | { kind: "result"; text: string | null; sessionId: string | null; inputTokens: number; outputTokens: number; isError: boolean; errorMessage?: string };

/** An image attached to a request, in Anthropic content-block shape (base64 or url source). */
export interface ImageBlock {
    type: "image";
    source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}

/** Options that shape a single headless run, independent of the backing agent. */
export interface CompletionOptions {
    model?: string | null;
    system?: string | null;
    sessionId?: string | null;
    enableTools?: boolean;
    /** Images for the current user turn (Claude Code only; other agents get text-only). */
    images?: ImageBlock[];
    /** Run under a specific enigma account (its config dir). Overrides the active account. */
    account?: string | null;
    /** Run under a specific profile's account mapping for this tool. Ignored if `account` is set. */
    profile?: string | null;
    /** Run inside a pack's isolated context (e.g. "helio"). Wins over account/profile. */
    pack?: string | null;
}

/** What an adapter produces to launch its agent: CLI args plus optional stdin content. */
export interface AgentCommand { args: string[]; stdin: string | null }

/**
 * Adapter contract. `mode` decides how the server reads stdout: "stream-json" parses each
 * newline-delimited event via `parseLine`; "plain" treats the whole stdout as the answer text.
 */
export interface AgentAdapter {
    tool: string;
    /** Model ids advertised in /v1/models and used to route a request here. */
    models: string[];
    mode: "stream-json" | "plain";
    build(prompt: string, opts: CompletionOptions): AgentCommand;
    parseLine?(line: string): AgentEvent | null;
}

/** Claude ids/aliases forwarded to `--model`; foreign ids (gpt-*) fall back to the default. */
export const CLAUDE_MODELS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5", "opus", "sonnet", "haiku"];

/** Default model when a request names none (or a foreign one) and routes to Claude Code. */
export const DEFAULT_MODEL = "claude-opus-4-8";

/** Strip a `tool` / `tool:` / `tool/` routing prefix from a model id, returning the remainder (or null). */
export function stripToolPrefix(model: string | null | undefined, tool: string): string | null {
    if (!model) return null;
    const m = model.trim();
    const lower = m.toLowerCase();
    if (lower === tool) return null;
    if (lower.startsWith(`${tool}:`) || lower.startsWith(`${tool}/`)) {
        const rest = m.slice(tool.length + 1).trim();
        return rest || null;
    }
    return m;
}

/** Decide whether a Claude model id should reach `--model` (drop foreign OpenAI-style names). */
export function resolveClaudeModel(model: string | null | undefined): string | null {
    const m = stripToolPrefix(model, "claude");
    if (!m) return null;
    if (m.startsWith("claude") || CLAUDE_MODELS.includes(m)) return m;
    return null;
}

/** Rough token estimate (~4 chars/token) used when an adapter reports no usage. */
export function estimateTokens(text: string): number {
    return Math.max(1, Math.floor(text.length / 4));
}

// --- Claude Code (verified) -------------------------------------------------

/** Parse one Claude Code stream-json line into a normalized event. */
export function parseClaudeLine(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(trimmed); } catch { return null; }
    const type = msg.type as string | undefined;
    if (type === "system" && msg.subtype === "init") {
        return { kind: "init", sessionId: (msg.session_id as string) ?? null, model: (msg.model as string) ?? null };
    }
    if (type === "assistant") {
        const message = msg.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const blocks = message?.content;
        if (Array.isArray(blocks)) {
            const text = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
            if (text) return { kind: "text", text };
        }
        return null;
    }
    if (type === "result") {
        const usage = (msg.usage as { input_tokens?: number; output_tokens?: number }) || {};
        const isError = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype !== "success");
        return {
            kind: "result",
            text: typeof msg.result === "string" ? msg.result : null,
            sessionId: (msg.session_id as string) ?? null,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            isError,
            errorMessage: typeof msg.error_message === "string" ? msg.error_message : (typeof msg.result === "string" ? msg.result : undefined),
        };
    }
    return null;
}

const claudeAdapter: AgentAdapter = {
    tool: "claude",
    models: CLAUDE_MODELS,
    mode: "stream-json",
    build(prompt, opts) {
        const args = ["-p", "--output-format", "stream-json", "--verbose"];
        // A named Claude model wins; otherwise (bare "claude" / a foreign id) use the default.
        const model = resolveClaudeModel(opts.model);
        args.push("--model", model && model !== "claude" ? model : DEFAULT_MODEL);
        if (opts.system) args.push("--append-system-prompt", opts.system);
        if (opts.sessionId) args.push("--resume", opts.sessionId);
        // Tools off by default for OpenAI compatibility + speed; when enabled, honor the global
        // permission-bypass posture so a headless run never stalls on a permission prompt.
        const bypass = readConfig().config.permissionBypass;
        args.push("--permission-mode", opts.enableTools && bypass ? "bypassPermissions" : "default");
        // With images, drive Claude Code through its realtime streaming input: one user message
        // carrying the text plus image content blocks (the reliable way to send vision content).
        if (opts.images && opts.images.length) {
            args.push("--input-format", "stream-json");
            const content = [{ type: "text", text: prompt }, ...opts.images];
            return { args, stdin: `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n` };
        }
        return { args, stdin: prompt };
    },
    parseLine: parseClaudeLine,
};

// --- Codex (documented `codex exec --json`) ---------------------------------

/** Parse one Codex `exec --json` ThreadEvent line into a normalized event. */
export function parseCodexLine(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(trimmed); } catch { return null; }
    const type = msg.type as string | undefined;
    if (type === "thread.started") {
        const id = (msg.thread_id as string) || (msg.session_id as string) || (msg.id as string) || null;
        return { kind: "init", sessionId: id, model: null };
    }
    if (type === "item.completed") {
        const item = msg.item as { type?: string; text?: string } | undefined;
        if (item && item.type === "agent_message" && typeof item.text === "string" && item.text) {
            return { kind: "text", text: item.text };
        }
        return null;
    }
    if (type === "turn.completed") {
        const usage = (msg.usage as { input_tokens?: number; output_tokens?: number }) || {};
        return { kind: "result", text: null, sessionId: null, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, isError: false };
    }
    if (type === "turn.failed" || type === "error") {
        const error = msg.error as { message?: string } | undefined;
        return { kind: "result", text: null, sessionId: null, inputTokens: 0, outputTokens: 0, isError: true, errorMessage: error?.message || "Codex reported an error." };
    }
    return null;
}

const codexAdapter: AgentAdapter = {
    tool: "codex",
    models: ["codex"],
    mode: "stream-json",
    build(prompt, opts) {
        const args = ["exec", "--json"];
        const model = stripToolPrefix(opts.model, "codex");
        if (model && model !== "codex") args.push("-m", model);
        // Codex has no verified --append-system-prompt for exec, so fold the system prompt into
        // the message (best-effort). The prompt is passed as a positional argument.
        const full = opts.system ? `${opts.system}\n\n${prompt}` : prompt;
        args.push(full);
        return { args, stdin: null };
    },
    parseLine: parseCodexLine,
};

// --- OpenCode (plain-text `opencode run`) -----------------------------------

const opencodeAdapter: AgentAdapter = {
    tool: "opencode",
    models: ["opencode"],
    // OpenCode's --format json event schema is not publicly documented; plain stdout is the
    // reliable surface, so the whole response is read as text (no per-line parsing, usage estimated).
    mode: "plain",
    build(prompt, opts) {
        const args = ["run"];
        const model = stripToolPrefix(opts.model, "opencode");
        if (model && model !== "opencode") args.push("-m", model);
        const full = opts.system ? `${opts.system}\n\n${prompt}` : prompt;
        args.push(full);
        return { args, stdin: null };
    },
};

const ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter];

/** All adapters, keyed by tool name. */
export function allAdapters(): AgentAdapter[] {
    return ADAPTERS;
}

/** The adapter for a specific tool name, or null if unknown. */
export function adapterFor(tool: string): AgentAdapter | null {
    return ADAPTERS.find((a) => a.tool === tool) || null;
}

/**
 * Route a request to an adapter by its `model` field, falling back to `defaultTool`.
 * A model may name a tool directly (`codex`, `opencode`), carry a `tool:` / `tool/` prefix
 * (`codex/gpt-5`, `opencode/anthropic/claude`), or be a Claude id/alias (-> Claude Code).
 */
export function resolveAdapter(model: string | null | undefined, defaultTool: string): AgentAdapter {
    const fallback = adapterFor(defaultTool) || claudeAdapter;
    const m = model?.trim();
    if (!m) return fallback;
    const lower = m.toLowerCase();
    for (const a of ADAPTERS) {
        if (lower === a.tool || lower.startsWith(`${a.tool}:`) || lower.startsWith(`${a.tool}/`)) return a;
    }
    if (lower.startsWith("claude") || CLAUDE_MODELS.includes(m)) return claudeAdapter;
    return fallback;
}

/** True when the tool's binary is resolvable (installed / on PATH / configured), so it can back the API. */
export function agentAvailable(tool: string): boolean {
    if (!isToolName(tool)) return false;
    const spec = getTool(tool);
    const cfg = readConfig().config;
    return Boolean(process.env[spec.binEnv] || cfg.toolPaths?.[tool] || resolveBin(spec.bin));
}

/** Adapters whose agent is actually installed, for /v1/models. */
export function availableAdapters(): AgentAdapter[] {
    return ADAPTERS.filter((a) => agentAvailable(a.tool));
}
