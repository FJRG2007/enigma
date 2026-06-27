/**
 * Faithful port of upstream's `internal/intent/reader_pi.go`: the Pi
 * coding-agent reader over `~/.pi/agent/sessions/<repo>/*.jsonl`, including the
 * live/aggregate message de-duplication that reconciles incrementally-streamed
 * turns with the final aggregated `agent_end` record.
 */

import { join } from "node:path";
import { scanFilePathsInText } from "./matcher";
import { resolveHome, newRepoMatcher } from "./paths";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { RoleUser, RoleAssistant, parseRFC3339, isZeroTime } from "./reader";
import type { Reader, Session, Message, DiscoverOpts, Role } from "./reader";
import { isNotExist, asString, asObject, errMessage, extractToolPaths } from "./readerClaude";

/** Agent name used in cache keys and DB rows. */
export const PiReaderName = "pi";

const HOUR_MS = 60 * 60 * 1000;

/** Reads Pi coding-agent transcripts from ~/.pi/agent/sessions/. */
class PiReader implements Reader {
    name(): string {
        return PiReaderName;
    }

    async discover(opts: DiscoverOpts, signal?: AbortSignal): Promise<Session[]> {
        const home = resolveHome(opts.homeDir);
        const root = join(home, ".pi", "agent", "sessions");
        let repoDirs;
        try {
            repoDirs = readdirSync(root, { withFileTypes: true });
        } catch (err) {
            if (isNotExist(err)) return [];
            throw new Error(`pi sessions: ${errMessage(err)}`);
        }

        const matcher = await newRepoMatcher(opts.originCwd, signal);
        const out: Session[] = [];
        for (const repoDir of repoDirs) {
            signal?.throwIfAborted();
            if (!repoDir.isDirectory()) continue;
            const dirPath = join(root, repoDir.name);
            let files;
            try {
                files = readdirSync(dirPath, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const f of files) {
                if (f.isDirectory() || !f.name.endsWith(".jsonl")) continue;
                const path = join(dirPath, f.name);
                let modTime: Date;
                try {
                    modTime = statSync(path).mtime;
                } catch {
                    continue;
                }
                if (!isZeroTime(opts.windowStart) && modTime.getTime() < opts.windowStart.getTime()) {
                    continue;
                }
                if (!isZeroTime(opts.windowEnd) && modTime.getTime() > opts.windowEnd.getTime() + HOUR_MS) {
                    continue;
                }
                let meta;
                try {
                    meta = piPeekMetadata(path);
                } catch {
                    continue;
                }
                if (meta === null) continue;
                if (!(await matcher.matches(meta.cwd, signal))) continue;
                const sessionId = meta.id !== "" ? meta.id : f.name.replace(/\.jsonl$/, "");
                out.push({
                    agentName: PiReaderName,
                    sessionId,
                    cwd: meta.cwd,
                    startedAt: meta.startedAt,
                    lastActivity: modTime,
                    lastMsgKey: `${path}|${modTime.toISOString()}`,
                    messages: [],
                    startedAtPath: path
                });
            }
        }
        return out;
    }

    async load(s: Session): Promise<void> {
        if (!s.startedAtPath) {
            throw new Error("pi: session has no path");
        }
        let text: string;
        try {
            text = readFileSync(s.startedAtPath, "utf8");
        } catch (err) {
            throw new Error(`pi open: ${errMessage(err)}`);
        }
        let lastID = "";
        const seen = new Set<string>();
        const seenLive = new Set<string>();
        for (const line of text.split("\n")) {
            if (line.length === 0) continue;
            const rec = parsePiRecord(line);
            if (!rec.ok) continue;
            if (rec.id !== "") lastID = rec.id;
            let priorSeen = seen;
            if (rec.aggregate) {
                priorSeen = new Set(seen);
            }
            for (const msg of rec.msgs) {
                if (!rec.aggregate && msg.identity !== "") {
                    if (seenLive.has(msg.identity)) continue;
                    seenLive.add(msg.identity);
                }
                const key = piMessageKey(msg.message);
                if (rec.aggregate && priorSeen.has(key)) continue;
                seen.add(key);
                s.messages.push(msg.message);
            }
        }
        if (lastID !== "") s.lastMsgKey = lastID;
    }
}

/** Returns a Reader for Pi coding-agent transcripts. */
export function newPiReader(): Reader {
    return new PiReader();
}

function piMessageKey(msg: Message): string {
    return `${msg.role}\x00${msg.text ?? ""}\x00${(msg.filePaths ?? []).join("\x00")}`;
}

/** A parsed Pi message plus its stream-dedup identity. */
interface PiParsedMessage {
    message: Message;
    identity: string;
}

/** Outcome of parsing a single Pi transcript line. */
interface PiRecord {
    msgs: PiParsedMessage[];
    id: string;
    aggregate: boolean;
    ok: boolean;
}

/** The metadata returned by piPeekMetadata. */
interface PiMetadata {
    id: string;
    cwd: string;
    startedAt: Date;
}

function piPeekMetadata(path: string): PiMetadata | null {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        let raw: Record<string, unknown>;
        try {
            raw = JSON.parse(line);
        } catch {
            continue;
        }
        if (raw.type !== "session" || asString(raw.cwd) === "") continue;
        return { id: asString(raw.id), cwd: asString(raw.cwd), startedAt: parseRFC3339(asString(raw.timestamp)) };
    }
    return null;
}

