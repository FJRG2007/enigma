/**
 * Faithful port of upstream's `internal/intent/reader_codex.go`: the Codex CLI
 * reader. Session metadata (cwd, timestamps, rollout path) lives in
 * `~/.codex/state_*.sqlite`; the actual transcript is a JSONL rollout file
 * referenced by `threads.rollout_path`. The SQLite filters candidates fast, then
 * the rollout is parsed to recover the full user/assistant turn-by-turn text.
 *
 * Go used `database/sql` + modernc sqlite; here read-only access goes through
 * Bun's built-in `bun:sqlite`, matching the gate db layer.
 */

import { join, isAbsolute } from "node:path";
import { scanFilePathsInText } from "./matcher";
import { Database as BunSqlite } from "bun:sqlite";
import { RoleUser, RoleAssistant } from "./reader";
import { readFileSync, readdirSync } from "node:fs";
import { resolveHome, newRepoMatcher } from "./paths";
import type { Reader, Session, Message, DiscoverOpts, Role } from "./reader";
import { isNotExist, asString, asObject, errMessage, extractToolPaths } from "./readerClaude";

/** Agent name used in cache keys and DB rows. */
export const CodexReaderName = "codex";

const HOUR_MS = 60 * 60 * 1000;

/** Reads Codex CLI sessions from the state DB and rollout JSONL files. */
class CodexReader implements Reader {
    name(): string {
        return CodexReaderName;
    }

    async discover(opts: DiscoverOpts, signal?: AbortSignal): Promise<Session[]> {
        const home = resolveHome(opts.homeDir);
        const codexHome = join(home, ".codex");
        const dbPath = resolveCodexStateDB(codexHome);
        if (dbPath === "") return [];

        let db: BunSqlite;
        try {
            db = new BunSqlite(dbPath, { readonly: true });
        } catch (err) {
            throw new Error(`codex open: ${errMessage(err)}`);
        }
        try {
            try {
                db.exec("PRAGMA busy_timeout = 2000");
            } catch {
                // Best-effort; the query below still works without it.
            }

            const matcher = await newRepoMatcher(opts.originCwd, signal);
            const winStart = Math.floor(opts.windowStart.getTime() / 1000);
            const winEnd = Math.floor((opts.windowEnd.getTime() + HOUR_MS) / 1000);

            let rows: unknown[][];
            try {
                rows = db
                    .query(
                        `SELECT id, cwd, created_at, updated_at, rollout_path
			 FROM threads
			 WHERE updated_at >= ? AND created_at <= ?
			 ORDER BY updated_at DESC
			 LIMIT 200`
                    )
                    .values(winStart, winEnd);
            } catch {
                // threads table missing or schema changed: treat as no data.
                return [];
            }

            const out: Session[] = [];
            for (const row of rows) {
                const id = asString(row[0]);
                const cwd = asString(row[1]);
                const createdAt = Number(row[2]);
                const updatedAt = Number(row[3]);
                let rolloutPath = asString(row[4]);
                if (!(await matcher.matches(cwd, signal))) continue;
                // Resolve relative rollout paths against ~/.codex.
                if (rolloutPath !== "" && !isAbsolute(rolloutPath)) {
                    rolloutPath = join(codexHome, rolloutPath);
                }
                out.push({
                    agentName: CodexReaderName,
                    sessionId: id,
                    cwd,
                    startedAt: new Date(createdAt * 1000),
                    lastActivity: new Date(updatedAt * 1000),
                    lastMsgKey: String(updatedAt),
                    messages: [],
                    startedAtPath: rolloutPath
                });
            }
            return out;
        } finally {
            db.close();
        }
    }

    async load(s: Session): Promise<void> {
        if (!s.startedAtPath) {
            // No rollout file. Without per-turn text, this session can't
            // contribute meaningful intent; skip rather than fabricate.
            throw new Error("codex: session has no rollout path");
        }
        let text: string;
        try {
            text = readFileSync(s.startedAtPath, "utf8");
        } catch (err) {
            if (isNotExist(err)) {
                throw new Error(`codex rollout missing: ${s.startedAtPath}`);
            }
            throw new Error(`codex open rollout: ${errMessage(err)}`);
        }

        for (const line of text.split("\n")) {
            if (line.length === 0) continue;
            const msg = parseCodexLine(line);
            if (msg === null) continue;
            s.messages.push(msg);
        }
    }
}

/** Returns a Reader for Codex CLI transcripts. */
export function newCodexReader(): Reader {
    return new CodexReader();
}

/**
 * Returns a Message for the user/assistant turns we care about. Tool calls
 * produce file-path hints attached to a file-path-only Message so the matcher
 * can use them; their arguments do NOT enter Message.text since that would leak
 * shell commands and tool I/O into the summarizer's input.
 */
