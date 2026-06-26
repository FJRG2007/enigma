/**
 * Faithful port of no-mistakes' `internal/intent/reader.go`: the transcript
 * Role/Message/Session/DiscoverOpts shapes and the Reader interface implemented
 * by each per-agent reader.
 *
 * Go's `time.Time` is modeled as JS `Date`; Go's zero-value time (`IsZero()`)
 * is modeled as `ZERO_TIME` (epoch 0). Every code path that arithmetically
 * uses a possibly-zero time guards it with `isZeroTime` first, exactly as the
 * Go original does, so the epoch-0 sentinel is behaviorally faithful.
 */

/** Sentinel for Go's zero-value `time.Time`. */
export const ZERO_TIME = new Date(0);

/** Reports whether `t` is the zero-value time (Go's `time.Time.IsZero`). */
export function isZeroTime(t: Date): boolean {
    return t.getTime() === 0;
}

/**
 * Parses an RFC3339 / RFC3339Nano timestamp, returning ZERO_TIME on empty or
 * unparseable input - matching Go's `t, _ := time.Parse(...)` zero-on-error.
 */
export function parseRFC3339(raw: string): Date {
    if (raw === "") return ZERO_TIME;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return ZERO_TIME;
    return new Date(ms);
}

/**
 * Formats a time as UTC RFC3339 (Go's `t.UTC().Format("2006-01-02T15:04:05Z07:00")`).
 * Sub-second precision is dropped to match the second-granular Go layout.
 */
export function formatRFC3339UTC(t: Date): string {
    return t.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Identifies who produced a transcript message. */
export type Role = "user" | "assistant";

export const RoleUser: Role = "user";
export const RoleAssistant: Role = "assistant";

/**
 * Message is a single user or assistant turn extracted from an agent transcript.
 * Tool calls and tool results are deliberately excluded from `text`. `filePaths`
 * is a best-effort list of file paths the agent referenced via tool inputs or
 * quoted in assistant text - used purely for matching, not for the summary.
 */
export interface Message {
    role: Role;
    text?: string;
    filePaths?: string[];
    timestamp?: Date;
    /**
     * Synthetic marks a message that was inserted by no-mistakes itself (e.g. a
     * "middle messages omitted" notice from clampMessages). The transcript
     * serializer renders these without a role prefix so the downstream LLM does
     * not mistake them for user or assistant turns.
     */
    synthetic?: boolean;
}

/** Session is one transcript candidate from one agent. */
export interface Session {
    agentName: string;
    sessionId: string;
    cwd: string;
    startedAt: Date;
    lastActivity: Date;
    /**
     * LastMsgKey is a per-reader stable identifier for the last message (uuid
     * where available, otherwise a timestamp). Used as the cache key input so
     * repeat extractions on an unchanged session hit the cache.
     */
    lastMsgKey: string;
    /**
     * Messages holds the user/assistant turns. Populated by Reader.load, not by
     * discover, since most candidates will be filtered out.
     */
    messages: Message[];
    /**
     * startedAtPath is a reader-private handle that points to the underlying
     * transcript (a .jsonl file path, a SQLite db path, a session dir, etc.).
     * The load implementation is the only consumer.
     */
    startedAtPath?: string;
}

/**
 * DiscoverOpts narrows the search down to relevant sessions before any
 * expensive body parsing happens.
 */
export interface DiscoverOpts {
    /** Overrides the user's home directory. Empty means use os.homedir. */
    homeDir: string;
    /**
     * The user's actual repo directory (NOT the worktree the pipeline runs in).
     * Symlinks should already be resolved by the caller.
     */
    originCwd: string;
    /** WindowStart is the earliest LastActivity allowed (inclusive). */
    windowStart: Date;
    /** WindowEnd is the latest StartedAt allowed (inclusive). */
    windowEnd: Date;
}

/** Reader is implemented by per-agent transcript readers. */
export interface Reader {
    name(): string;
    /**
     * Discover returns candidate sessions matching opts. Implementations must
     * only read enough of each transcript to populate metadata; full message
     * bodies must wait until load is called.
     */
    discover(opts: DiscoverOpts, signal?: AbortSignal): Promise<Session[]>;
    /**
     * Load populates s.messages with user/assistant text only. Tool calls and
     * tool results must be omitted from Message.text but file paths they
     * reference may be added to Message.filePaths.
     */
    load(s: Session, signal?: AbortSignal): Promise<void>;
}
