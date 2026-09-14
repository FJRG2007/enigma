/**
 * Warm session runtime for the local API server (Claude Code only, for now).
 *
 * The default API path spawns a fresh headless Claude Code per request: correct and fully
 * isolated, but every request pays a cold boot (see local-api-server.md). When a caller opts into
 * a session by sending a `session_id`, this runtime keeps ONE long-lived `claude` process per
 * session and feeds each turn to it over stream-json stdin, so only the first turn pays the boot
 * and the rest reuse the warm process - the model of AWS Bedrock AgentCore (a dedicated compute
 * per session, evicted when idle) and OpenAI's stateful Responses API (the server holds the
 * thread; the client sends only the new turn).
 *
 * Isolation is preserved because reuse is scoped to an explicit session id: one process serves
 * one conversation, never two. Turns of the same session are serialized (a conversation is
 * sequential); different sessions run in parallel. An idle session's process is evicted to free
 * memory, and its state survives on disk - Claude Code persists every session transcript, so the
 * next turn respawns with `--resume <id>` and continues where it left off. A hard cap bounds how
 * many processes can be live at once (LRU eviction), so the runtime never grows without limit.
 *
 * Detectability is unchanged from the per-request path: this is the real Claude Code CLI with the
 * account's own login, driven through its documented `--input-format stream-json` interface. A
 * warm session is exactly a normal multi-turn conversation as far as the backend is concerned.
 */

import { readConfig } from "./config";
import { spawn, type ChildProcess } from "node:child_process";
import { parseClaudeLine, resolveClaudeModel, DEFAULT_MODEL, estimateTokens, type ImageBlock } from "./api-agents";

/** One turn's normalized outcome, matching the api-server's RunResult shape. */
export interface SessionTurnResult {
    text: string;
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    isError: boolean;
    errorMessage?: string;
}

/** Why a turn could not run. The caller maps the code to an HTTP status, never the message text. */
export type SessionErrorCode = "busy" | "context-mismatch" | "timeout";

/** A refusal the caller can classify, so the HTTP layer never has to match on a message prefix. */
export class SessionError extends Error {
    constructor(public code: SessionErrorCode, message: string) { super(message); }
}

/** One turn's input: the newest user message, plus any images it carries. */
export interface SessionTurn {
    prompt: string;
    images?: ImageBlock[];
}

/** How to launch a session's Claude Code process. Built by the caller from the request context. */
export interface SessionSpec {
    binary: string;
    env: NodeJS.ProcessEnv;
    /** Requested model id (resolved to a real Claude id, else the default). */
    model?: string | null;
    /** System prompt, fixed for the life of the session (a conversation has one system prompt). */
    system?: string | null;
    /**
     * Tools requested for this session. Decides the permission posture AND whether the user's MCP
     * servers load, exactly as the stateless adapter's build() does - one flag so the two paths
     * cannot drift apart.
     */
    enableTools: boolean;
    /**
     * Identity of the isolation context (the resolved config dir). A session id is bound to the
     * first context that ran it, so a later turn naming a different account/profile/pack is
     * refused rather than silently answered from - or worse, resumed into - the wrong context.
     */
    contextKey: string;
    /** Windows needs shell invocation for a non-.exe launcher; mirrors runAgent. */
    useShell: boolean;
}

/** Runtime bounds. Small, overridable from config. */
export interface SessionRuntimeConfig {
    /** Evict a session whose process has been idle at least this long (ms). */
    idleTtlMs: number;
    /** Maximum live session processes; the least-recently-used is evicted past this. */
    maxSessions: number;
    /**
     * Give up on a turn that has produced no `result` line in this long (ms). Without it a wedged
     * process (a permission prompt nothing can answer, a hung tool call, a dead network) would pin
     * the session busy forever and every later turn on that id would 409 until the server restarts.
     */
    turnTimeoutMs: number;
}

export const DEFAULT_SESSION_CONFIG: SessionRuntimeConfig = { idleTtlMs: 15 * 60 * 1000, maxSessions: 8, turnTimeoutMs: 10 * 60 * 1000 };