function parseCodexLine(line: string): Message | null {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    switch (raw.type) {
        case "event_msg":
            return parseCodexEventMsg(raw.payload);
        case "response_item":
            return parseCodexResponseItem(raw.payload);
        default:
            return null;
    }
}

function parseCodexEventMsg(payload: unknown): Message | null {
    const ev = asObject(payload);
    if (!ev) return null;
    if (ev.type !== "user_message") return null;
    const text = asString(ev.message).trim();
    if (text === "") return null;
    return { role: RoleUser, text, filePaths: scanFilePathsInText(text) };
}

function parseCodexResponseItem(payload: unknown): Message | null {
    const item = asObject(payload);
    if (!item) return null;

    switch (item.type) {
        case "message": {
            // Assistant or user. The user_message envelope above is the
            // canonical user-turn shape, but some recorders emit user content
            // under response_item too.
            let role: Role = RoleAssistant;
            if (asString(item.role).toLowerCase() === "user") {
                role = RoleUser;
            }
            const text = codexJoinContent(item.content).trim();
            if (text === "") return null;
            return { role, text, filePaths: scanFilePathsInText(text) };
        }
        case "function_call": {
            // Tool call: capture file paths from the arguments JSON for matching,
            // but keep text empty. Attach to an assistant message because tool
            // calls are made by the assistant turn.
            const paths = codexExtractToolPaths(asString(item.name), asString(item.arguments));
            if (paths.length === 0) return null;
            return { role: RoleAssistant, filePaths: paths };
        }
        default:
            return null;
    }
}

/**
 * Flattens a content array into a single string. The schema allows
 * `[{"type":"output_text","text":"..."}]` for assistant text and
 * `[{"type":"input_text","text":"..."}]` for user text. Both are accepted.
 */
function codexJoinContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let sb = "";
    for (const item of content) {
        const obj = asObject(item);
        if (!obj) continue;
        switch (obj.type) {
            case "output_text":
            case "input_text":
            case "text":
                if (typeof obj.text === "string") {
                    sb += obj.text;
                    sb += "\n";
                }
                break;
        }
    }
    return sb;
}

/**
 * Pulls file paths out of a tool call's arguments JSON. Codex's main tools are
 * `shell` (a command list) and read/write helpers that pass file_path/path keys.
 * Both shapes are handled so the matcher gets useful hints.
 */
function codexExtractToolPaths(_toolName: string, argumentsJSON: string): string[] {
    if (argumentsJSON === "") return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(argumentsJSON);
    } catch {
        return [];
    }
    // Some shells double-encode; a string payload is scanned directly.
    if (typeof parsed === "string") return scanFilePathsInText(parsed);
    const args = asObject(parsed);
    if (!args) return [];

    const out = extractToolPaths(args);

    // shell tool: arguments contain a "command" array of strings.
    const cmd = args.command;
    if (typeof cmd === "string") {
        out.push(...scanFilePathsInText(cmd));
    } else if (Array.isArray(cmd)) {
        for (const part of cmd) {
            if (typeof part === "string") out.push(...scanFilePathsInText(part));
        }
    }
    return out;
}

/**
 * Picks the highest-numbered state_<N>.sqlite under root. Codex versions its
 * state DB; the most recent one is chosen without hard-coding the suffix. Sort
 * numerically by the <N> suffix - lexicographic order would rank state_9 above
 * state_10 once Codex reaches two-digit versions. Files whose suffix doesn't
 * parse as an integer are placed at the end so they never override a real
 * numbered DB. Returns "" when none exist.
 */
function resolveCodexStateDB(root: string): string {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
        if (isNotExist(err)) return "";
        throw err;
    }
    const candidates: string[] = [];
    for (const e of entries) {
        const name = e.name;
        if (!name.startsWith("state_") || !name.endsWith(".sqlite")) continue;
        candidates.push(name);
    }
    if (candidates.length === 0) return "";
    candidates.sort((a, b) => {
        const [ni, oki] = codexStateVersion(a);
        const [nj, okj] = codexStateVersion(b);
        if (oki && okj) return ni > nj ? -1 : ni < nj ? 1 : 0;
        if (oki) return -1;
        if (okj) return 1;
        return a > b ? -1 : a < b ? 1 : 0;
    });
    return join(root, candidates[0]);
}

/**
 * Extracts the integer N from "state_N.sqlite". Returns [0, false] when the
 * suffix is missing or non-numeric.
 */
function codexStateVersion(name: string): [number, boolean] {
    const trimmed = name.replace(/^state_/, "").replace(/\.sqlite$/, "");
    if (trimmed === "") return [0, false];
    if (!/^-?\d+$/.test(trimmed)) return [0, false];
    return [parseInt(trimmed, 10), true];
}
