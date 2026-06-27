/**
 * Bridge exposing the recall session-memory store (recall/) to the dashboard's HTTP API:
 * a serializable view (status + recent/searched observations) and two actions (sync, clear).
 * Imported dynamically by dashboard.ts only when the Recall panel is used.
 *
 * When the panel is open and recall is enabled, a throttled background sync keeps the store
 * fresh from new transcripts without blocking the request (the same stale-while-revalidate
 * shape usage.ts uses), so the user rarely needs the manual "Sync now" button.
 */

import { readConfig } from "./config";
import type { ObservationHit, RecallStats } from "./recall";
import { recallAvailable, recallStatus, searchRecall, recentObservations, resetRecall, syncRecall, recallTimeline } from "./recall";

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
    if (!available || !enabled) return { available, enabled, stats: null, lastSync: 0, projects: [], query: opts.q || "", items: [] };
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
    };
}

/** Chronological context around an observation, for the dashboard timeline view. */
export function recallTimelineView(id: number): RecallItem[] {
    if (!recallAvailable() || !readConfig().config.recall) return [];
    return recallTimeline({ id }).map(toItem);
}

/** Apply a Recall action and return the refreshed view. */
export function applyRecallAction(op: string): { ok: boolean; error?: string; view?: RecallView } {
    if (!recallAvailable()) return { ok: false, error: "recall needs the enigma binary" };
    if (op === "sync") { syncRecall(); return { ok: true, view: recallDashboard() }; }
    if (op === "clear") { resetRecall(); return { ok: true, view: recallDashboard() }; }
    return { ok: false, error: `unknown op '${op}'` };
}
