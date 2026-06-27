/**
 * Shared types for recall: enigma's session-memory store. A "session" is one coding-agent
 * conversation; "observations" are the durable, structured discoveries extracted from it
 * (one per user turn) and a "summary" is the session's request/outcome. Kept separate from
 * the agent-memory editor (CLAUDE.md/AGENTS.md), which is unrelated instruction content.
 */

/** Which coding agent a memory came from. Used to scope retrieval so sources do not bleed. */
export type RecallSource = "claude" | "codex" | "opencode";

/**
 * Observation categories: a small, durable taxonomy of what a coding turn did. The two
 * security variants collapse into one "security". Deterministic extraction infers the type
 * from a turn's activity (edits -> change/feature, reads-only -> discovery, etc.).
 */
export const OBSERVATION_TYPES = ["bugfix", "feature", "refactor", "change", "discovery", "decision", "security"] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** One coding-agent session observed by recall (one transcript file). */
export interface RecallSession {
    sessionId: string;
    project: string;
    source: RecallSource;
    title?: string;
    userPrompt?: string;
    /** epoch ms of the first message. */
    startedAt: number;
    /** epoch ms of the last message. */
    endedAt: number;
}

/** One structured memory row extracted from a session turn. */
export interface Observation {
    id?: number;
    sessionId: string;
    project: string;
    source: RecallSource;
    type: ObservationType;
    title: string;
    subtitle?: string;
    narrative?: string;
    facts: string[];
    concepts: string[];
    filesRead: string[];
    filesModified: string[];
    promptNumber?: number;
    /** Stable hash of the turn's content; UNIQUE(session_id, content_hash) dedupes re-syncs. */
    contentHash: string;
    /** epoch ms. */
    createdAt: number;
}

/** One per-session summary (request and outcome), one row per session. */
export interface SessionSummary {
    id?: number;
    sessionId: string;
    project: string;
    source: RecallSource;
    request?: string;
    learned?: string;
    completed?: string;
    nextSteps?: string;
    filesEdited: string[];
    /** epoch ms. */
    createdAt: number;
}

/** A search/recent hit: an observation plus its FTS relevance (lower bm25 = better). */
export interface ObservationHit extends Observation {
    rank?: number;
}

/** Aggregate counts for the CLI/TUI/dashboard status surfaces. */
export interface RecallStats {
    observations: number;
    summaries: number;
    sessions: number;
    projects: number;
    bySource: Record<string, number>;
    byType: Record<string, number>;
    byProject: Record<string, number>;
    /** epoch ms of the newest observation, 0 when empty. */
    lastObservationAt: number;
    /** Database file size in bytes. */
    dbBytes: number;
}
