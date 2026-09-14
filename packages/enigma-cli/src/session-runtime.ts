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

import { spawn, type ChildProcess } from "node:child_process";
import { parseClaudeLine, resolveClaudeModel, DEFAULT_MODEL, estimateTokens } from "./api-agents";

/** One turn's normalized outcome, matching the api-server's RunResult shape. */
export interface SessionTurnResult {
    text: string;
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    isError: boolean;
    errorMessage?: string;
}

/** How to launch a session's Claude Code process. Built by the caller from the request context. */
export interface SessionSpec {
    binary: string;
    env: NodeJS.ProcessEnv;
    /** Requested model id (resolved to a real Claude id, else the default). */
    model?: string | null;
    /** System prompt, fixed for the life of the session (a conversation has one system prompt). */
    system?: string | null;
    /** Drop the user's MCP servers (tools off): faster boot, smaller prompt. See api-agents build(). */
    strictMcp: boolean;
    /** Windows needs shell invocation for a non-.exe launcher; mirrors runAgent. */
    useShell: boolean;
}

/** Runtime bounds. Small, overridable from config. */
export interface SessionRuntimeConfig {
    /** Evict a session whose process has been idle at least this long (ms). */
    idleTtlMs: number;
    /** Maximum live session processes; the least-recently-used is evicted past this. */
    maxSessions: number;
}

export const DEFAULT_SESSION_CONFIG: SessionRuntimeConfig = { idleTtlMs: 15 * 60 * 1000, maxSessions: 8 };

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
    if (spec.strictMcp) args.push("--strict-mcp-config");
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
    child.stderr.on("data", (chunk: string) => { s.stderr += chunk.slice(0, 4096); });

    const die = (reason: string): void => {
        SESSIONS.delete(sessionId);
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
    prompt: string,
    onText: ((t: string) => Promise<void> | void) | undefined,
    cfg: SessionRuntimeConfig = DEFAULT_SESSION_CONFIG,
): Promise<SessionTurnResult> {
    let s = SESSIONS.get(sessionId);
    if (s && s.busy) return Promise.reject(new Error("session busy: a turn is already in progress for this session"));

    // Inlining `!s` first lets the type narrow: after this block `s` is always a live session.
    if (!s || s.child.killed || s.child.exitCode !== null || s.child.signalCode !== null) {
        // A session we have never seen starts fresh (--session-id); one we had but lost (evicted,
        // crashed) is resumed from its persisted transcript (--resume).
        const resume = !!s;
        s = spawnSession(spec, sessionId, resume);
        SESSIONS.set(sessionId, s);
        evict(cfg, sessionId);
    }
    const session = s;
    session.busy = true;
    session.lastUsed = Date.now();

    return new Promise<SessionTurnResult>((resolve, reject) => {
        const summary: SessionTurnResult = { text: "", sessionId, inputTokens: 0, outputTokens: 0, isError: false };
        let streamedTurn = "";
        let settled = false;
        const { emit } = backpressure(session.child);

        const finish = (): void => {
            if (settled) return;
            settled = true;
            session.busy = false;
            session.onLine = null;
            session.onExit = null;
            session.lastUsed = Date.now();
            if (summary.inputTokens === 0) summary.inputTokens = estimateTokens(prompt);
            if (summary.outputTokens === 0) summary.outputTokens = estimateTokens(summary.text);
            resolve(summary);
        };

        session.onExit = (reason: string): void => {
            if (settled) return;
            settled = true;
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

        // Feed the turn as one stream-json user message. The process replies, then waits for the next.
        const msg = `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`;
        try { session.child.stdin!.write(msg); }
        catch (err) { if (!settled) { settled = true; reject(err as Error); } }
    });
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
}
