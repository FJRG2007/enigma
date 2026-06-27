/**
 * Bridge exposing the recall session-memory store (recall/) to the dashboard's HTTP API:
 * a serializable view (status + recent/searched observations) and two actions (sync, clear).
 * Imported dynamically by dashboard.ts only when the Recall panel is used.
 *
 * When the panel is open and recall is enabled, a throttled background sync keeps the store
 * fresh from new transcripts without blocking the request (the same stale-while-revalidate
 * shape usage.ts uses), so the user rarely needs the manual "Sync now" button.
 */

import { readConfig, setEnigmaValue, setRecallApiKey, RECALL_PROVIDERS, type RecallProvider } from "./config";
import type { ObservationHit, RecallStats } from "./recall";
import { recallAvailable, recallStatus, searchRecall, recentObservations, resetRecall, syncRecall, recallTimeline, deleteRecallObservation, createObservation, generateObservation } from "./recall";

/** One observation row as the dashboard renders it (full fields, so the detail view needs no refetch). */
export interface RecallItem {
    id?: number;
    type: string;
    title: string;
    subtitle?: string;
    project: string;
    source: string;
    files: string[];
    filesRead: string[];
    facts: string[];
    concepts: string[];
    narrative?: string;
    createdAt: number;
}

function toItem(o: ObservationHit): RecallItem {
    return {
        id: o.id, type: o.type, title: o.title, subtitle: o.subtitle, project: o.project, source: o.source,
        files: o.filesModified, filesRead: o.filesRead, facts: o.facts, concepts: o.concepts,
        narrative: o.narrative, createdAt: o.createdAt,
    };
}

/** The recall LLM-provider config, surfaced to the dashboard (the key value is never sent). */
export interface RecallProviderView {
    provider: RecallProvider;
    model: string;
    base: string;
    /** Whether a key is set in config or via ENIGMA_RECALL_API_KEY (the value is never exposed). */
    hasKey: boolean;
    /** True when the key comes from the env var (config field is then ignored/locked). */
    keyFromEnv: boolean;
    /** LLM curation on (recallLlm). */
    llm: boolean;
    providers: readonly RecallProvider[];
}

/** Everything the Recall tab needs in one payload. */
export interface RecallView {
    /** bun:sqlite present (false under a Node-only run). */
    available: boolean;
    /** config.recall is on. */
    enabled: boolean;
    stats: RecallStats | null;
    lastSync: number;
    projects: string[];
    query: string;
    items: RecallItem[];
    provider: RecallProviderView;
}

function providerView(): RecallProviderView {
    const c = readConfig().config;
    const envKey = !!process.env.ENIGMA_RECALL_API_KEY;
    return {
        provider: c.recallProvider, model: c.recallModel, base: c.recallApiBase,
        hasKey: envKey || !!c.recallApiKey, keyFromEnv: envKey, llm: c.recallLlm,
        providers: RECALL_PROVIDERS,
    };
}

let lastSyncAttempt = 0;
const SYNC_THROTTLE_MS = 5 * 60 * 1000;

/** Kick a background sync at most every few minutes; never blocks the response. */
function maybeBackgroundSync(): void {
    const now = Date.now();
    if (now - lastSyncAttempt < SYNC_THROTTLE_MS) return;
    lastSyncAttempt = now;
    setTimeout(() => { try { syncRecall(); } catch { /* best-effort */ } }, 0);
}

/** Build the Recall view: search results when a query is given, else recent observations. */
export function recallDashboard(opts: { q?: string; project?: string; type?: string } = {}): RecallView {
    const enabled = readConfig().config.recall;
    const available = recallAvailable();
    if (!available || !enabled) return { available, enabled, stats: null, lastSync: 0, projects: [], query: opts.q || "", items: [], provider: providerView() };
    maybeBackgroundSync();
    const st = recallStatus();
    const q = (opts.q || "").trim();
    const hits = q
        ? searchRecall(q, { project: opts.project, type: opts.type, limit: 50 })
        : recentObservations({ project: opts.project, type: opts.type, limit: 50 });
    return {
        available: true,
        enabled: true,
        stats: st.stats,
        lastSync: st.lastSync,
        projects: st.projects,
        query: q,
        items: hits.map(toItem),
        provider: providerView(),
    };
}

/** Chronological context around an observation, for the dashboard timeline view. */
export function recallTimelineView(id: number): RecallItem[] {
    if (!recallAvailable() || !readConfig().config.recall) return [];
    return recallTimeline({ id }).map(toItem);
}

/**
 * Payload for Recall actions: set-provider fields (key omitted leaves the stored key unchanged),
 * an observation id (delete), manual-memory fields (create), and a free-text note (generate).
 */
export interface RecallActionPayload {
    provider?: string; model?: string; base?: string; key?: string; llm?: boolean;
    id?: number;
    type?: string; title?: string; project?: string; narrative?: string; facts?: string[]; concepts?: string[];
    prompt?: string;
}

/** Apply a Recall action and return the refreshed view. */
export async function applyRecallAction(op: string, payload: RecallActionPayload = {}): Promise<{ ok: boolean; error?: string; view?: RecallView }> {
    if (!recallAvailable()) return { ok: false, error: "recall needs the enigma binary" };
    if (op === "sync") { syncRecall(); return { ok: true, view: recallDashboard() }; }
    if (op === "clear") { resetRecall(); return { ok: true, view: recallDashboard() }; }
    if (op === "delete") {
        if (typeof payload.id !== "number") return { ok: false, error: "missing memory id" };
        deleteRecallObservation(payload.id);
        return { ok: true, view: recallDashboard() };
    }
    if (op === "create") {
        if (!payload.title || !payload.title.trim()) return { ok: false, error: "a title is required" };
        const ok = createObservation({
            type: payload.type, title: payload.title, project: payload.project,
            narrative: payload.narrative, facts: payload.facts, concepts: payload.concepts,
        });
        return ok ? { ok: true, view: recallDashboard() } : { ok: false, error: "could not store the memory" };
    }
    if (op === "generate") {
        const out = await generateObservation(payload.prompt || "", payload.project);
        return out.ok ? { ok: true, view: recallDashboard() } : { ok: false, error: out.error };
    }
    if (op === "set-provider") {
        if (payload.provider !== undefined) {
            if (!RECALL_PROVIDERS.includes(payload.provider as RecallProvider)) return { ok: false, error: "unknown provider" };
            setEnigmaValue("recallProvider", payload.provider, "global");
        }
        if (typeof payload.model === "string") setEnigmaValue("recallModel", payload.model.trim(), "global");
        if (typeof payload.base === "string") setEnigmaValue("recallApiBase", payload.base.trim(), "global");
        // Empty string clears the key; undefined leaves it as-is (so the UI never has to echo it).
        // Stored encrypted at rest (secret-box.ts).
        if (typeof payload.key === "string") setRecallApiKey(payload.key, "global");
        if (typeof payload.llm === "boolean") setEnigmaValue("recallLlm", payload.llm, "global");
        return { ok: true, view: recallDashboard() };
    }
    return { ok: false, error: `unknown op '${op}'` };
}