/** Keep only the tail of a session's stderr: it lives for hours and is only read as a death reason. */
const STDERR_CAP = 64 * 1024;

/** How many past session ids to remember for the resume/context decision. */
const KNOWN_CAP = 1024;

interface WarmSession {
    id: string;
    child: ChildProcess;
    /** Unparsed stdout carry-over between chunks. */
    buf: string;
    lastUsed: number;
    /** A turn is in flight; the next turn on this session must wait (serialized). */
    busy: boolean;
    /** The in-flight turn's line consumer, or null between turns. */
    onLine: ((line: string) => void) | null;
    /** Resolved once the process exits, so a mid-turn death rejects the waiting turn. */
    onExit: ((reason: string) => void) | null;
    stderr: string;
}

const SESSIONS = new Map<string, WarmSession>();

/**
 * Every session id this server has spawned at least once, mapped to its context key.
 *
 * Two decisions need to outlive the process: a spawned id owns a transcript on disk, so a respawn
 * must `--resume` it instead of claiming the id again (`--session-id` on a used id starts fresh or
 * is rejected), and that transcript belongs to ONE isolation context. Both survive eviction, which
 * is exactly when the live map has forgotten the session. Bounded, oldest id dropped first.
 */
const KNOWN = new Map<string, string>();

function remember(sessionId: string, contextKey: string): void {
    KNOWN.delete(sessionId);
    KNOWN.set(sessionId, contextKey);
    if (KNOWN.size <= KNOWN_CAP) return;
    const oldest = KNOWN.keys().next();
    if (!oldest.done) KNOWN.delete(oldest.value);
}

/** Windows arg quoting for the shell path (mirrors api-server/accounts). */
function quoteWinArg(arg: string): string {
    if (arg === "") return "\"\"";
    if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\"\"")}"`;
}

/** Build the persistent-mode Claude Code args. `resume` rehydrates an evicted session by id. */
function sessionArgs(spec: SessionSpec, sessionId: string, resume: boolean): string[] {
    const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        // Token-by-token streaming for streamed turns; non-streamed turns just accumulate the deltas.
        "--include-partial-messages",
    ];
    const model = resolveClaudeModel(spec.model);
    args.push("--model", model && model !== "claude" ? model : DEFAULT_MODEL);
    if (spec.system) args.push("--append-system-prompt", spec.system);
    // Same posture as the stateless adapter: with tools on, honor the global permission-bypass so a
    // headless turn never stalls on a prompt nobody can answer - this stdin is the turn channel, and
    // a blocked session would never emit its `result` line. Off = the default posture, no bypass.
    const bypass = readConfig().config.permissionBypass;
    args.push("--permission-mode", spec.enableTools && bypass ? "bypassPermissions" : "default");
    if (!spec.enableTools) args.push("--strict-mcp-config");
    // A brand-new session sets its own id so the client's chosen id IS the Claude session id; an
    // evicted one is resumed by that same id, continuing the persisted transcript.
    if (resume) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    return args;
}

