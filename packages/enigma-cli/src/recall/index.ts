/**
 * Recall public surface: scan coding-agent transcripts into the local memory store
 * (incrementally), search it, and format a context block for retrieval. This is the only
 * module other parts of enigma import; the CLI, MCP server, dashboard bridge and TUI all
 * go through here.
 */

import * as store from "./store";
import { homedir } from "node:os";
import { readConfig } from "../config";
import { basename, join } from "node:path";
import { OBSERVATION_TYPES } from "./types";
import { readGlobalGuard } from "../guard-config";
import { createHash, randomUUID } from "node:crypto";
import { buildSecretMatchers, redactSecrets } from "../guard";
import { claudeProjectsDirs, listJsonl } from "../claude-transcripts";
import { recallDir, recallAvailable, recallDbBytes, openDb } from "./db";
import { extractSession, extractCodexSession, stripPrivate } from "./extract";
import { enrichSession, enrichAvailable, generateObservationFields } from "./enrich";
import { statSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import type { Observation, ObservationHit, ObservationType, RecallStats, SessionSummary } from "./types";

export type { Observation, ObservationHit, RecallStats, RecallSource, SessionSummary, ObservationType } from "./types";
export { recallAvailable, RecallUnavailableError } from "./db";
export { searchObservations, hybridSearch, recentObservations, getObservations, listSummaries, listProjects, timelineAround, listSessions, MAX_QUERIES, type QueryOptions, type SearchOptions, type SessionRow } from "./store";

/** Outcome of a sync pass. */
export interface SyncResult {
    available: boolean;
    scanned: number;
    changed: number;
    sessions: number;
    observations: number;
}

/** Per-file state so unchanged transcripts are not re-parsed across syncs. */
interface SyncState { files: Record<string, { mtime: number; size: number; }>; lastSync: number; }

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
 * Where Codex keeps its rollouts: `$CODEX_HOME/sessions` (default `~/.codex`), plus every
 * enigma-managed Codex account under `~/.enigma/codex/<id>/sessions`.
 */
function codexSessionsDirs(): string[] {
    const dirs = new Set<string>([join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")]);
    const base = join(homedir(), ".enigma", "codex");
    try {
        for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) dirs.add(join(base, e.name, "sessions"));
    } catch { /* no managed Codex accounts */ }
    return [...dirs].filter((d) => existsSync(d));
}

/**
 * Scan all Claude and Codex transcripts and store memories from any that changed since the last sync.
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
    const transcripts: { path: string; source: "claude" | "codex"; }[] = [];
    for (const src of claudeProjectsDirs()) {
        for (const path of listJsonl(src.dir)) {
            if (!path.replace(/\\/g, "/").includes("/subagents/")) transcripts.push({ path, source: "claude" });
        }
    }
    for (const dir of codexSessionsDirs()) {
        for (const path of listJsonl(dir)) if (/rollout-[^\\/]*\.jsonl$/.test(path)) transcripts.push({ path, source: "codex" });
    }
    for (const { path, source } of transcripts) {
        let st: import("node:fs").Stats;
        try { st = statSync(path); } catch { continue; }
        scanned++;
        next.files[path] = { mtime: st.mtimeMs, size: st.size };
        const prev = state.files[path];
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue;
        changed++;
        const result = source === "codex" ? extractCodexSession(path, matchers) : extractSession(path, "claude", matchers);
        if (!result) continue;
        store.insertSession(result.session, db);
        sessions++;
        for (const o of result.observations) if (store.insertObservation(o, db)) observations++;
        if (result.summary) store.insertSummary(result.summary, db);
    }
    // Safety net: embed any observation a bulk path may have inserted without a vector
    // (normal inserts embed inline, so this is usually a no-op).
    store.backfillVectors(db);
    writeState(next);
    return { available: true, scanned, changed, sessions, observations };
}

/**
 * Search the memory store (hybrid keyword + vector, falling back to recent for an empty query).
 * `query` may be several phrasings of one need; they are fused by RRF (see store.hybridSearch).
 */
export function searchRecall(query: string | string[], opts: store.SearchOptions = {}): ObservationHit[] {
    if (!recallAvailable()) return [];
    return store.hybridSearch(query, opts);
}

/** Chronological context around an observation or project (the search -> timeline step). */
export function recallTimeline(opts: { id?: number; project?: string; before?: number; after?: number; includeForgotten?: boolean; }): ObservationHit[] {
    if (!recallAvailable()) return [];
    return store.timelineAround(opts);
}

/** Recent sessions with their observation counts. */
export function recallSessions(opts: { project?: string; source?: string; limit?: number; } = {}): store.SessionRow[] {
    if (!recallAvailable()) return [];
    return store.listSessions(opts);
}

/** Bound the store: drop observations older than maxAgeDays and/or beyond maxRows. */
export function pruneRecall(opts: { maxAgeDays?: number; maxRows?: number; }): number {
    if (!recallAvailable()) return 0;
    return store.prune(opts);
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
export async function enrichRecall(opts: { maxSessions?: number; force?: boolean; } = {}): Promise<EnrichSummary> {
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
    for (const sid of store.sessionsNeedingEnrichment(max, db)) {
        const obs = store.observationsOfSession(sid, db);
        if (!obs.length) continue;
        const project = obs[0]!.project;
        const result = await enrichSession(project, obs);
        if (!result) continue; // transient failure: retry next pass
        // The LLM returns only the observations worth keeping (curated + rewritten); any it
        // omits are judged trivial and discarded, the same selectivity claude-mem gets from
        // its <skip_summary>. The per-session summary below still records the session.
        for (const o of obs) {
            const f = result.perId[o.id!];
            if (f) { store.applyEnrichment(o.id!, f, db); out.observations++; }
            else { store.deleteObservation(o.id!, db); }
        }
        store.markSessionEnriched(sid, db);
        if (result.summary) store.insertSummary({
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
    const stats = store.recallStats();
    stats.dbBytes = recallDbBytes();
    return { available: true, stats, lastSync: readState().lastSync, projects: store.listProjects() };
}

/** Wipe all stored memories. */
export function resetRecall(): void {
    if (!recallAvailable()) return;
    store.clearRecall();
    writeState({ files: {}, lastSync: 0 });
}

/** Delete one stored memory by id (its FTS row and vector follow via trigger/cascade). */
export function deleteRecallObservation(id: number): void {
    if (!recallAvailable() || !Number.isInteger(id) || id <= 0) return;
    store.deleteObservation(id, openDb());
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
    const contentHash = createHash("sha256").update([title, narrative ?? "", facts.join("|"), concepts.join("|"), createdAt].join("\0")).digest("hex");
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
    return obs ? store.insertObservation(obs, openDb()) : false;
}

/** A validated parse, or the reason the input was rejected (never a patched-up value). */
export type Parsed<T> = { ok: true; value: T; } | { ok: false; error: string; };

/** What an agent passes to remember, after validation. */
export interface RememberInput {
    content: string;
    type: ObservationType;
    /** Files the memory is about; stored as files_modified so supersession and search key on them. */
    files: string[];
    concepts: string[];
}

const REMEMBER_MAX_CHARS = 4000;
const REMEMBER_LIST_MAX = 20;
const FORGET_REASON_MAX = 500;
/** Most ids one forget call may take - a bulk wipe is `recall clear`/prune, not an agent call. */
export const FORGET_MAX_IDS = 20;

/** Validate an optional list of non-empty strings, each at most maxLen, at most REMEMBER_LIST_MAX long. */
function parseStringList(raw: unknown, field: string, maxLen: number, lower = false): Parsed<string[]> {
    if (raw === undefined || raw === null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return { ok: false, error: `'${field}' must be an array of strings` };
    if (raw.length > REMEMBER_LIST_MAX) return { ok: false, error: `'${field}' takes at most ${REMEMBER_LIST_MAX} entries` };
    const out: string[] = [];
    for (const v of raw) {
        if (typeof v !== "string") return { ok: false, error: `'${field}' must be an array of strings` };
        const t = lower ? v.trim().toLowerCase() : v.trim();
        if (!t) return { ok: false, error: `'${field}' has an empty entry` };
        if (t.length > maxLen) return { ok: false, error: `'${field}' entries are at most ${maxLen} characters` };
        out.push(t);
    }
    return { ok: true, value: [...new Set(out)] };
}

/** Validate enigma_recall_remember arguments against the explicit schema. */
export function parseRememberInput(args: Record<string, unknown>): Parsed<RememberInput> {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) return { ok: false, error: "'content' (non-empty string) is required" };
    if (content.length > REMEMBER_MAX_CHARS) return { ok: false, error: `'content' is at most ${REMEMBER_MAX_CHARS} characters - store one fact per call` };
    const type = typeof args.type === "string" ? args.type.trim().toLowerCase() : "";
    if (!(OBSERVATION_TYPES as readonly string[]).includes(type)) return { ok: false, error: `'type' must be one of: ${OBSERVATION_TYPES.join(", ")}` };
    const files = parseStringList(args.files, "files", 300);
    if (!files.ok) return files;
    const concepts = parseStringList(args.concepts, "concepts", 60, true);
    if (!concepts.ok) return concepts;
    return { ok: true, value: { content, type: type as ObservationType, files: files.value, concepts: concepts.value } };
}

/** Validate enigma_recall_forget arguments: 1..FORGET_MAX_IDS positive integer ids and a reason. */
export function parseForgetInput(args: Record<string, unknown>): Parsed<{ ids: number[]; reason: string; }> {
    if (!Array.isArray(args.ids) || !args.ids.length) return { ok: false, error: "'ids' (non-empty array of observation ids) is required" };
    if (!args.ids.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) return { ok: false, error: "'ids' must be positive integer observation ids" };
    const ids = [...new Set(args.ids as number[])];
    if (ids.length > FORGET_MAX_IDS) return { ok: false, error: `at most ${FORGET_MAX_IDS} ids per call` };
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) return { ok: false, error: "'reason' (non-empty string) is required - say why it is outdated or wrong" };
    if (reason.length > FORGET_REASON_MAX) return { ok: false, error: `'reason' is at most ${FORGET_REASON_MAX} characters` };
    return { ok: true, value: { ids, reason } };
}

/** The project an agent's explicit memory belongs to: the working directory's name, as extraction derives it from a transcript's cwd. */
export function currentProject(cwd: string = process.cwd()): string {
    return basename(cwd) || "unknown";
}

/**
 * A remembered fact's title: its first sentence. Unlike a prompt title it only breaks on a
 * terminator FOLLOWED by whitespace, so "src/auth.ts" is not cut at the dot - titles drive
 * supersession, and "Use src/auth" would make unrelated facts about that file look identical.
 */
function rememberTitle(text: string): string {
    const first = text.split("\n")[0]!;
    const end = first.search(/[.!?](\s|$)/);
    const title = end > 0 ? first.slice(0, end) : first;
    return title.length > 90 ? `${title.slice(0, 89).trimEnd()}...` : title;
}

/** What remembering did. */
export type RememberResult =
    | { ok: true; id: number; status: "inserted" | "reinforced"; sourceCount: number; superseded: number[]; supersededBy?: number; }
    | { ok: false; error: string; };

/**
 * Store an agent's explicit memory in `project`, through the same privacy path as transcript
 * extraction (<private> blocks dropped, secrets redacted with the guard's matchers) and the same
 * dedupe/supersession as every other observation: remembering a known fact reinforces it,
 * remembering an update of one files the old version as history.
 */
export function rememberRecall(input: RememberInput, project: string, now: number = Date.now()): RememberResult {
    if (!recallAvailable()) return { ok: false, error: "recall needs the enigma binary" };
    const matchers = buildSecretMatchers(readGlobalGuard().secretPatterns);
    const redact = (s: string): string => redactSecrets(s, matchers).text;
    const text = redact(stripPrivate(input.content)).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    if (!text) return { ok: false, error: "'content' is empty once <private> blocks are removed - nothing to store" };
    const obs: Observation = {
        // A fresh session id per explicit memory: each call is its own source, so the same fact
        // remembered again counts as reinforcement rather than a re-sync.
        sessionId: `remember-${randomUUID()}`,
        project, source: "manual", type: input.type,
        title: rememberTitle(text), narrative: text,
        facts: [], concepts: input.concepts.map(redact),
        filesRead: [], filesModified: input.files.map(redact),
        contentHash: createHash("sha256").update(text).digest("hex").slice(0, 16),
        createdAt: now,
    };
    const r = store.storeObservation(obs, openDb());
    if (r.status === "ignored") return { ok: false, error: "not stored (concurrent write) - retry" };
    return { ok: true, id: r.id, status: r.status, sourceCount: r.sourceCount, superseded: r.superseded, supersededBy: r.supersededBy };
}

/** What forgetting did. */
export type ForgetResult = ({ ok: true; } & store.ForgetOutcome) | { ok: false; error: string; };

/**
 * Soft-forget observations by id. All-or-nothing on the ids: one unknown id rejects the whole
 * call, so an agent citing a stale or invented id learns it instead of half-succeeding.
 */
export function forgetRecall(ids: number[], reason: string, now: number = Date.now()): ForgetResult {
    if (!recallAvailable()) return { ok: false, error: "recall needs the enigma binary" };
    const db = openDb();
    const found = new Set(store.existingIds(ids, db));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) return { ok: false, error: `unknown observation id(s): ${missing.join(", ")} - nothing was forgotten` };
    const why = redactSecrets(reason, buildSecretMatchers(readGlobalGuard().secretPatterns)).text;
    return { ok: true, ...store.forgetObservations(ids, why, now, db) };
}

/** Outcome of an LLM generation request. */
export interface GenerateResult { ok: boolean; error?: string; }

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
export function recallContext(opts: { project?: string; source?: string; limit?: number; } = {}): string {
    if (!recallAvailable()) return "";
    const limit = Math.max(1, Math.min(opts.limit ?? 15, 50));
    const summaries = store.listSummaries({ project: opts.project, source: opts.source, limit: 5 });
    const observations = store.recentObservations({ project: opts.project, source: opts.source, limit });
    if (!summaries.length && !observations.length) return "";
    return wrapRecallBlock(contextBody(opts.project, summaries, observations));
}

/**
 * The delimited block every recall output meant for an agent's context is wrapped in. Stored
 * text comes from past transcripts and agent-written memories, i.e. it is DATA that may contain
 * instructions; the readonly block says so, and escaping any delimiter inside it means stored
 * text can neither close the block early nor open a nested one.
 */
export const RECALL_BLOCK_START = "<enigma-recall context=\"past-sessions\" readonly>";
export const RECALL_BLOCK_END = "</enigma-recall>";
/** Any opening or closing delimiter tag, however spaced or cased (even unterminated). */
const RECALL_TAG = /<(\s*\/?\s*enigma-recall\b)/gi;

/** Neutralize delimiter tags in stored text ("<enigma-recall" -> "&lt;enigma-recall"). */
export function escapeRecallDelimiters(text: string): string {
    return text.replace(RECALL_TAG, "&lt;$1");
}

/** Wrap text in the readonly recall block, escaping any delimiter it carries. Empty in, empty out. */
export function wrapRecallBlock(text: string): string {
    const body = text.trim();
    return body ? `${RECALL_BLOCK_START}\n${escapeRecallDelimiters(body)}\n${RECALL_BLOCK_END}` : "";
}

/**
 * JSON for a recall block: every "<" becomes its JSON unicode escape, so the payload still parses
 * to the identical value while no delimiter can appear in it at all.
 */
export function recallJson(value: unknown): string {
    return wrapRecallBlock(JSON.stringify(value, null, 2).replace(/</g, "\\u003c"));
}

/** Parse the JSON payload back out of a recallJson block (for callers and tests). */
export function unwrapRecallJson(text: string): unknown {
    const start = text.indexOf("\n"), end = text.lastIndexOf(`\n${RECALL_BLOCK_END}`);
    return JSON.parse(start >= 0 && end > start ? text.slice(start + 1, end) : text);
}

function contextBody(project: string | undefined, summaries: SessionSummary[], observations: ObservationHit[]): string {
    const lines: string[] = [];
    lines.push(`# Project memory${project ? `: ${project}` : ""}`);
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
