/**
 * Optional LLM enrichment of recall observations. The deterministic extractor records the
 * mechanical facts of a session; this asks an LLM to rewrite them into richer, human-readable
 * observations + a session summary (the quality the upstream design got from the Agent SDK).
 *
 * It reuses the LOCAL Claude Code OAuth token (read-only, via claude-usage-api) and sends one
 * batched request per session to api.anthropic.com - so it is Claude-only, opt-in (config
 * `recallLlm`, default off), and consumes a little quota. Every failure (no token, network,
 * non-200, bad JSON) returns null and the caller keeps the deterministic observations: this
 * never throws and never blocks a sync.
 */

import { OBSERVATION_TYPES } from "./types";
import type { ObservationHit } from "./types";
import { request as httpsRequest } from "node:https";
import { readOAuthToken } from "../claude-usage-api";

const UA = "claude-code/2.1.5";
const MODEL = "claude-haiku-4-5-20251001";
const TYPES = OBSERVATION_TYPES as readonly string[];

/** Fields the LLM may overwrite on one observation. */
export interface EnrichFields { type?: string; title?: string; narrative?: string; facts?: string[]; concepts?: string[]; }

/** The enrichment for a whole session: per-observation fields + an improved summary. */
export interface EnrichResult {
    perId: Record<number, EnrichFields>;
    summary?: { request?: string; learned?: string; completed?: string; nextSteps?: string };
}

/** POST a messages request with the local OAuth token; resolves the assistant text or null. */
function callAnthropic(token: string, body: string): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v: string | null): void => { if (!settled) { settled = true; resolve(v); } };
        const req = httpsRequest(
            {
                host: "api.anthropic.com", port: 443, method: "POST", path: "/v1/messages",
                headers: {
                    "authorization": `Bearer ${token}`,
                    "anthropic-beta": "oauth-2025-04-20",
                    "anthropic-version": "2023-06-01",
                    "user-agent": UA,
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (c) => { data += c; });
                res.on("end", () => {
                    if ((res.statusCode ?? 0) >= 300) return done(null);
                    try {
                        const json = JSON.parse(data) as { content?: { type?: string; text?: string }[] };
                        const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
                        done(text || null);
                    } catch { done(null); }
                });
                res.on("error", () => done(null));
            },
        );
        req.on("error", () => done(null));
        req.setTimeout(30000, () => { try { req.destroy(); } catch { /* */ } done(null); });
        req.end(body);
    });
}

const PROMPT_HEAD = `You improve a developer's coding-session memory. Given mechanical observations from one session, rewrite each into a clear, durable memory and write a short session summary. Keep ids. Be concise and factual; do not invent work that is not implied by the data.
Allowed types: ${TYPES.join(", ")}.
Return STRICT JSON ONLY (no prose, no code fence) of the shape:
{"observations":[{"id":<number>,"type":"<type>","title":"<short>","narrative":"<1-3 sentences>","facts":["..."],"concepts":["..."]}],"summary":{"request":"...","learned":"...","completed":"...","next_steps":"..."}}`;

/** Coerce an unknown value to a string array (the LLM may return strings or arrays). */
function strArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean).slice(0, 12);
    return [];
}

/** Parse the model's JSON response into a validated EnrichResult, or null. */
function parseEnrich(text: string): EnrichResult | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let json: { observations?: unknown[]; summary?: Record<string, unknown> };
    try { json = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    const perId: Record<number, EnrichFields> = {};
    for (const o of json.observations || []) {
        const r = o as Record<string, unknown>;
        const id = Number(r.id);
        if (!Number.isInteger(id)) continue;
        const type = typeof r.type === "string" && TYPES.includes(r.type) ? r.type : undefined;
        perId[id] = {
            type,
            title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 120) : undefined,
            narrative: typeof r.narrative === "string" && r.narrative.trim() ? r.narrative.trim().slice(0, 800) : undefined,
            facts: strArray(r.facts),
            concepts: strArray(r.concepts),
        };
    }
    const s = json.summary || {};
    const summary = {
        request: typeof s.request === "string" ? s.request.slice(0, 300) : undefined,
        learned: typeof s.learned === "string" ? s.learned.slice(0, 600) : undefined,
        completed: typeof s.completed === "string" ? s.completed.slice(0, 600) : undefined,
        nextSteps: typeof s.next_steps === "string" ? s.next_steps.slice(0, 600) : undefined,
    };
    return { perId, summary };
}

/** Whether enrichment can run here (a local Claude login exists). */
export function enrichAvailable(): boolean {
    return readOAuthToken() !== null;
}

/**
 * Enrich one session's observations via a single LLM call. Returns null on any failure so the
 * caller keeps the deterministic data.
 */
export async function enrichSession(project: string, observations: ObservationHit[]): Promise<EnrichResult | null> {
    const tok = readOAuthToken();
    if (!tok || !observations.length) return null;
    const compact = observations.map((o) => ({
        id: o.id,
        request: o.subtitle || o.title,
        type: o.type,
        filesModified: o.filesModified.slice(0, 12),
        filesRead: o.filesRead.slice(0, 12),
        did: o.narrative?.slice(0, 400),
    }));
    const body = JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: `${PROMPT_HEAD}\n\nProject: ${project}\nObservations:\n${JSON.stringify(compact)}` }],
    });
    const text = await callAnthropic(tok.token, body);
    return text ? parseEnrich(text) : null;
}
