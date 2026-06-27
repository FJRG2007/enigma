/**
 * Recall storage: a local SQLite database (Bun's built-in `bun:sqlite`, so it bundles into
 * the compiled binary with zero runtime dependencies) under ~/.enigma/recall/recall.db.
 *
 * bun:sqlite is only available under Bun (the compiled binary, `npm run dev`, and `bun test`)
 * - never under the tsx/Node dev path. So it is loaded via require() inside openDb(), behind
 * a clear error, rather than a top-level import that would crash module load under Node. The
 * Database/Statement surface we use is typed by a minimal local interface (the project's
 * tsconfig pulls in node types only, not bun types).
 *
 * Identifier note: rows use INTEGER PRIMARY KEYs rather than the UUIDs the database policy
 * prefers. This is a deliberate, scoped deviation - the store is a single-user, local,
 * loopback-only file with no external ID exposure or multi-tenant boundary (the IDOR/
 * enumeration/sharding rationale for UUIDs does not apply), the FTS5 external-content index
 * requires an integer rowid, and short ids are the citation UX (recall #42).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, statSync } from "node:fs";

/** A prepared statement - the slice of bun:sqlite's Statement we use. */
export interface RecallStatement {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | null;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

/** A database handle - the slice of bun:sqlite's Database we use. */
export interface RecallDb {
    exec(sql: string): void;
    query(sql: string): RecallStatement;
    run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
    close(): void;
}

/** Thrown when a recall operation runs outside Bun (no bun:sqlite). */
export class RecallUnavailableError extends Error {
    constructor() {
        super("recall needs the enigma binary (bun:sqlite is unavailable under Node)");
        this.name = "RecallUnavailableError";
    }
}

/** Recall's data directory; ENIGMA_RECALL_DIR overrides it (used by tests). */
export function recallDir(): string {
    return process.env.ENIGMA_RECALL_DIR || join(homedir(), ".enigma", "recall");
}

export function recallDbPath(): string {
    return join(recallDir(), "recall.db");
}

/** Size of the database file in bytes, 0 when it does not exist yet. */
export function recallDbBytes(): number {
    try { return statSync(recallDbPath()).size; } catch { return 0; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    UNIQUE NOT NULL,
  project     TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'claude',
  title       TEXT,
  user_prompt TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_source  ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT    NOT NULL,
  project        TEXT    NOT NULL,
  source         TEXT    NOT NULL DEFAULT 'claude',
  type           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  subtitle       TEXT,
  narrative      TEXT,
  facts          TEXT,
  concepts       TEXT,
  files_read     TEXT,
  files_modified TEXT,
  prompt_number  INTEGER,
  content_hash   TEXT    NOT NULL,
  enriched       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE(session_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_source  ON observations(source);
CREATE INDEX IF NOT EXISTS idx_obs_type    ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    UNIQUE NOT NULL,
  project      TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'claude',
  request      TEXT,
  learned      TEXT,
  completed    TEXT,
  next_steps   TEXT,
  files_edited TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_project ON summaries(project);

-- One dense vector per observation for the vector half of hybrid search. Deleted by cascade
-- when its observation is removed (foreign_keys is ON).
CREATE TABLE IF NOT EXISTS observation_vectors (
  observation_id INTEGER PRIMARY KEY,
  vec            BLOB    NOT NULL,
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, facts, concepts,
  content='observations', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;
`;

let cached: RecallDb | null = null;

/**
 * Open (and on first use, create) the recall database. The handle is cached for the process.
 * Throws RecallUnavailableError outside Bun so callers can degrade gracefully (the CLI prints
 * a hint; the dashboard/MCP return empty).
 */
export function openDb(): RecallDb {
    if (cached) return cached;
    let Database: new (path: string) => RecallDb;
    try {
        // Lazy require: bun:sqlite only exists under Bun; a top-level import would crash Node.
        ({ Database } = require("bun:sqlite") as { Database: new (path: string) => RecallDb });
    } catch {
        throw new RecallUnavailableError();
    }
    const dir = recallDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(recallDbPath());
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    // Idempotent migration for dev databases created before the column existed (CREATE TABLE
    // IF NOT EXISTS never alters an existing table). The duplicate-column error is expected.
    try { db.exec("ALTER TABLE observations ADD COLUMN enriched INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
    cached = db;
    return db;
}

/** Whether recall can run here (Bun present). Lets surfaces hide gracefully under Node. */
export function recallAvailable(): boolean {
    try { require("bun:sqlite"); return true; } catch { return false; }
}

/** Close and forget the cached handle (used by tests to reopen a fresh database). */
export function closeDb(): void {
    if (cached) { try { cached.close(); } catch { /* already closed */ } cached = null; }
}
