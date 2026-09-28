/**
 * Recall data access: typed reads and writes over the SQLite store. All queries are
 * parameterized (never string-concatenated) and JSON-array columns are (de)serialized here
 * so callers work with plain string arrays.
 */

import { openDb, type RecallDb } from "./db";
import { normKey, normalizeFact, factTokens, normalizePath } from "./normalize";
import { localEmbed, cosine, packVector, unpackVector, type EmbeddingProvider } from "./embed";
import type { Observation, ObservationHit, RecallSession, RecallStats, SessionSummary } from "./types";

/** Options shared by search/recent/list reads. */
export interface QueryOptions {
    project?: string;
    source?: string;
    type?: string;
    limit?: number;
    /** Include soft-forgotten observations (default false). */
    includeForgotten?: boolean;
    /** Include observations replaced by a newer one (default false: search returns the latest). */
    includeSuperseded?: boolean;
}

/** Search options: the query filters plus the clock recency is measured against. */
export interface SearchOptions extends QueryOptions {
    /** epoch ms "now" for the recency decay; defaults to Date.now() (tests pin it). */
    now?: number;
}

function arr(value: unknown): string[] {
    if (typeof value !== "string" || !value) return [];
    try { const v = JSON.parse(value); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

function rowToObservation(r: Record<string, unknown>): ObservationHit {
    return {
        id: Number(r.id),
        sessionId: String(r.session_id),
        project: String(r.project),
        source: String(r.source) as Observation["source"],
        type: String(r.type) as Observation["type"],
        title: String(r.title),
        subtitle: str(r.subtitle),
        narrative: str(r.narrative),
        facts: arr(r.facts),
        concepts: arr(r.concepts),
        filesRead: arr(r.files_read),
        filesModified: arr(r.files_modified),
        promptNumber: r.prompt_number == null ? undefined : Number(r.prompt_number),
        contentHash: String(r.content_hash),
        createdAt: Number(r.created_at),
        sourceCount: r.source_count == null ? 1 : Number(r.source_count),
        supersededBy: r.superseded_by == null ? undefined : Number(r.superseded_by),
        forgottenAt: r.forgotten_at == null ? undefined : Number(r.forgotten_at),
        forgetReason: str(r.forget_reason),
        rank: r.rank == null ? undefined : Number(r.rank),
    };
}

function rowToSummary(r: Record<string, unknown>): SessionSummary {
    return {
        id: Number(r.id),
        sessionId: String(r.session_id),
        project: String(r.project),
        source: String(r.source) as SessionSummary["source"],
        request: str(r.request),
        learned: str(r.learned),
        completed: str(r.completed),
        nextSteps: str(r.next_steps),
        filesEdited: arr(r.files_edited),
        createdAt: Number(r.created_at),
    };
}

/** Upsert a session row (keeps the earliest start, advances the end). */
export function insertSession(s: RecallSession, db: RecallDb = openDb()): void {
    db.run(
        `INSERT INTO sessions (session_id, project, source, title, user_prompt, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           title = excluded.title,
           user_prompt = excluded.user_prompt,
           ended_at = MAX(sessions.ended_at, excluded.ended_at)`,
        s.sessionId, s.project, s.source, s.title ?? null, s.userPrompt ?? null, s.startedAt, s.endedAt,
    );
}

/** The text an observation is embedded/searched on. */
function observationText(o: Observation): string {
    return [o.title, o.subtitle, o.narrative, o.facts.join(" "), o.concepts.join(" "), o.filesModified.join(" ")].filter(Boolean).join(" ");
}

/** Store (or replace) the dense vector for an observation. */
export function upsertVector(observationId: number, vec: Float32Array, db: RecallDb = openDb()): void {
    db.run(
        `INSERT INTO observation_vectors (observation_id, vec) VALUES (?, ?)
         ON CONFLICT(observation_id) DO UPDATE SET vec = excluded.vec`,
        observationId, packVector(vec),
    );
}

/** What storing one observation did. */
export interface StoreOutcome {
    /** inserted = new row; reinforced = an identical fact already existed (its source_count grew); ignored = this exact turn is already stored. */
    status: "inserted" | "reinforced" | "ignored";
    /** The row that now holds the fact (the new one, or the existing duplicate); 0 when ignored by a race. */
    id: number;
    /** Rows this insert filed as history under the newest version. */
    superseded: number[];
    /** Set when the inserted row is itself older than a matching one and was filed as history. */
    supersededBy?: number;
    sourceCount: number;
}

/**
 * Supersession criterion - deliberately conservative, deterministic, and scoped to the same
 * project AND type (the candidate query narrows to those). A newer observation replaces an
 * older one only when it is plainly the same subject:
 *  1. identical normalized titles of at least SUPERSEDE_MIN_TITLE_TOKENS words, AND the files
 *     agree - both touched files and share at least one, or neither touched any and both are
 *     explicit memories (source "manual"). Two transcript turns with no files and a shared
 *     generic prompt ("continue with the tasks") are NOT treated as one subject; or
 *  2. the SAME non-empty set of modified files AND title word overlap (Jaccard) of at least
 *     SUPERSEDE_MIN_JACCARD.
 * Anything looser would hide distinct work from search; a missed supersession only leaves a
 * stale row visible, which is the cheaper mistake.
 */
const SUPERSEDE_MIN_TITLE_TOKENS = 3;
const SUPERSEDE_MIN_JACCARD = 0.5;
/** How many of the newest same-type rows a new observation is compared against. */
const SUPERSEDE_CANDIDATES = 200;

function fileSet(o: Observation): Set<string> {
    return new Set(o.filesModified.map(normalizePath).filter(Boolean));
}

function jaccard(a: string[], b: string[]): number {
    const sa = new Set(a), sb = new Set(b);
    if (!sa.size && !sb.size) return 0;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    return inter / (sa.size + sb.size - inter);
}

/** Whether a and b (same project, same type) describe the same subject - see the criterion above. */
export function isSameSubject(a: Observation, b: Observation): boolean {
    const fa = fileSet(a), fb = fileSet(b);
    const ta = normalizeFact(a.title), tb = normalizeFact(b.title);
    if (ta === tb && factTokens(ta).length >= SUPERSEDE_MIN_TITLE_TOKENS) {
        if (fa.size && fb.size) return [...fa].some((f) => fb.has(f));
        if (!fa.size && !fb.size) return a.source === "manual" && b.source === "manual";
        return false;
    }
    if (fa.size && fa.size === fb.size && [...fa].every((f) => fb.has(f))) return jaccard(factTokens(ta), factTokens(tb)) >= SUPERSEDE_MIN_JACCARD;
    return false;
}

/** The newer of two observations: later created_at, then the higher id. */
function newer(a: Observation, b: Observation): Observation {
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b;
    return (a.id ?? 0) > (b.id ?? 0) ? a : b;
}

/**
 * File every latest observation that is the same subject as `o` under the newest of the group.
 * Import order is not time order (a sync can meet an old transcript after a new one), so the
 * inserted row can itself end up as the history entry.
 */
function supersede(o: Observation, db: RecallDb): { superseded: number[]; supersededBy?: number; } {
    const rows = db.query(
        `SELECT * FROM observations
         WHERE project = ? AND type = ? AND id != ? AND superseded_by IS NULL AND forgotten_at IS NULL
         ORDER BY created_at DESC LIMIT ?`,
    ).all(o.project, o.type, o.id, SUPERSEDE_CANDIDATES);
    const group = rows.map(rowToObservation).filter((c) => isSameSubject(o, c));
    if (!group.length) return { superseded: [] };
    const winner = group.reduce((w, c) => newer(w, c), o);
    const losers = [o, ...group].filter((c) => c.id !== winner.id).map((c) => c.id!);
    for (const id of losers) db.run("UPDATE observations SET superseded_by = ? WHERE id = ?", winner.id, id);
    if (winner.id === o.id) return { superseded: losers };
    return { superseded: losers.filter((id) => id !== o.id), supersededBy: winner.id };
}

/**
 * Store an observation with cross-session dedupe and supersession, atomically:
 *  - the same turn again (UNIQUE session_id+content_hash, i.e. a re-sync) is ignored;
 *  - an exact normalized duplicate (normalize.ts normKey) of a latest, unforgotten row in the
 *    same project is not stored twice - the existing row's source_count grows instead, once per
 *    distinct session (observation_sources makes a re-synced session count once);
 *  - otherwise it is inserted (with its embedding unless embed is null, e.g. a bulk import that
 *    backfills vectors afterwards) and any older same-subject row is filed as history.
 */
export function storeObservation(o: Observation, db: RecallDb = openDb(), embed: EmbeddingProvider | null = localEmbed): StoreOutcome {
    return db.transaction((): StoreOutcome => {
        const same = db.query("SELECT id, source_count FROM observations WHERE session_id = ? AND content_hash = ?").get(o.sessionId, o.contentHash);
        if (same) return { status: "ignored", id: Number(same.id), superseded: [], sourceCount: Number(same.source_count ?? 1) };
        const key = normKey(o);
        const dup = db.query(
            "SELECT id, source_count FROM observations WHERE project = ? AND norm_hash = ? AND forgotten_at IS NULL AND superseded_by IS NULL ORDER BY id LIMIT 1",
        ).get(o.project, key);
        if (dup) {
            const id = Number(dup.id);
            const added = db.run("INSERT OR IGNORE INTO observation_sources (observation_id, session_id) VALUES (?, ?)", id, o.sessionId).changes > 0;
            if (added) db.run("UPDATE observations SET source_count = source_count + 1 WHERE id = ?", id);
            return { status: "reinforced", id, superseded: [], sourceCount: Number(dup.source_count ?? 1) + (added ? 1 : 0) };
        }
        const res = db.run(
            `INSERT OR IGNORE INTO observations
               (session_id, project, source, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, prompt_number, content_hash, norm_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            o.sessionId, o.project, o.source, o.type, o.title, o.subtitle ?? null, o.narrative ?? null,
            JSON.stringify(o.facts), JSON.stringify(o.concepts), JSON.stringify(o.filesRead), JSON.stringify(o.filesModified),
            o.promptNumber ?? null, o.contentHash, key, o.createdAt,
        );
        if (res.changes === 0) return { status: "ignored", id: 0, superseded: [], sourceCount: 1 };
        const id = Number(res.lastInsertRowid);
        db.run("INSERT OR IGNORE INTO observation_sources (observation_id, session_id) VALUES (?, ?)", id, o.sessionId);
        if (embed) upsertVector(id, embed(observationText(o)), db);
        return { status: "inserted", id, sourceCount: 1, ...supersede({ ...o, id }, db) };
    })();
}

/**
 * Insert an observation (see storeObservation for dedupe/supersession). Returns true only when a
 * new row was stored - a reinforced duplicate or an already-stored turn is false, which keeps
 * the sync counters meaning "new memories".
 */
export function insertObservation(o: Observation, db: RecallDb = openDb(), embed: EmbeddingProvider | null = localEmbed): boolean {
    return storeObservation(o, db, embed).status === "inserted";
}

/** Embed any observations that have no vector yet (migration/backfill). Returns the count done. */
export function backfillVectors(db: RecallDb = openDb(), embed: EmbeddingProvider = localEmbed): number {
    const rows = db.query(
        "SELECT o.* FROM observations o LEFT JOIN observation_vectors v ON v.observation_id = o.id WHERE v.observation_id IS NULL",
    ).all();
    for (const r of rows) { const o = rowToObservation(r); upsertVector(o.id!, embed(observationText(o)), db); }
    return rows.length;
}

/** Upsert a per-session summary. */
export function insertSummary(s: SessionSummary, db: RecallDb = openDb()): void {
    db.run(
        `INSERT INTO summaries (session_id, project, source, request, learned, completed, next_steps, files_edited, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           request = excluded.request, learned = excluded.learned, completed = excluded.completed,
           next_steps = excluded.next_steps, files_edited = excluded.files_edited, created_at = excluded.created_at`,
        s.sessionId, s.project, s.source, s.request ?? null, s.learned ?? null, s.completed ?? null,
        s.nextSteps ?? null, JSON.stringify(s.filesEdited), s.createdAt,
    );
}

/**
 * Build a `column = ?` filter clause + params from the common options. For observations
 * (`lifecycle`), forgotten and superseded rows are excluded unless asked for; summaries have
 * no lifecycle columns.
 */
function filterClause(opts: QueryOptions, prefix: string, lifecycle = true): { sql: string; params: unknown[]; } {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (lifecycle && !opts.includeForgotten) parts.push(`${prefix}forgotten_at IS NULL`);
    if (lifecycle && !opts.includeSuperseded) parts.push(`${prefix}superseded_by IS NULL`);
    if (opts.project) { parts.push(`${prefix}project = ?`); params.push(opts.project); }
    if (opts.source) { parts.push(`${prefix}source = ?`); params.push(opts.source); }
    if (opts.type) { parts.push(`${prefix}type = ?`); params.push(opts.type); }
    return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: keep alphanumeric tokens, make
 * each a prefix term, AND them together. Returns null when nothing usable remains (callers
 * fall back to recent). This avoids FTS syntax errors from user punctuation entirely.
 */
function ftsMatch(query: string): string | null {
    const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1).slice(0, 12);
    if (!tokens.length) return null;
    return tokens.map((t) => `${t}*`).join(" ");
}

/**
 * Search observations by full-text relevance (bm25) with optional filters. An empty or
 * token-less query falls back to most-recent.
 */
export function searchObservations(query: string, opts: QueryOptions = {}, db: RecallDb = openDb()): ObservationHit[] {
    const match = ftsMatch(query || "");
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    if (!match) return recentObservations(opts, db);
    const f = filterClause(opts, "o.");
    const rows = db.query(
        `SELECT o.*, bm25(observations_fts) AS rank
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         WHERE observations_fts MATCH ?${f.sql}
         ORDER BY rank
         LIMIT ?`,
    ).all(match, ...f.params, limit);
    return rows.map(rowToObservation);
}

/** Most-recent observations with optional filters. */
export function recentObservations(opts: QueryOptions = {}, db: RecallDb = openDb()): ObservationHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const f = filterClause(opts, "");
    const rows = db.query(
        `SELECT * FROM observations WHERE 1=1${f.sql} ORDER BY created_at DESC LIMIT ?`,
    ).all(...f.params, limit);
    return rows.map(rowToObservation);
}

/** Fetch full observations by id (the 3-layer search -> get pattern). */
export function getObservations(ids: number[], db: RecallDb = openDb()): Observation[] {
    const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    if (!clean.length) return [];
    const placeholders = clean.map(() => "?").join(",");
    const rows = db.query(`SELECT * FROM observations WHERE id IN (${placeholders})`).all(...clean);
    return rows.map(rowToObservation);
}

/** Most-recent session summaries with optional project/source filters. */
export function listSummaries(opts: QueryOptions = {}, db: RecallDb = openDb()): SessionSummary[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const f = filterClause(opts, "", false);
    const rows = db.query(
        `SELECT * FROM summaries WHERE 1=1${f.sql} ORDER BY created_at DESC LIMIT ?`,
    ).all(...f.params, limit);
    return rows.map(rowToSummary);
}

/** Distinct project names known to recall, most-recently-active first. */
export function listProjects(db: RecallDb = openDb()): string[] {
    const rows = db.query("SELECT project, MAX(created_at) AS t FROM observations GROUP BY project ORDER BY t DESC").all();
    return rows.map((r) => String(r.project));
}

function countMap(rows: Record<string, unknown>[], key: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r[key])] = Number(r.n);
    return out;
}

/** Aggregate counts for the status surfaces. */
export function recallStats(db: RecallDb = openDb()): RecallStats {
    const one = (sql: string): number => Number(db.query(sql).get()?.n ?? 0);
    return {
        observations: one("SELECT COUNT(*) AS n FROM observations"),
        summaries: one("SELECT COUNT(*) AS n FROM summaries"),
        sessions: one("SELECT COUNT(*) AS n FROM sessions"),
        projects: one("SELECT COUNT(DISTINCT project) AS n FROM observations"),
        bySource: countMap(db.query("SELECT source, COUNT(*) AS n FROM observations GROUP BY source").all(), "source"),
        byType: countMap(db.query("SELECT type, COUNT(*) AS n FROM observations GROUP BY type ORDER BY n DESC").all(), "type"),
        byProject: countMap(db.query("SELECT project, COUNT(*) AS n FROM observations GROUP BY project ORDER BY n DESC LIMIT 50").all(), "project"),
        lastObservationAt: Number(db.query("SELECT MAX(created_at) AS n FROM observations").get()?.n ?? 0),
        dbBytes: 0,
    };
}

/** Session ids that still have un-enriched observations, newest activity first (LLM enrich queue). */
export function sessionsNeedingEnrichment(limit: number, db: RecallDb = openDb()): string[] {
    const rows = db.query(
        "SELECT session_id, MAX(created_at) AS t FROM observations WHERE enriched = 0 GROUP BY session_id ORDER BY t DESC LIMIT ?",
    ).all(Math.max(1, limit));
    return rows.map((r) => String(r.session_id));
}

/** All observations of a session, in turn order (for enrichment). */
export function observationsOfSession(sessionId: string, db: RecallDb = openDb()): ObservationHit[] {
    const rows = db.query("SELECT * FROM observations WHERE session_id = ? ORDER BY prompt_number, created_at").all(sessionId);
    return rows.map(rowToObservation);
}

/** Apply LLM enrichment to one observation: overwrite the chosen fields, re-embed, mark enriched. */
export function applyEnrichment(id: number, fields: { type?: string; title?: string; narrative?: string; facts?: string[]; concepts?: string[]; }, db: RecallDb = openDb(), embed: EmbeddingProvider = localEmbed): void {
    const cur = getObservations([id], db)[0];
    if (!cur) return;
    const merged: Observation = {
        ...cur,
        type: (fields.type as Observation["type"]) || cur.type,
        title: fields.title || cur.title,
        narrative: fields.narrative ?? cur.narrative,
        facts: fields.facts && fields.facts.length ? fields.facts : cur.facts,
        concepts: fields.concepts && fields.concepts.length ? fields.concepts : cur.concepts,
    };
    // The rewrite changes what the fact says, so its dedupe key follows.
    db.run(
        "UPDATE observations SET type = ?, title = ?, narrative = ?, facts = ?, concepts = ?, norm_hash = ?, enriched = 1 WHERE id = ?",
        merged.type, merged.title, merged.narrative ?? null, JSON.stringify(merged.facts), JSON.stringify(merged.concepts), normKey(merged), id,
    );
    upsertVector(id, embed(observationText(merged)), db);
}

/** Mark every observation of a session as enriched (so a processed session leaves the queue). */
export function markSessionEnriched(sessionId: string, db: RecallDb = openDb()): void {
    db.run("UPDATE observations SET enriched = 1 WHERE session_id = ?", sessionId);
}

/** Delete one observation (the FTS row and vector follow via trigger/cascade). */
export function deleteObservation(id: number, db: RecallDb = openDb()): void {
    db.run("DELETE FROM observations WHERE id = ?", id);
}

/**
 * Vector-only ranking for one or more queries: cosine of each query embedding against the
 * candidate vectors, which are loaded ONCE for all queries. Returns one ranked list per query.
 */
function vectorSearch(queries: string[], opts: QueryOptions, limit: number, db: RecallDb): { id: number; score: number; }[][] {
    const f = filterClause(opts, "o.");
    const rows = db.query(
        `SELECT v.observation_id AS id, v.vec AS vec
         FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
         WHERE 1=1${f.sql}`,
    ).all(...f.params);
    const vecs = rows.map((r) => ({ id: Number(r.id), vec: unpackVector(r.vec as Uint8Array) }));
    // Drop near-orthogonal vectors: feature-hash collisions give unrelated text a tiny non-zero
    // cosine, and without a floor every candidate would leak into a filtered hybrid search.
    const MIN_COSINE = 0.12;
    return queries.map((q) => {
        const qv = localEmbed(q);
        const scored = vecs.map((v) => ({ id: v.id, score: cosine(qv, v.vec) })).filter((s) => s.score >= MIN_COSINE);
        scored.sort((a, b) => b.score - a.score || b.id - a.id);
        return scored.slice(0, limit);
    });
}

/**
 * Ranking adjustments applied on top of the fused RRF score. Both are bounded so relevance
 * still dominates: the combined factor stays within [RECENCY_FLOOR, 1 + REINFORCE_CAP] =
 * [0.8, 1.3], enough to reorder near-ties but not to lift an irrelevant row over a match.
 *  - recency: the score keeps RECENCY_FLOOR and the rest halves every RECENCY_HALF_LIFE_DAYS,
 *    so a month-old memory loses 10% and nothing ever loses more than 20%;
 *  - reinforcement: + REINFORCE_WEIGHT * ln(source_count), capped at REINFORCE_CAP, so a fact
 *    learned in 2 sessions gains ~7% and one learned in 20+ sessions the full 30%.
 * Pure arithmetic over stored columns and an explicit `now`: the same inputs give the same order.
 */
const RECENCY_FLOOR = 0.8;
const RECENCY_HALF_LIFE_DAYS = 30;
const REINFORCE_WEIGHT = 0.1;
const REINFORCE_CAP = 0.3;
/** Most query phrasings fused per search; more adds scan cost without adding recall. */
export const MAX_QUERIES = 5;

/** The multiplicative recency x reinforcement factor for one observation. */
export function rankFactor(createdAt: number, sourceCount: number, now: number): number {
    const ageDays = Math.max(0, (now - createdAt) / 86400000);
    const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    const reinforce = 1 + Math.min(REINFORCE_CAP, REINFORCE_WEIGHT * Math.log(Math.max(1, sourceCount)));
    return recency * reinforce;
}

/**
 * Hybrid search: fuse the FTS (bm25 keyword) ranking and the vector (cosine) ranking of every
 * query with Reciprocal Rank Fusion, so a result strong in any signal or any phrasing surfaces,
 * then apply the bounded recency/reinforcement factor. `query` may be several agent-rewritten
 * phrasings of one need (deduped, capped at MAX_QUERIES). Latest, unforgotten rows only unless
 * the options say otherwise. Falls back to recent when no query has a usable token.
 */
export function hybridSearch(query: string | string[], opts: SearchOptions = {}, db: RecallDb = openDb()): ObservationHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const phrasings = (Array.isArray(query) ? query : [query]).map((q) => String(q ?? "").trim()).filter((q) => ftsMatch(q));
    const queries = [...new Set(phrasings)].slice(0, MAX_QUERIES);
    if (!queries.length) return recentObservations(opts, db);
    const pool = 50;
    const k = 60; // RRF damping constant
    const score = new Map<number, number>();
    const add = (id: number, i: number): void => { score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)); };
    for (const q of queries) searchObservations(q, { ...opts, limit: pool }, db).forEach((o, i) => { if (o.id) add(o.id, i); });
    for (const list of vectorSearch(queries, opts, pool, db)) list.forEach((v, i) => add(v.id, i));
    if (!score.size) return [];
    const ids = [...score.keys()];
    const meta = new Map(db.query(`SELECT id, created_at, source_count FROM observations WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids)
        .map((r) => [Number(r.id), rankFactor(Number(r.created_at), Number(r.source_count ?? 1), opts.now ?? Date.now())]));
    const ranked = ids.map((id) => ({ id, s: score.get(id)! * (meta.get(id) ?? 1) }));
    ranked.sort((a, b) => b.s - a.s || b.id - a.id);
    const top = ranked.slice(0, limit).map((e) => e.id);
    const byId = new Map(getObservations(top, db).map((o) => [o.id!, o as ObservationHit]));
    return top.map((id) => byId.get(id)).filter((o): o is ObservationHit => Boolean(o));
}

/**
 * Chronological context around an observation (the 3-layer search -> timeline step): the
 * observations just before and after the anchor in the same project, oldest-to-newest.
 */
export function timelineAround(opts: { id?: number; project?: string; before?: number; after?: number; includeForgotten?: boolean; }, db: RecallDb = openDb()): ObservationHit[] {
    const before = Math.max(0, Math.min(opts.before ?? 6, 50));
    const after = Math.max(0, Math.min(opts.after ?? 6, 50));
    let project = opts.project;
    let anchor = Date.now();
    if (opts.id) {
        const row = db.query("SELECT project, created_at FROM observations WHERE id = ?").get(opts.id);
        if (row) { project = String(row.project); anchor = Number(row.created_at); }
    }
    // Superseded rows stay in the timeline - history is what it is for; forgotten rows do not,
    // unless asked.
    const proj = (project ? " AND project = ?" : "") + (opts.includeForgotten ? "" : " AND forgotten_at IS NULL");
    const projArgs = project ? [project] : [];
    const prev = db.query(`SELECT * FROM observations WHERE created_at <= ?${proj} ORDER BY created_at DESC LIMIT ?`).all(anchor, ...projArgs, before + 1);
    const next = db.query(`SELECT * FROM observations WHERE created_at > ?${proj} ORDER BY created_at ASC LIMIT ?`).all(anchor, ...projArgs, after);
    return [...prev.reverse(), ...next].map(rowToObservation);
}

/** Which of the given ids exist (forget only accepts real ids). */
export function existingIds(ids: number[], db: RecallDb = openDb()): number[] {
    if (!ids.length) return [];
    return db.query(`SELECT id FROM observations WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids).map((r) => Number(r.id));
}

/** What a soft forget did. */
export interface ForgetOutcome {
    forgotten: number[];
    alreadyForgotten: number[];
    /** Older versions that became latest again because the row replacing them was forgotten. */
    restored: number[];
}

/**
 * Soft-forget observations: stamp forgotten_at + forget_reason so search, timeline and context
 * skip them, without deleting (the hard-delete paths - dashboard delete, prune, clear - are
 * unchanged). A forgotten row that had replaced older versions releases them: forgetting says
 * "this is not true", so the version it hid is the best remaining knowledge again.
 */
export function forgetObservations(ids: number[], reason: string, now: number = Date.now(), db: RecallDb = openDb()): ForgetOutcome {
    return db.transaction((): ForgetOutcome => {
        const rows = ids.length ? db.query(`SELECT id, forgotten_at FROM observations WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
        const alreadyForgotten = rows.filter((r) => r.forgotten_at != null).map((r) => Number(r.id));
        const forgotten = rows.filter((r) => r.forgotten_at == null).map((r) => Number(r.id));
        for (const id of forgotten) db.run("UPDATE observations SET forgotten_at = ?, forget_reason = ? WHERE id = ?", now, reason, id);
        const restored: number[] = [];
        for (const id of forgotten) {
            const prev = db.query("SELECT id FROM observations WHERE superseded_by = ? AND forgotten_at IS NULL").all(id).map((r) => Number(r.id));
            if (prev.length) db.run("UPDATE observations SET superseded_by = NULL WHERE superseded_by = ? AND forgotten_at IS NULL", id);
            restored.push(...prev);
        }
        return { forgotten, alreadyForgotten, restored };
    })();
}

/** One session row for the sessions list. */
export interface SessionRow extends RecallSession { observations: number; }

/** Recent sessions (newest first) with their observation counts. */
export function listSessions(opts: { project?: string; source?: string; limit?: number; } = {}, db: RecallDb = openDb()): SessionRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
    const parts: string[] = [];
    const params: unknown[] = [];
    if (opts.project) { parts.push("project = ?"); params.push(opts.project); }
    if (opts.source) { parts.push("source = ?"); params.push(opts.source); }
    const where = parts.length ? ` AND ${parts.join(" AND ")}` : "";
    const rows = db.query(
        `SELECT s.*, (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.session_id) AS observations
         FROM sessions s WHERE 1=1${where} ORDER BY ended_at DESC LIMIT ?`,
    ).all(...params, limit);
    return rows.map((r) => ({
        sessionId: String(r.session_id), project: String(r.project), source: String(r.source) as RecallSession["source"],
        title: str(r.title), userPrompt: str(r.user_prompt), startedAt: Number(r.started_at), endedAt: Number(r.ended_at),
        observations: Number(r.observations),
    }));
}

/**
 * Bound the store for long-term use ("endless"-style retention): drop observations older than
 * maxAgeDays and/or all but the newest maxRows. FTS rows go via the delete trigger, vectors via
 * FK cascade. Returns the number of observations deleted.
 */
export function prune(opts: { maxAgeDays?: number; maxRows?: number; }, db: RecallDb = openDb()): number {
    // Count the diff rather than trust .changes: the FTS delete trigger and the vector FK
    // cascade inflate the reported change count.
    const count = (): number => Number(db.query("SELECT COUNT(*) AS n FROM observations").get()?.n ?? 0);
    const before = count();
    if (opts.maxAgeDays && opts.maxAgeDays > 0) {
        const cutoff = Date.now() - opts.maxAgeDays * 86400000;
        db.run("DELETE FROM observations WHERE created_at < ?", cutoff);
        db.run("DELETE FROM summaries WHERE created_at < ?", cutoff);
    }
    if (opts.maxRows && opts.maxRows > 0) {
        db.run("DELETE FROM observations WHERE id NOT IN (SELECT id FROM observations ORDER BY created_at DESC LIMIT ?)", opts.maxRows);
    }
    return before - count();
}

/** Delete all recall data (keeps the schema). */
export function clearRecall(db: RecallDb = openDb()): void {
    db.exec("DELETE FROM observation_vectors; DELETE FROM observation_sources; DELETE FROM observations; DELETE FROM summaries; DELETE FROM sessions; INSERT INTO observations_fts(observations_fts) VALUES('rebuild');");
}
