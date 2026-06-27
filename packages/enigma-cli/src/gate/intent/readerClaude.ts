/**
 * Faithful port of upstream's `internal/intent/reader_claude.go`: the Claude
 * Code transcript reader over `~/.claude/projects/<dir>/*.jsonl`, plus the
 * shared `extractToolPaths` helper reused by the codex/opencode/pi readers.
 *
 * Go's streaming `bufio.Scanner` over each `.jsonl` is modeled as a full read
 * plus newline split; the time-window pre-filter keeps the candidate set small,
 * so this is acceptable for a faithful port.
 */

import { join } from "node:path";
import { resolveHome, newRepoMatcher } from "./paths";
import { readFileSync, statSync, readdirSync } from "node:fs";
import type { Reader, Session, Message, DiscoverOpts } from "./reader";
import { RoleUser, RoleAssistant, ZERO_TIME, isZeroTime, parseRFC3339 } from "./reader";

/** Agent name used in cache keys and DB rows. */
export const ClaudeReaderName = "claude";

const HOUR_MS = 60 * 60 * 1000;

/** Reads Claude Code transcripts from ~/.claude/projects/. */
class ClaudeReader implements Reader {
    name(): string {
        return ClaudeReaderName;
    }

    async discover(opts: DiscoverOpts, signal?: AbortSignal): Promise<Session[]> {
        const home = resolveHome(opts.homeDir);
        const root = join(home, ".claude", "projects");
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch (err) {
            if (isNotExist(err)) return [];
            throw new Error(`read claude projects: ${errMessage(err)}`);
        }

        const matcher = await newRepoMatcher(opts.originCwd, signal);
        const out: Session[] = [];

        for (const dir of entries) {
            signal?.throwIfAborted();
            if (!dir.isDirectory()) continue;
            const dirPath = join(root, dir.name);
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
                    // Allow some slack on the end side too. Files modified far past
                    // HeadTime are unlikely sources of this change.
                    continue;
                }
                let meta;
                try {
                    meta = claudePeekMetadata(path);
                } catch {
                    continue;
                }
                if (meta === null) continue;
                if (!(await matcher.matches(meta.cwd, signal))) continue;
                const session: Session = {
                    agentName: ClaudeReaderName,
                    sessionId: f.name.replace(/\.jsonl$/, ""),
                    cwd: meta.cwd,
                    startedAt: meta.firstTimestamp,
                    lastActivity: modTime,
                    lastMsgKey: `${path}|${modTime.toISOString()}`,
                    messages: [],
                    startedAtPath: path
                };
                out.push(session);
            }
        }
        return out;
    }

    async load(s: Session): Promise<void> {
        if (!s.startedAtPath) {
            throw new Error("claude: session has no path");
        }
        let text: string;
        try {
            text = readFileSync(s.startedAtPath, "utf8");
        } catch (err) {
            throw new Error(`claude open: ${errMessage(err)}`);
        }
        let lastUUID = "";
        for (const line of text.split("\n")) {
            if (line.length === 0) continue;
            const rec = parseClaudeRecord(line);
            if (rec === null) continue;
            if (rec.uuid !== "") lastUUID = rec.uuid;
            if (rec.message === null) continue;
            s.messages.push(rec.message);
        }
        if (lastUUID !== "") s.lastMsgKey = lastUUID;
    }
}

/** Returns a Reader for Claude Code transcripts. */
export function newClaudeReader(): Reader {
    return new ClaudeReader();
}

/** The small subset returned by claudePeekMetadata. */
interface ClaudeMetadata {
    cwd: string;
    firstTimestamp: Date;
}

/**
 * Reads the first non-attachment record from a transcript file to extract its
 * cwd and start time. Returns null when the file is empty or contains no
 * parseable records with a cwd.
 */
function claudePeekMetadata(path: string): ClaudeMetadata | null {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        let raw: Record<string, unknown>;
        try {
            raw = JSON.parse(line);
        } catch {
            continue;
        }
        const cwd = asString(raw.cwd);
        if (cwd === "") continue;
        let firstTimestamp = ZERO_TIME;
        const ts = asString(raw.timestamp);
        if (ts !== "") {
            const parsed = parseRFC3339(ts);
            if (!isZeroTime(parsed)) firstTimestamp = parsed;
        }
        return { cwd, firstTimestamp };
    }
    return null;
}

