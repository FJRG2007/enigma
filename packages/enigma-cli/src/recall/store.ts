/**
 * Recall data access: typed reads and writes over the SQLite store. All queries are
 * parameterized (never string-concatenated) and JSON-array columns are (de)serialized here
 * so callers work with plain string arrays.
 */

import { openDb, type RecallDb } from "./db";
import { localEmbed, cosine, packVector, unpackVector, type EmbeddingProvider } from "./embed";
import type { Observation, ObservationHit, RecallSession, RecallStats, SessionSummary } from "./types";

/** Options shared by search/recent/list reads. */
export interface QueryOptions {
    project?: string;
    source?: string;
    type?: string;
    limit?: number;
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

/**
 * Insert an observation, ignoring duplicates (UNIQUE session_id+content_hash). Returns true
 * when stored. On a real insert it also stores the observation's embedding (pass embed=null to
 * skip, e.g. for a bulk import that backfills vectors afterwards).
 */
export function insertObservation(o: Observation, db: RecallDb = openDb(), embed: EmbeddingProvider | null = localEmbed): boolean {
    const res = db.run(
        `INSERT OR IGNORE INTO observations
           (session_id, project, source, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, prompt_number, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        o.sessionId, o.project, o.source, o.type, o.title, o.subtitle ?? null, o.narrative ?? null,
        JSON.stringify(o.facts), JSON.stringify(o.concepts), JSON.stringify(o.filesRead), JSON.stringify(o.filesModified),
        o.promptNumber ?? null, o.contentHash, o.createdAt,
    );
    if (res.changes > 0 && embed) upsertVector(Number(res.lastInsertRowid), embed(observationText(o)), db);
    return res.changes > 0;
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

/** Build a `column = ?` filter clause + params from the common options. */
function filterClause(opts: QueryOptions, prefix: string): { sql: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
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
    const f = filterClause(opts, "");
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
export function applyEnrichment(id: number, fields: { type?: string; title?: string; narrative?: string; facts?: string[]; concepts?: string[] }, db: RecallDb = openDb(), embed: EmbeddingProvider = localEmbed): void {
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
    db.run(
        "UPDATE observations SET type = ?, title = ?, narrative = ?, facts = ?, concepts = ?, enriched = 1 WHERE id = ?",
        merged.type, merged.title, merged.narrative ?? null, JSON.stringify(merged.facts), JSON.stringify(merged.concepts), id,
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

/** Vector-only ranking: cosine of the query embedding against candidate observation vectors. */
function vectorSearch(query: string, opts: QueryOptions, limit: number, db: RecallDb): { id: number; score: number }[] {
    const qv = localEmbed(query);
    const f = filterClause(opts, "o.");
    const rows = db.query(
        `SELECT v.observation_id AS id, v.vec AS vec
         FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
         WHERE 1=1${f.sql}`,
    ).all(...f.params);
    // Drop near-orthogonal vectors: feature-hash collisions give unrelated text a tiny non-zero
    // cosine, and without a floor every candidate would leak into a filtered hybrid search.
    const MIN_COSINE = 0.12;
    const scored = rows
        .map((r) => ({ id: Number(r.id), score: cosine(qv, unpackVector(r.vec as Uint8Array)) }))
        .filter((s) => s.score >= MIN_COSINE);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

/**
 * Hybrid search: fuse the FTS (bm25 keyword) ranking and the vector (cosine) ranking with
 * Reciprocal Rank Fusion, so a result strong in either signal surfaces. Falls back to recent
 * for a token-less query. This is what recall searches with by default.
 */
export function hybridSearch(query: string, opts: QueryOptions = {}, db: RecallDb = openDb()): ObservationHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    if (!ftsMatch(query || "")) return recentObservations(opts, db);
    const pool = 50;
    const ftsHits = searchObservations(query, { ...opts, limit: pool }, db);
    const vecHits = vectorSearch(query, opts, pool, db);
    const k = 60; // RRF damping constant
    const score = new Map<number, number>();
    ftsHits.forEach((o, i) => { if (o.id) score.set(o.id, (score.get(o.id) ?? 0) + 1 / (k + i + 1)); });
    vecHits.forEach((v, i) => { score.set(v.id, (score.get(v.id) ?? 0) + 1 / (k + i + 1)); });
    const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
    if (!ids.length) return [];
    const byId = new Map(getObservations(ids, db).map((o) => [o.id!, o as ObservationHit]));
    return ids.map((id) => byId.get(id)).filter((o): o is ObservationHit => Boolean(o));
}

/**
 * Chronological context around an observation (the 3-layer search -> timeline step): the
 * observations just before and after the anchor in the same project, oldest-to-newest.
 */
export function timelineAround(opts: { id?: number; project?: string; before?: number; after?: number }, db: RecallDb = openDb()): ObservationHit[] {
    const before = Math.max(0, Math.min(opts.before ?? 6, 50));
    const after = Math.max(0, Math.min(opts.after ?? 6, 50));
    let project = opts.project;
    let anchor = Date.now();
    if (opts.id) {
        const row = db.query("SELECT project, created_at FROM observations WHERE id = ?").get(opts.id);
        if (row) { project = String(row.project); anchor = Number(row.created_at); }
    }
    const proj = project ? " AND project = ?" : "";
    const projArgs = project ? [project] : [];
    const prev = db.query(`SELECT * FROM observations WHERE created_at <= ?${proj} ORDER BY created_at DESC LIMIT ?`).all(anchor, ...projArgs, before + 1);
    const next = db.query(`SELECT * FROM observations WHERE created_at > ?${proj} ORDER BY created_at ASC LIMIT ?`).all(anchor, ...projArgs, after);
    return [...prev.reverse(), ...next].map(rowToObservation);
}

/** One session row for the sessions list. */
export interface SessionRow extends RecallSession { observations: number; }

/** Recent sessions (newest first) with their observation counts. */
export function listSessions(opts: { project?: string; source?: string; limit?: number } = {}, db: RecallDb = openDb()): SessionRow[] {
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
export function prune(opts: { maxAgeDays?: number; maxRows?: number }, db: RecallDb = openDb()): number {
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
    db.exec("DELETE FROM observation_vectors; DELETE FROM observations; DELETE FROM summaries; DELETE FROM sessions; INSERT INTO observations_fts(observations_fts) VALUES('rebuild');");
}
