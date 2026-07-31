/**
 * Bridge exposing the recall session-memory store (recall/) to the dashboard's HTTP API:
 * a serializable view (status + recent/searched observations) and two actions (sync, clear).
 * Imported dynamically by dashboard.ts only when the Recall panel is used.
 *
 * When the panel is open and recall is enabled, a throttled background sync keeps the store
 * fresh from new transcripts without blocking the request (the same stale-while-revalidate
 * shape usage.ts uses), so the user rarely needs the manual "Sync now" button.
 */

import * as conf from "./config";
import * as recall from "./recall";

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

function toItem(o: recall.ObservationHit): RecallItem {
    return {
        id: o.id, type: o.type, title: o.title, subtitle: o.subtitle, project: o.project, source: o.source,
        files: o.filesModified, filesRead: o.filesRead, facts: o.facts, concepts: o.concepts,
        narrative: o.narrative, createdAt: o.createdAt,
    };
}

/** The recall LLM-provider config, surfaced to the dashboard (the key value is never sent). */
export interface RecallProviderView {
    provider: conf.RecallProvider;
    model: string;
    base: string;
    /** Whether a key is set in config or via ENIGMA_RECALL_API_KEY (the value is never exposed). */
    hasKey: boolean;
    /** True when the key comes from the env var (config field is then ignored/locked). */
    keyFromEnv: boolean;
    /** LLM curation on (recallLlm). */
    llm: boolean;
    providers: readonly conf.RecallProvider[];
}

/** Everything the Recall tab needs in one payload. */
export interface RecallView {
    /** bun:sqlite present (false under a Node-only run). */
    available: boolean;
    /** config.recall is on. */
    enabled: boolean;
    stats: recall.RecallStats | null;
    lastSync: number;
    projects: string[];
    query: string;
    items: RecallItem[];
    provider: RecallProviderView;
}

function providerView(): RecallProviderView {
    const c = conf.readConfig().config;
    const envKey = !!process.env.ENIGMA_RECALL_API_KEY;
    return {
        provider: c.recallProvider, model: c.recallModel, base: c.recallApiBase,
        hasKey: envKey || !!c.recallApiKey, keyFromEnv: envKey, llm: c.recallLlm,
        providers: conf.RECALL_PROVIDERS,
    };
}

let lastSyncAttempt = 0;
const SYNC_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Kick a background sync at most every few minutes; never blocks the response. Also runs an LLM
 * curation pass (a no-op unless recallLlm is on and a provider has credentials), so the dashboard
 * - not just the CLI - actually curates the memory the way claude-mem does. enrichRecall is
 * internally throttled/capped, so repeated calls just drain the queue a batch at a time.
 */
function maybeBackgroundSync(): void {
    const now = Date.now();
    if (now - lastSyncAttempt < SYNC_THROTTLE_MS) return;
    lastSyncAttempt = now;
    setTimeout(() => {
        try { recall.syncRecall(); } catch { /* best-effort */ }
        void recall.enrichRecall().catch(() => { /* best-effort */ });
    }, 0);
}

/** Build the Recall view: search results when a query is given, else recent observations. */
export function recallDashboard(opts: { q?: string; project?: string; type?: string; } = {}): RecallView {
    const enabled = conf.readConfig().config.recall;
    const available = recall.recallAvailable();
    if (!available || !enabled) return { available, enabled, stats: null, lastSync: 0, projects: [], query: opts.q || "", items: [], provider: providerView() };
    maybeBackgroundSync();
    const st = recall.recallStatus();
    const q = (opts.q || "").trim();
    const hits = q
        ? recall.searchRecall(q, { project: opts.project, type: opts.type, limit: 50 })
        : recall.recentObservations({ project: opts.project, type: opts.type, limit: 50 });
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
    if (!recall.recallAvailable() || !conf.readConfig().config.recall) return [];
    return recall.recallTimeline({ id }).map(toItem);
}

/**
 * Payload for Recall actions: set-provider fields (key omitted leaves the stored key unchanged),
 * an observation id (delete), manual-memory fields (create), and a free-text note (generate).
 */
export interface RecallActionPayload {
    provider?: string; model?: string; base?: string; key?: string; llm?: boolean;
    id?: number;
    /** Bulk delete: several observation ids at once (the dashboard's multi-select). */
    ids?: number[];
    type?: string; title?: string; project?: string; narrative?: string; facts?: string[]; concepts?: string[];
    prompt?: string;
}

/** Apply a Recall action and return the refreshed view. */
export async function applyRecallAction(op: string, payload: RecallActionPayload = {}): Promise<{ ok: boolean; error?: string; view?: RecallView; }> {
    if (!recall.recallAvailable()) return { ok: false, error: "recall needs the enigma binary" };
    if (op === "sync") {
        recall.syncRecall();
        // Curate in the background (opt-in via recallLlm): a set of model calls must never block
        // the response, and the dashboard's poll surfaces curated rows as they land. Forced so the
        // explicit button bypasses the inter-pass throttle.
        void recall.enrichRecall({ force: true }).catch(() => { /* best-effort */ });
        return { ok: true, view: recallDashboard() };
    }
    if (op === "clear") { recall.resetRecall(); return { ok: true, view: recallDashboard() }; }
    if (op === "delete") {
        const ids = Array.isArray(payload.ids)
            ? payload.ids.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
            : (typeof payload.id === "number" ? [payload.id] : []);
        if (!ids.length) return { ok: false, error: "missing memory id" };
        for (const id of ids) recall.deleteRecallObservation(id);
        return { ok: true, view: recallDashboard() };
    }
    if (op === "create") {
        if (!payload.title || !payload.title.trim()) return { ok: false, error: "a title is required" };
        const ok = recall.createObservation({
            type: payload.type, title: payload.title, project: payload.project,
            narrative: payload.narrative, facts: payload.facts, concepts: payload.concepts,
        });
        return ok ? { ok: true, view: recallDashboard() } : { ok: false, error: "could not store the memory" };
    }
    if (op === "generate") {
        const out = await recall.generateObservation(payload.prompt || "", payload.project);
        return out.ok ? { ok: true, view: recallDashboard() } : { ok: false, error: out.error };
    }
    if (op === "set-provider") {
        if (payload.provider !== undefined) {
            if (!conf.RECALL_PROVIDERS.includes(payload.provider as conf.RecallProvider)) return { ok: false, error: "unknown provider" };
            conf.setEnigmaValue("recallProvider", payload.provider, "global");
        }
        if (typeof payload.model === "string") conf.setEnigmaValue("recallModel", payload.model.trim(), "global");
        if (typeof payload.base === "string") conf.setEnigmaValue("recallApiBase", payload.base.trim(), "global");
        // Empty string clears the key; undefined leaves it as-is (so the UI never has to echo it).
        // Stored encrypted at rest (secret-box.ts).
        if (typeof payload.key === "string") conf.setRecallApiKey(payload.key, "global");
        if (typeof payload.llm === "boolean") conf.setEnigmaValue("recallLlm", payload.llm, "global");
        return { ok: true, view: recallDashboard() };
    }
    return { ok: false, error: `unknown op '${op}'` };
}
