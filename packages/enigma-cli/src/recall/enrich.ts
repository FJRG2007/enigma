/**
 * Optional LLM curation of recall observations - the claude-mem behavior: an LLM keeps only
 * the observations worth remembering (rewritten) and discards the rest.
 *
 * Pluggable provider (config `recallProvider`):
 *  - claude-local (default): the local Claude Code OAuth login - no API key, Anthropic API.
 *  - anthropic: an Anthropic API key (x-api-key), api.anthropic.com or a compatible base.
 *  - openai: any OpenAI-compatible /chat/completions endpoint (recallApiBase + recallApiKey) -
 *    covers OpenAI, OpenRouter, Groq, Together, Gemini's OpenAI-compat endpoint, local Ollama/LM Studio.
 * The API key can also come from ENIGMA_RECALL_API_KEY (preferred over storing it in config).
 * Every failure (no creds, network, non-200, bad JSON) returns null and the caller keeps the
 * deterministic observations: this never throws and never blocks a sync.
 */

import { callProvider, resolveProvider } from "../llm";
import { OBSERVATION_TYPES } from "./types";
import type { ObservationHit } from "./types";

const TYPES = OBSERVATION_TYPES as readonly string[];

/** Fields the LLM may overwrite on one observation. */
export interface EnrichFields { type?: string; title?: string; narrative?: string; facts?: string[]; concepts?: string[]; }

/** The enrichment for a whole session: per-observation fields + an improved summary. */
export interface EnrichResult {
    perId: Record<number, EnrichFields>;
    summary?: { request?: string; learned?: string; completed?: string; nextSteps?: string; };
}

const PROMPT_HEAD = `You curate a developer's coding-session memory like a senior engineer noting only what is worth remembering later. You are given mechanical observations from one session. Return ONLY the ones that are durable and useful (a real change, fix, refactor, decision or genuine discovery), rewritten into clear, factual memories. OMIT anything trivial, redundant, or chatter - omitted observations are permanently discarded. Keep the id of each one you keep. Do not invent work that is not implied by the data.
Allowed types: ${TYPES.join(", ")}.
Return STRICT JSON ONLY (no prose, no code fence) of the shape:
{"observations":[{"id":<number>,"type":"<type>","title":"<short>","narrative":"<1-3 sentences>","facts":["..."],"concepts":["..."]}],"summary":{"request":"...","learned":"...","completed":"...","next_steps":"..."}}
If nothing in the session is worth remembering, return an empty observations array (still fill the summary).`;

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
    let json: { observations?: unknown[]; summary?: Record<string, unknown>; };
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

/** Whether enrichment can run here (the configured provider has usable credentials). */
export function enrichAvailable(): boolean {
    return resolveProvider() !== null;
}

/** One synthetic observation generated from a free-text note (the manual "generate" path). */
export interface GeneratedObservation { type: string; title: string; narrative?: string; facts: string[]; concepts: string[]; }

const GENERATE_PROMPT_HEAD = `You turn a developer's short note into ONE durable coding-memory observation, like a senior engineer recording what is worth remembering later. Be faithful to the note; do not invent specifics it does not state.
Allowed types: ${TYPES.join(", ")}.
Return STRICT JSON ONLY (no prose, no code fence) of the shape:
{"type":"<type>","title":"<short>","narrative":"<1-3 sentences>","facts":["..."],"concepts":["..."]}`;

/**
 * Generate a single structured observation from a free-text note via the configured provider.
 * Returns null when no provider/credentials are available or the model returns nothing usable;
 * never throws.
 */
export async function generateObservationFields(note: string): Promise<GeneratedObservation | null> {
    const provider = resolveProvider();
    if (!provider || !note.trim()) return null;
    const text = await callProvider(provider, `${GENERATE_PROMPT_HEAD}\n\nNote: ${note.trim()}`);
    if (!text) return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let r: Record<string, unknown>;
    try { r = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 120) : "";
    if (!title) return null;
    return {
        type: typeof r.type === "string" && TYPES.includes(r.type) ? r.type : "discovery",
        title,
        narrative: typeof r.narrative === "string" && r.narrative.trim() ? r.narrative.trim().slice(0, 800) : undefined,
        facts: strArray(r.facts),
        concepts: strArray(r.concepts),
    };
}

/**
 * Curate one session's observations via a single LLM call to the configured provider. Returns
 * null on any failure so the caller keeps the deterministic data.
 */
export async function enrichSession(project: string, observations: ObservationHit[]): Promise<EnrichResult | null> {
    const provider = resolveProvider();
    if (!provider || !observations.length) return null;
    const compact = observations.map((o) => ({
        id: o.id,
        request: o.subtitle || o.title,
        type: o.type,
        filesModified: o.filesModified.slice(0, 12),
        filesRead: o.filesRead.slice(0, 12),
        did: o.narrative?.slice(0, 400),
    }));
    const text = await callProvider(provider, `${PROMPT_HEAD}\n\nProject: ${project}\nObservations:\n${JSON.stringify(compact)}`);
    return text ? parseEnrich(text) : null;
}
