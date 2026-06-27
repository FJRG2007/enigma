/**
 * Recall public surface: scan coding-agent transcripts into the local memory store
 * (incrementally), search it, and format a context block for retrieval. This is the only
 * module other parts of enigma import; the CLI, MCP server, dashboard bridge and TUI all
 * go through here.
 */

import { join } from "node:path";
import { readConfig } from "../config";
import { extractSession } from "./extract";
import { buildSecretMatchers } from "../guard";
import { readGlobalGuard } from "../guard-config";
import { createHash, randomUUID } from "node:crypto";
import { OBSERVATION_TYPES } from "./types";
import { enrichSession, enrichAvailable, generateObservationFields } from "./enrich";
import { claudeProjectsDirs, listJsonl } from "../claude-transcripts";
import { recallDir, recallAvailable, recallDbBytes, openDb } from "./db";
import type { Observation, ObservationHit, ObservationType, RecallStats, SessionSummary } from "./types";
import { statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { insertObservation, insertSession, insertSummary, recallStats, searchObservations, hybridSearch, recentObservations, listSummaries, listProjects, getObservations, clearRecall, backfillVectors, timelineAround, listSessions, prune, sessionsNeedingEnrichment, observationsOfSession, applyEnrichment, markSessionEnriched, deleteObservation, type QueryOptions, type SessionRow } from "./store";

export type { Observation, ObservationHit, RecallStats, RecallSource, SessionSummary, ObservationType } from "./types";
export { recallAvailable, RecallUnavailableError } from "./db";
export { searchObservations, hybridSearch, recentObservations, getObservations, listSummaries, listProjects, timelineAround, listSessions, type QueryOptions, type SessionRow } from "./store";

/** Outcome of a sync pass. */
export interface SyncResult {
    available: boolean;
    scanned: number;
    changed: number;
    sessions: number;
    observations: number;
}

/** Per-file state so unchanged transcripts are not re-parsed across syncs. */
interface SyncState { files: Record<string, { mtime: number; size: number }>; lastSync: number; }

function statePath(): string { return join(recallDir(), "state.json"); }

function readState(): SyncState {
    try { return JSON.parse(readFileSync(statePath(), "utf8")) as SyncState; } catch { return { files: {}, lastSync: 0 }; }
}

function writeState(state: SyncState): void {
    try {
        const dir = recallDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(statePath(), JSON.stringify(state));
    } catch { /* state is best-effort; a lost state just re-scans next time (dedup absorbs it) */ }
}

/**
 * Scan all Claude transcripts and store memories from any that changed since the last sync.
 * Subagent (sidechain) transcripts are skipped - they are fragments of a parent session and
 * would only add noise. Dedup at the store layer makes a full re-scan idempotent.
 */
export function syncRecall(): SyncResult {
    if (!recallAvailable()) return { available: false, scanned: 0, changed: 0, sessions: 0, observations: 0 };
    const db = openDb();
    const state = readState();
    const next: SyncState = { files: {}, lastSync: Date.now() };
    const matchers = buildSecretMatchers(readGlobalGuard().secretPatterns);
    let scanned = 0, changed = 0, sessions = 0, observations = 0;
    for (const src of claudeProjectsDirs()) {
        for (const path of listJsonl(src.dir)) {
            if (path.replace(/\\/g, "/").includes("/subagents/")) continue;
            let st: import("node:fs").Stats;
            try { st = statSync(path); } catch { continue; }
            scanned++;
            next.files[path] = { mtime: st.mtimeMs, size: st.size };
            const prev = state.files[path];
            if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue;
            changed++;
            const result = extractSession(path, "claude", matchers);
            if (!result) continue;
            insertSession(result.session, db);
            sessions++;
            for (const o of result.observations) if (insertObservation(o, db)) observations++;
            if (result.summary) insertSummary(result.summary, db);
        }
    }
    // Safety net: embed any observation a bulk path may have inserted without a vector
    // (normal inserts embed inline, so this is usually a no-op).
    backfillVectors(db);
    writeState(next);
    return { available: true, scanned, changed, sessions, observations };
}

/** Search the memory store (hybrid keyword + vector, falling back to recent for an empty query). */
export function searchRecall(query: string, opts: QueryOptions = {}): ObservationHit[] {
    if (!recallAvailable()) return [];
    return hybridSearch(query, opts);
}

/** Chronological context around an observation or project (the search -> timeline step). */
export function recallTimeline(opts: { id?: number; project?: string; before?: number; after?: number }): ObservationHit[] {
    if (!recallAvailable()) return [];
    return timelineAround(opts);
}

/** Recent sessions with their observation counts. */
export function recallSessions(opts: { project?: string; source?: string; limit?: number } = {}): SessionRow[] {
    if (!recallAvailable()) return [];
    return listSessions(opts);
}

/** Bound the store: drop observations older than maxAgeDays and/or beyond maxRows. */
export function pruneRecall(opts: { maxAgeDays?: number; maxRows?: number }): number {
    if (!recallAvailable()) return 0;
    return prune(opts);
}

export { enrichAvailable } from "./enrich";

/** Outcome of an enrichment pass. */
export interface EnrichSummary { available: boolean; enabled: boolean; hasLogin: boolean; sessions: number; observations: number; }

let lastEnrich = 0;
const ENRICH_THROTTLE_MS = 60_000;

/**
 * Enrich un-enriched sessions with the LLM (opt-in via recallLlm), newest first, capped per
 * pass to bound quota use. Throttled unless forced (the CLI forces). Best-effort: a failed
 * session is left un-enriched to retry on a later pass; a session that returns nothing is
 * still marked done so the queue drains.
 */
export async function enrichRecall(opts: { maxSessions?: number; force?: boolean } = {}): Promise<EnrichSummary> {
    const out: EnrichSummary = { available: recallAvailable(), enabled: false, hasLogin: false, sessions: 0, observations: 0 };
    if (!out.available) return out;
    out.enabled = readConfig().config.recallLlm;
    if (!out.enabled) return out;
    out.hasLogin = enrichAvailable();
    if (!out.hasLogin) return out;
    const now = Date.now();
    if (!opts.force && now - lastEnrich < ENRICH_THROTTLE_MS) return out;
    lastEnrich = now;
    const db = openDb();
    const max = Math.max(1, Math.min(opts.maxSessions ?? 8, 50));
    for (const sid of sessionsNeedingEnrichment(max, db)) {
        const obs = observationsOfSession(sid, db);
        if (!obs.length) continue;
        const project = obs[0]!.project;
        const result = await enrichSession(project, obs);
        if (!result) continue; // transient failure: retry next pass
        // The LLM returns only the observations worth keeping (curated + rewritten); any it
        // omits are judged trivial and discarded, the same selectivity claude-mem gets from
        // its <skip_summary>. The per-session summary below still records the session.
        for (const o of obs) {
            const f = result.perId[o.id!];
            if (f) { applyEnrichment(o.id!, f, db); out.observations++; }
            else { deleteObservation(o.id!, db); }
        }
        markSessionEnriched(sid, db);
        if (result.summary) insertSummary({
            sessionId: sid, project, source: obs[0]!.source,
            request: result.summary.request, learned: result.summary.learned,
            completed: result.summary.completed, nextSteps: result.summary.nextSteps,
            filesEdited: [...new Set(obs.flatMap((o) => o.filesModified))].slice(0, 50),
            createdAt: obs[obs.length - 1]!.createdAt,
        }, db);
        out.sessions++;
    }
    return out;
}

/** Status snapshot for the CLI/TUI/dashboard. */
export interface RecallStatus {
    available: boolean;
    stats: RecallStats | null;
    lastSync: number;
    projects: string[];
}

export function recallStatus(): RecallStatus {
    if (!recallAvailable()) return { available: false, stats: null, lastSync: 0, projects: [] };
    const stats = recallStats();
    stats.dbBytes = recallDbBytes();
    return { available: true, stats, lastSync: readState().lastSync, projects: listProjects() };
}

/** Wipe all stored memories. */
export function resetRecall(): void {
    if (!recallAvailable()) return;
    clearRecall();
    writeState({ files: {}, lastSync: 0 });
}

/** Delete one stored memory by id (its FTS row and vector follow via trigger/cascade). */
export function deleteRecallObservation(id: number): void {
    if (!recallAvailable() || !Number.isInteger(id) || id <= 0) return;
    deleteObservation(id, openDb());
}

/** Fields for a user-authored ("manual") memory; only the title is required. */
export interface ManualObservationInput {
    type?: string;
    title: string;
    project?: string;
    narrative?: string;
    facts?: string[];
    concepts?: string[];
}

/** Build a manual observation from user input, or null when it has no usable title. */
function buildManualObservation(input: ManualObservationInput): Observation | null {
    const title = (input.title || "").trim().slice(0, 200);
    if (!title) return null;
    const type = (OBSERVATION_TYPES as readonly string[]).includes(input.type || "") ? input.type as ObservationType : "decision";
    const createdAt = Date.now();
    const clean = (a?: string[]): string[] => (a || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
    const facts = clean(input.facts);
    const concepts = clean(input.concepts);
    const narrative = input.narrative ? String(input.narrative).trim().slice(0, 2000) : undefined;
    const contentHash = createHash("sha256").update([title, narrative ?? "", facts.join("|"), concepts.join("|"), createdAt].join(" ")).digest("hex");
    return {
        // A fresh session id per manual memory keeps each one distinct (UNIQUE session_id+hash).
        sessionId: `manual-${randomUUID()}`,
        project: (input.project || "").trim() || "manual",
        source: "manual",
        type, title, narrative, facts, concepts,
        filesRead: [], filesModified: [],
        contentHash, createdAt,
    };
}

/** Insert a user-authored memory. Returns true when stored. */
export function createObservation(input: ManualObservationInput): boolean {
    if (!recallAvailable()) return false;
    const obs = buildManualObservation(input);
    return obs ? insertObservation(obs, openDb()) : false;
}

/** Outcome of an LLM generation request. */
export interface GenerateResult { ok: boolean; error?: string }

/**
 * Generate one memory from a free-text note via the configured LLM provider, then store it.
 * Fails cleanly (no throw) when no provider is configured or the model returns nothing usable.
 */
export async function generateObservation(note: string, project?: string): Promise<GenerateResult> {
    if (!recallAvailable()) return { ok: false, error: "recall needs the enigma binary" };
    if (!(note || "").trim()) return { ok: false, error: "write a short note to generate from" };
    if (!enrichAvailable()) return { ok: false, error: "no LLM provider is configured - set a provider/key first" };
    const fields = await generateObservationFields(note);
    if (!fields) return { ok: false, error: "the model returned nothing usable" };
    return { ok: createObservation({ ...fields, project }), error: undefined };
}

/**
 * A compact, human/agent-readable context block for a project: the most recent session
 * summaries followed by recent observations. This is the "retrieve/inject" output - printed
 * by `enigma recall context` and returned by the MCP recall tools.
 */
export function recallContext(opts: { project?: string; source?: string; limit?: number } = {}): string {
    if (!recallAvailable()) return "";
    const limit = Math.max(1, Math.min(opts.limit ?? 15, 50));
    const summaries = listSummaries({ project: opts.project, source: opts.source, limit: 5 });
    const observations = recentObservations({ project: opts.project, source: opts.source, limit });
    if (!summaries.length && !observations.length) return "";
    const lines: string[] = [];
    lines.push(`# Project memory${opts.project ? `: ${opts.project}` : ""}`);
    if (summaries.length) {
        lines.push("", "## Recent sessions");
        for (const s of summaries) lines.push(formatSummary(s));
    }
    if (observations.length) {
        lines.push("", "## Recent observations");
        for (const o of observations) {
            const files = o.filesModified.length ? ` (${o.filesModified.slice(0, 4).join(", ")})` : "";
            lines.push(`- [#${o.id} ${o.type}] ${o.title}${files}`);
        }
    }
    return lines.join("\n");
}

function formatSummary(s: SessionSummary): string {
    const date = new Date(s.createdAt).toISOString().slice(0, 10);
    const parts = [`- ${date}: ${s.request || "(session)"}`];
    if (s.completed) parts.push(`  done: ${s.completed.slice(0, 200)}`);
    return parts.join("\n");
}