/** The parsed shape of one .jsonl line we care about. */
interface ClaudeRecord {
    uuid: string;
    message: Message | null;
}

/**
 * Returns a Message for user and assistant turns. It returns a record with a
 * null message for records we want to track for LastMsgKey/uuid purposes but
 * should not include in Messages. Returns null when the line does not parse.
 */
function parseClaudeRecord(line: string): ClaudeRecord | null {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }

    const rec: ClaudeRecord = { uuid: asString(raw.uuid), message: null };
    const ts = parseRFC3339(asString(raw.timestamp));

    switch (raw.type) {
        case "user": {
            if (raw.isMeta === true) return rec;
            const [rawText, paths] = parseClaudeUserMessage(raw.message);
            const text = rawText.trim();
            if (text === "") return rec;
            if (isClaudeSyntheticUserText(text)) return rec;
            rec.message = { role: RoleUser, text, filePaths: paths, timestamp: ts };
            return rec;
        }
        case "assistant": {
            const [rawText, paths] = parseClaudeAssistantMessage(raw.message);
            const text = rawText.trim();
            if (text === "" && paths.length === 0) return rec;
            rec.message = { role: RoleAssistant, text, filePaths: paths, timestamp: ts };
            return rec;
        }
        default:
            return rec;
    }
}

/**
 * Extracts text and tool_result file paths from a user record. content may be a
 * plain string or an array of typed items. tool_result text is dropped - it is
 * tool output, not user intent.
 */
function parseClaudeUserMessage(message: unknown): [string, string[]] {
    const msg = asObject(message);
    if (!msg) return ["", []];
    const content = msg.content;
    if (typeof content === "string") return [content, []];
    if (!Array.isArray(content)) return ["", []];
    let sb = "";
    for (const item of content) {
        const obj = asObject(item);
        if (obj && obj.type === "text" && typeof obj.text === "string") {
            sb += obj.text;
            sb += "\n";
        }
    }
    return [sb, []];
}

/**
 * Extracts assistant text and any file paths referenced via tool_use input
 * fields. Thinking blocks are dropped.
 */
function parseClaudeAssistantMessage(message: unknown): [string, string[]] {
    const msg = asObject(message);
    if (!msg) return ["", []];
    const content = msg.content;
    if (!Array.isArray(content)) return ["", []];
    let sb = "";
    const paths: string[] = [];
    for (const item of content) {
        const obj = asObject(item);
        if (!obj) continue;
        switch (obj.type) {
            case "text":
                if (typeof obj.text === "string") {
                    sb += obj.text;
                    sb += "\n";
                }
                break;
            case "tool_use": {
                const input = asObject(obj.input);
                if (input) paths.push(...extractToolPaths(input));
                break;
            }
        }
    }
    return [sb, paths];
}

/**
 * Pulls plausible file paths from tool input fields. Agent tools use several key
 * names for path-like values; cover the common variants here so transcript
 * readers can share the same extraction logic.
 */
export function extractToolPaths(input: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
        const v = input[key];
        if (typeof v === "string" && v !== "") out.push(v);
    }
    const pattern = input.pattern;
    if (typeof pattern === "string") {
        // Patterns may contain globs; still useful as a hint.
        out.push(pattern);
    }
    const edits = input.edits;
    if (Array.isArray(edits)) {
        for (const e of edits) {
            const m = asObject(e);
            if (m && typeof m.file_path === "string") out.push(m.file_path);
        }
    }
    return out;
}

/**
 * Filters out the meta strings the Claude CLI inserts as fake "user" messages:
 * slash-command echoes, caveats, etc.
 */
function isClaudeSyntheticUserText(text: string): boolean {
    const t = text.trim();
    if (t.startsWith("<command-name>")) return true;
    if (t.startsWith("<local-command-caveat>")) return true;
    if (t.startsWith("Caveat:")) return true;
    return false;
}

/** Reports whether `err` is a filesystem "does not exist" error. */
export function isNotExist(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/** Returns `v` when it is a string, otherwise "". Mirrors Go's `x.(string)`. */
export function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** Returns `v` as a plain object, or undefined for non-object/array/null. */
export function asObject(v: unknown): Record<string, unknown> | undefined {
    return typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