function parsePiRecord(line: string): PiRecord {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(line);
    } catch {
        return { msgs: [], id: "", aggregate: false, ok: false };
    }
    const id = asString(raw.id);
    const timestamp = asString(raw.timestamp);
    switch (raw.type) {
        case "message":
        case "message_end":
        case "turn_end": {
            const msg = parsePiParsedMessage(raw.message, timestamp);
            if (msg === null) {
                return { msgs: [], id, aggregate: false, ok: true };
            }
            return { msgs: [msg], id, aggregate: false, ok: true };
        }
        case "message_update":
            return { msgs: [], id, aggregate: false, ok: true };
        case "agent_end":
            return { msgs: parsePiMessages(raw.messages, timestamp), id, aggregate: true, ok: true };
        default:
            return { msgs: [], id, aggregate: false, ok: true };
    }
}

function parsePiMessages(raw: unknown, timestamp: string): PiParsedMessage[] {
    if (!Array.isArray(raw)) return [];
    const msgs: PiParsedMessage[] = [];
    for (const item of raw) {
        const msg = parsePiParsedMessage(item, timestamp);
        if (msg !== null) msgs.push(msg);
    }
    return msgs;
}

function parsePiParsedMessage(raw: unknown, timestamp: string): PiParsedMessage | null {
    const msg = asObject(raw);
    if (!msg) return null;

    let role: Role;
    const rawRole = asString(msg.role).toLowerCase();
    if (rawRole === "user") {
        role = RoleUser;
    } else if (rawRole === "assistant") {
        role = RoleAssistant;
    } else {
        return null;
    }

    const [rawText, contentPaths] = parsePiContent(msg.content);
    const text = rawText.trim();
    const paths = contentPaths;
    if (role === RoleUser) {
        paths.push(...scanFilePathsInText(text));
    }
    if (text === "" && paths.length === 0) return null;
    const ts = parseRFC3339(timestamp);
    const message: Message = { role, text, filePaths: paths, timestamp: ts };

    const responseId = asString(msg.responseId);
    const id = asString(msg.id);
    let identity = "";
    if (responseId !== "") {
        identity = `${role}\x00responseId:${responseId}`;
    } else if (id !== "") {
        identity = `${role}\x00id:${id}`;
    }
    return { message, identity };
}

function parsePiContent(content: unknown): [string, string[]] {
    if (typeof content === "string") return [content, []];
    if (!Array.isArray(content)) return ["", []];
    let sb = "";
    const paths: string[] = [];
    for (const item of content) {
        const obj = asObject(item);
        if (!obj) continue;
        switch (obj.type) {
            case "text":
            case "input_text":
            case "output_text":
                if (typeof obj.text === "string") {
                    sb += obj.text;
                    sb += "\n";
                } else if (typeof obj.content === "string") {
                    sb += obj.content;
                    sb += "\n";
                }
                break;
            case "toolCall":
            case "tool_call":
            case "tool_use":
                paths.push(...piToolCallPaths(obj));
                break;
        }
    }
    return [sb, paths];
}

function piToolCallPaths(item: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const key of ["arguments", "input"]) {
        const args = item[key];
        if (args === undefined) continue;
        const obj = asObject(args);
        if (obj) {
            out.push(...extractToolPaths(obj));
            out.push(...piCommandPaths(obj.command));
        } else if (typeof args === "string") {
            let parsed: Record<string, unknown> | undefined;
            try {
                parsed = asObject(JSON.parse(args));
            } catch {
                parsed = undefined;
            }
            if (parsed) {
                out.push(...extractToolPaths(parsed));
                out.push(...piCommandPaths(parsed.command));
            } else {
                out.push(...scanFilePathsInText(args));
            }
        }
    }
    return out;
}

function piCommandPaths(raw: unknown): string[] {
    if (typeof raw === "string") return scanFilePathsInText(raw);
    if (Array.isArray(raw)) {
        const out: string[] = [];
        for (const part of raw) {
            if (typeof part === "string") out.push(...scanFilePathsInText(part));
        }
        return out;
    }
    return [];
}
