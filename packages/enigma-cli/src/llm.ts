/**
 * One-shot model calls for enigma's background work (recall curation, convention checks).
 *
 * A direct HTTPS request, never a spawned agent CLI: on a machine where starting a process costs
 * seconds (Defender scans every image), `claude -p` spends more on its own launch than the model
 * spends answering, and it would fire this machine's own hooks recursively. Provider from config
 * (`recallProvider`, shared by every background caller so the user configures one credential):
 *  - claude-local (default): the local Claude Code OAuth login - no API key.
 *  - anthropic: an Anthropic API key, api.anthropic.com or a compatible base.
 *  - openai: any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, Groq, Ollama...).
 * The key can also come from ENIGMA_RECALL_API_KEY. Every failure returns null; this never throws.
 */

import { readOAuthToken } from "./claude-usage-api";
import { readConfig, getRecallApiKey } from "./config";

const UA = "claude-code/2.1.5";
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export interface Provider { kind: "anthropic-oauth" | "anthropic-key" | "openai"; base: string; key: string; model: string; }

/** The configured provider, or null when it has no usable credentials. */
export function resolveProvider(): Provider | null {
    const c = readConfig().config;
    const envKey = process.env.ENIGMA_RECALL_API_KEY || "";
    const provider = c.recallProvider || "claude-local";
    if (provider === "claude-local") {
        const tok = readOAuthToken();
        return tok ? { kind: "anthropic-oauth", base: "https://api.anthropic.com", key: tok.token, model: c.recallModel || DEFAULT_CLAUDE_MODEL } : null;
    }
    const key = envKey || getRecallApiKey(c);
    if (!key) return null;
    if (provider === "anthropic") return { kind: "anthropic-key", base: c.recallApiBase || "https://api.anthropic.com", key, model: c.recallModel || DEFAULT_CLAUDE_MODEL };
    return { kind: "openai", base: c.recallApiBase || "https://api.openai.com/v1", key, model: c.recallModel || DEFAULT_OPENAI_MODEL };
}

export interface CallOptions { timeoutMs?: number; maxTokens?: number; }

/** One user prompt to `p`; the assistant text, or null on any failure. */
export async function callProvider(p: Provider, prompt: string, opts: CallOptions = {}): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
    const maxTokens = opts.maxTokens ?? 2000;
    const base = p.base.replace(/\/+$/, "");
    try {
        if (p.kind === "openai") {
            const res = await fetch(`${base}/chat/completions`, {
                method: "POST", signal: ctrl.signal,
                headers: { "authorization": `Bearer ${p.key}`, "content-type": "application/json" },
                body: JSON.stringify({ model: p.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
            });
            if (!res.ok) return null;
            const j = (await res.json()) as { choices?: { message?: { content?: string; }; }[]; };
            return j.choices?.[0]?.message?.content || null;
        }
        const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
        const body: Record<string, unknown> = { model: p.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
        if (p.kind === "anthropic-oauth") {
            headers.authorization = `Bearer ${p.key}`;
            headers["anthropic-beta"] = "oauth-2025-04-20";
            headers["user-agent"] = UA;
            // A Claude Code OAuth token is only authorized for requests that identify as Claude
            // Code: the FIRST system block must be exactly this string, or Anthropic rejects the
            // call with 401 ("only authorized for use with Claude Code"). The caller's own
            // instructions stay in the user turn.
            body.system = "You are Claude Code, Anthropic's official CLI for Claude.";
        } else headers["x-api-key"] = p.key;
        const res = await fetch(`${base}/v1/messages`, { method: "POST", signal: ctrl.signal, headers, body: JSON.stringify(body) });
        if (!res.ok) return null;
        const j = (await res.json()) as { content?: { type?: string; text?: string; }[]; };
        return (j.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("") || null;
    } catch { return null; } finally { clearTimeout(timer); }
}

/** The first `{...}` (or `[...]` when `array`) in a model reply, parsed; null when there is none. */
export function parseJsonReply(text: string, array = false): unknown {
    const [open, close] = array ? ["[", "]"] : ["{", "}"];
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
