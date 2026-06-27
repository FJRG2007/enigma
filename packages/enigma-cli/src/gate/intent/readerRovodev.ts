/**
 * Faithful port of upstream's `internal/intent/reader_rovodev.go`: the
 * Atlassian Rovo Dev reader over session JSON files in
 * `~/.rovodev/sessions/<session-id>/`.
 */

import { join } from "node:path";
import { scanFilePathsInText } from "./matcher";
import { resolveHome, newRepoMatcher } from "./paths";
import { readFileSync, statSync, readdirSync } from "node:fs";
import type { Reader, Session, DiscoverOpts, Role } from "./reader";
import { isNotExist, asString, asObject, errMessage } from "./readerClaude";
import { RoleUser, RoleAssistant, ZERO_TIME, isZeroTime, parseRFC3339 } from "./reader";

/** Agent name used in cache keys and DB rows. */
export const RovoDevReaderName = "rovodev";

const HOUR_MS = 60 * 60 * 1000;

/** Reads Atlassian Rovo Dev session JSON files. */
class RovoDevReader implements Reader {
    name(): string {
        return RovoDevReaderName;
    }

    async discover(opts: DiscoverOpts, signal?: AbortSignal): Promise<Session[]> {
        const home = resolveHome(opts.homeDir);
        const root = join(home, ".rovodev", "sessions");
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch (err) {
            if (isNotExist(err)) return [];
            throw new Error(`rovodev sessions: ${errMessage(err)}`);
        }

        const matcher = await newRepoMatcher(opts.originCwd, signal);
        const out: Session[] = [];

        for (const dir of entries) {
            if (!dir.isDirectory()) continue;
            const sessionDir = join(root, dir.name);
            const ctxPath = join(sessionDir, "session_context.json");
            let modTime: Date;
            try {
                modTime = statSync(ctxPath).mtime;
            } catch {
                continue;
            }
            if (!isZeroTime(opts.windowStart) && modTime.getTime() < opts.windowStart.getTime()) {
                continue;
            }
            if (!isZeroTime(opts.windowEnd) && modTime.getTime() > opts.windowEnd.getTime() + HOUR_MS) {
                continue;
            }
            const meta = rovodevPeek(sessionDir);
            if (meta === null) continue;
            if (!(await matcher.matches(meta.workspace, signal))) continue;
            out.push({
                agentName: RovoDevReaderName,
                sessionId: dir.name,
                cwd: meta.workspace,
                startedAt: meta.startedAt,
                lastActivity: modTime,
                lastMsgKey: modTime.toISOString(),
                messages: [],
                startedAtPath: sessionDir
            });
        }
        return out;
    }

    async load(s: Session): Promise<void> {
        if (!s.startedAtPath) {
            throw new Error("rovodev: missing session path");
        }
        const ctxPath = join(s.startedAtPath, "session_context.json");
        let data: string;
        try {
            data = readFileSync(ctxPath, "utf8");
        } catch (err) {
            throw new Error(`rovodev read: ${errMessage(err)}`);
        }
        let doc: Record<string, unknown>;
        try {
            doc = JSON.parse(data);
        } catch (err) {
            throw new Error(`rovodev parse: ${errMessage(err)}`);
        }
        const conversation = doc.conversation;
        if (!Array.isArray(conversation)) return;
        for (const m of conversation) {
            const entry = asObject(m);
            if (!entry) continue;
            const text = asString(entry.content).trim();
            if (text === "") continue;
            let role: Role = RoleAssistant;
            if (asString(entry.role).toLowerCase() === "user") {
                role = RoleUser;
            }
            s.messages.push({ role, text, filePaths: scanFilePathsInText(text) });
        }
    }
}

/** Returns a Reader for Rovo Dev transcripts. */
export function newRovoDevReader(): Reader {
    return new RovoDevReader();
}

/** The metadata returned by rovodevPeek. */
interface RovoDevMetadata {
    workspace: string;
    startedAt: Date;
}

/**
 * Reads the small metadata.json next to session_context.json to learn the
 * workspace path and start time without parsing the full conversation. Falls
 * back to the top-level workspace field of session_context.json.
 */
function rovodevPeek(sessionDir: string): RovoDevMetadata | null {
    // Try metadata.json first.
    try {
        const raw = asObject(JSON.parse(readFileSync(join(sessionDir, "metadata.json"), "utf8")));
        if (raw && asString(raw.workspace) !== "") {
            const started = parseRFC3339(asString(raw.created_at));
            return { workspace: asString(raw.workspace), startedAt: started };
        }
    } catch {
        // Missing or unparseable metadata.json; fall through.
    }
    // Fall back to peeking at session_context.json's top-level workspace field.
    try {
        const raw = asObject(JSON.parse(readFileSync(join(sessionDir, "session_context.json"), "utf8")));
        if (raw && asString(raw.workspace) !== "") {
            return { workspace: asString(raw.workspace), startedAt: ZERO_TIME };
        }
    } catch {
        // Fall through to null.
    }
    return null;
}