/** Spawn a session's process and wire its single, long-lived stdout/stderr readers. */
function spawnSession(spec: SessionSpec, sessionId: string, resume: boolean): WarmSession {
    const args = sessionArgs(spec, sessionId, resume);
    const child = spec.useShell
        ? spawn([spec.binary, ...args].map(quoteWinArg).join(" "), { env: spec.env, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
        : spawn(spec.binary, args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    const s: WarmSession = { id: sessionId, child, buf: "", lastUsed: Date.now(), busy: false, onLine: null, onExit: null, stderr: "" };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        s.buf += chunk;
        let nl: number;
        while ((nl = s.buf.indexOf("\n")) !== -1) {
            const line = s.buf.slice(0, nl);
            s.buf = s.buf.slice(nl + 1);
            if (s.onLine) s.onLine(line);
        }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { s.stderr = (s.stderr + chunk).slice(-STDERR_CAP); });
    // A turn written to a process that died between turns raises EPIPE asynchronously here; with no
    // listener Node would take the whole API server down. The death is reported by the exit path.
    child.stdin.on("error", () => { /* reported through the session's exit */ });

    const die = (reason: string): void => {
        // Only if the map still holds THIS child: an evicted session's close fires after its entry
        // was replaced, and deleting then would orphan the live successor's process.
        if (SESSIONS.get(sessionId) === s) SESSIONS.delete(sessionId);
        const notify = s.onExit;
        s.onExit = null; s.onLine = null;
        if (notify) notify(reason);
    };
    child.on("error", (err) => die(err.message));
    child.on("close", (code) => die(s.stderr.trim() || `claude exited with code ${code}`));

    return s;
}

/** Pause `child.stdout` while the consumer is saturated, resuming when its promise settles. */
function backpressure(child: ChildProcess) {
    let saturated: Promise<void> | null = null;
    const emit = (onText: ((t: string) => Promise<void> | void) | undefined, text: string): void => {
        if (!onText) return;
        const wait = onText(text);
        if (!wait) return;
        if (!saturated) child.stdout!.pause();
        saturated = wait;
        const resume = (): void => { if (saturated !== wait) return; saturated = null; child.stdout!.resume(); };
        void wait.then(resume, resume);
    };
    return { emit };
}

/** True when a turn is already in flight for this session (lets a caller answer 409 up front). */
export function isSessionBusy(sessionId: string): boolean {
    return SESSIONS.get(sessionId)?.busy === true;
}

/**
 * Run one turn against the session's warm process, spawning or resuming it as needed. Serialized
 * per session: a turn while another is in flight for the same id is rejected (the caller surfaces
 * a 409). Streams answer text through `onText` (honoring its backpressure) and resolves with the
 * turn summary. A process that dies mid-turn rejects, and the session is dropped so the next turn
 * respawns clean.
 */
export function runSessionTurn(
    spec: SessionSpec,
    sessionId: string,
    turn: SessionTurn,
    onText: ((t: string) => Promise<void> | void) | undefined,
    cfg: SessionRuntimeConfig = DEFAULT_SESSION_CONFIG,
): Promise<SessionTurnResult> {
    const owner = KNOWN.get(sessionId);
    if (owner !== undefined && owner !== spec.contextKey) {
        return Promise.reject(new SessionError("context-mismatch", `session ${sessionId} belongs to a different account/profile/pack context; start a new session_id for this context.`));
    }
    let s = SESSIONS.get(sessionId);
    if (s && s.busy) return Promise.reject(new SessionError("busy", "session busy: a turn is already in progress for this session"));

    // Inlining `!s` first lets the type narrow: after this block `s` is always a live session.
    if (!s || s.child.killed || s.child.exitCode !== null || s.child.signalCode !== null) {
        // A session we have never spawned starts fresh (--session-id); one we have (evicted, crashed,
        // or still here but dead) owns a transcript on disk and is resumed from it (--resume).
        const resume = !!s || KNOWN.has(sessionId);
        s = spawnSession(spec, sessionId, resume);
        SESSIONS.set(sessionId, s);
        remember(sessionId, spec.contextKey);
        evict(cfg, sessionId);
        startSweeper(cfg);
    }
    const session = s;
    session.busy = true;
    session.lastUsed = Date.now();

    return new Promise<SessionTurnResult>((resolve, reject) => {
        const summary: SessionTurnResult = { text: "", sessionId, inputTokens: 0, outputTokens: 0, isError: false };
        let streamedTurn = "";
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const { emit } = backpressure(session.child);

        /** Detach this turn from the session, once. False means someone already settled it. */
        const detach = (): boolean => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            session.onLine = null;
            session.onExit = null;
            session.busy = false;
            return true;
        };

        const finish = (): void => {
            if (!detach()) return;
            session.lastUsed = Date.now();
            if (summary.inputTokens === 0) summary.inputTokens = estimateTokens(turn.prompt);
            if (summary.outputTokens === 0) summary.outputTokens = estimateTokens(summary.text);
            resolve(summary);
        };

        // A wedged process never emits `result`, so the turn has to end itself. The session is killed
        // rather than left busy: its transcript survives, so the next turn respawns it with --resume.
        timer = setTimeout(() => {
            if (!detach()) return;
            kill(sessionId);
            reject(new SessionError("timeout", `session turn produced no result within ${cfg.turnTimeoutMs}ms; the session was reset and the next turn resumes it.`));
        }, cfg.turnTimeoutMs);

        session.onExit = (reason: string): void => {
            if (!detach()) return;
            reject(new Error(reason));
        };

        session.onLine = (line: string): void => {
            const ev = parseClaudeLine(line);
            if (!ev) return;
            if (ev.kind === "text") { summary.text += ev.text; streamedTurn += ev.text; emit(onText, ev.text); }
            else if (ev.kind === "text_final") {
                // Partials are always on for a session process, so text_final is the remainder the
                // deltas did not already deliver (everything if the turn produced none).
                const rest = ev.text.startsWith(streamedTurn) ? ev.text.slice(streamedTurn.length) : ev.text;
                streamedTurn = "";
                if (rest) { summary.text += rest; emit(onText, rest); }
            }
            else if (ev.kind === "result") {
                if (ev.text && !summary.text) { summary.text = ev.text; emit(onText, ev.text); }
                summary.inputTokens = ev.inputTokens;
                summary.outputTokens = ev.outputTokens;
                summary.isError = ev.isError;
                summary.errorMessage = ev.errorMessage;
                // `result` closes the turn; the process stays alive for the next one.
                finish();
            }
            // `init` (subtype init) carries the session id we already know; nothing to do.
        };

        // Feed the turn as one stream-json user message, images included (same content shape the
        // stateless adapter builds). The process replies, then waits for the next.
        const content: Array<ImageBlock | { type: "text"; text: string; }> = [{ type: "text", text: turn.prompt }];
        if (turn.images?.length) content.push(...turn.images);
        const msg = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
        try { session.child.stdin!.write(msg); }
        catch (err) { if (detach()) reject(err as Error); }
    });
}

/**
 * Sweep idle sessions on a timer, not only when a new one is created: a lone warm session that goes
 * quiet has no later spawn to trigger eviction, and would otherwise hold its process until shutdown.
 * Unref'd so it never keeps the process alive, and stopped once nothing is left to sweep.
 */
let sweeper: ReturnType<typeof setInterval> | null = null;

function startSweeper(cfg: SessionRuntimeConfig): void {
    if (sweeper) return;
    const period = Math.max(1000, Math.min(cfg.idleTtlMs, 60 * 1000));
    sweeper = setInterval(() => {
        evict(cfg, "");
        if (SESSIONS.size === 0) stopSweeper();
    }, period);
    sweeper.unref?.();
}

function stopSweeper(): void {
    if (!sweeper) return;
    clearInterval(sweeper);
    sweeper = null;
}

/** Evict idle sessions past the TTL, and the least-recently-used past the cap. Never evicts a busy
 *  session or `keep` (the one a caller just created). */
function evict(cfg: SessionRuntimeConfig, keep: string): void {
    const now = Date.now();
    for (const [id, s] of SESSIONS) {
        if (id === keep || s.busy) continue;
        if (now - s.lastUsed >= cfg.idleTtlMs) kill(id);
    }
    if (SESSIONS.size <= cfg.maxSessions) return;
    const idle = [...SESSIONS.entries()].filter(([id, s]) => id !== keep && !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id] of idle) {
        if (SESSIONS.size <= cfg.maxSessions) break;
        kill(id);
    }
}

/** Kill and forget one session's process. Its transcript stays on disk for a later --resume. */
function kill(id: string): void {
    const s = SESSIONS.get(id);
    if (!s) return;
    SESSIONS.delete(id);
    s.onLine = null; s.onExit = null;
    try { s.child.kill(); } catch { /* already gone */ }
}

/** Number of live warm sessions (for the dashboard / tests). */
export function liveSessionCount(): number {
    return SESSIONS.size;
}

/** Kill every warm session process. Called on API server shutdown so no child outlives it. */
export function closeAllSessions(): void {
    for (const id of [...SESSIONS.keys()]) kill(id);
    stopSweeper();
}
