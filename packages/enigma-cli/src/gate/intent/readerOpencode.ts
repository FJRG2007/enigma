/**
 * Faithful port of upstream's `internal/intent/reader_opencode.go`: the
 * OpenCode reader over the session/message/part tables in
 * `$XDG_DATA_HOME/opencode/opencode.db`, falling back to
 * `~/.local/share/opencode/opencode.db`.
 *
 * Go used `database/sql` + modernc sqlite; here read-only access goes through
 * Bun's built-in `bun:sqlite`, matching the gate db layer.
 */

import { join } from "node:path";
import { statSync } from "node:fs";
import { Database as BunSqlite } from "bun:sqlite";

import { RoleUser, RoleAssistant } from "./reader";
import { resolveHome, newRepoMatcher } from "./paths";
import type { Reader, Session, DiscoverOpts, Role } from "./reader";
import { isNotExist, asString, asObject, errMessage, extractToolPaths } from "./readerClaude";

/** Agent name used in cache keys and DB rows. */
export const OpenCodeReaderName = "opencode";

const HOUR_MS = 60 * 60 * 1000;

/** Reads OpenCode session/message/part rows from opencode.db. */
class OpenCodeReader implements Reader {
    name(): string {
        return OpenCodeReaderName;
    }

    async discover(opts: DiscoverOpts, signal?: AbortSignal): Promise<Session[]> {
        const dbPath = resolveOpenCodeDB(opts.homeDir);
        if (dbPath === "") return [];
        try {
            statSync(dbPath);
        } catch (err) {
            if (isNotExist(err)) return [];
            throw err;
        }

        let db: BunSqlite;
        try {
            db = new BunSqlite(dbPath, { readonly: true });
        } catch (err) {
            throw new Error(`opencode open: ${errMessage(err)}`);
        }
        try {
            try {
                db.exec("PRAGMA busy_timeout = 2000");
            } catch {
                // Best-effort; the query below still works without it.
            }

            const matcher = await newRepoMatcher(opts.originCwd, signal);
            // OpenCode timestamps are unix milliseconds.
            const winStart = opts.windowStart.getTime();
            const winEnd = opts.windowEnd.getTime() + HOUR_MS;

            let rows: unknown[][];
            try {
                rows = db
                    .query(
                        `SELECT id, directory, time_created, time_updated FROM session
			 WHERE time_updated >= ? AND time_created <= ?
			 ORDER BY time_updated DESC LIMIT 200`
                    )
                    .values(winStart, winEnd);
            } catch {
                return [];
            }

            const out: Session[] = [];
            for (const row of rows) {
                const id = asString(row[0]);
                const directory = asString(row[1]);
                const timeCreated = Number(row[2]);
                const timeUpdated = Number(row[3]);
                if (!(await matcher.matches(directory, signal))) continue;
                out.push({
                    agentName: OpenCodeReaderName,
                    sessionId: id,
                    cwd: directory,
                    startedAt: new Date(timeCreated),
                    lastActivity: new Date(timeUpdated),
                    lastMsgKey: String(timeUpdated),
                    messages: [],
                    startedAtPath: dbPath
                });
            }
            return out;
        } finally {
            db.close();
        }
    }

    async load(s: Session): Promise<void> {
        if (!s.startedAtPath) {
            throw new Error("opencode: missing db path");
        }
        let db: BunSqlite;
        try {
            db = new BunSqlite(s.startedAtPath, { readonly: true });
        } catch (err) {
            throw new Error(`opencode open: ${errMessage(err)}`);
        }
        try {
            try {
                db.exec("PRAGMA busy_timeout = 2000");
            } catch {
                // Best-effort.
            }

            // Map message id -> role using the role field embedded in message.data.
            let msgRows: unknown[][];
            try {
                msgRows = db
                    .query("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
                    .values(s.sessionId);
            } catch (err) {
                throw new Error(`opencode messages: ${errMessage(err)}`);
            }
            const msgs = new Map<string, { role: Role; timestamp: Date }>();
            const ordered: string[] = [];
            for (const row of msgRows) {
                const id = asString(row[0]);
                const tc = Number(row[1]);
                const data = asString(row[2]);
                let role: Role = RoleAssistant;
                try {
                    const meta = asObject(JSON.parse(data));
                    if (meta && asString(meta.role).toLowerCase() === "user") role = RoleUser;
                } catch {
                    // Leave role as assistant on parse failure.
                }
                msgs.set(id, { role, timestamp: new Date(tc) });
                ordered.push(id);
            }

            // Walk parts in chronological order; bucket by message id.
            let partRows: unknown[][];
            try {
                partRows = db
                    .query("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id")
                    .values(s.sessionId);
            } catch (err) {
                throw new Error(`opencode parts: ${errMessage(err)}`);
            }
            const agg = new Map<string, { text: string; paths: string[] }>();
            for (const row of partRows) {
                const msgID = asString(row[0]);
                const data = asString(row[1]);
                let part: Record<string, unknown> | undefined;
                try {
                    part = asObject(JSON.parse(data));
                } catch {
                    continue;
                }
                if (!part) continue;
                let bucket = agg.get(msgID);
                if (!bucket) {
                    bucket = { text: "", paths: [] };
                    agg.set(msgID, bucket);
                }
                switch (part.type) {
                    case "text":
                        if (typeof part.text === "string" && part.text !== "") {
                            bucket.text += part.text;
                            bucket.text += "\n";
                        }
                        break;
                    case "tool": {
                        const state = asObject(part.state);
                        const input = state ? asObject(state.input) : undefined;
                        if (input) bucket.paths.push(...extractToolPaths(input));
                        break;
                    }
                }
            }

            // Reassemble preserving message order.
            for (const id of ordered) {
                const bucket = agg.get(id);
                if (!bucket) continue;
                const text = bucket.text.trim();
                if (text === "" && bucket.paths.length === 0) continue;
                const info = msgs.get(id);
                s.messages.push({
                    role: info ? info.role : RoleAssistant,
                    text,
                    filePaths: bucket.paths,
                    timestamp: info ? info.timestamp : undefined
                });
            }
            if (ordered.length > 0) s.lastMsgKey = ordered[ordered.length - 1];
        } finally {
            db.close();
        }
    }
}

/** Returns a Reader for OpenCode transcripts. */
export function newOpenCodeReader(): Reader {
    return new OpenCodeReader();
}

/**
 * Picks the path to opencode.db, honoring XDG_DATA_HOME and falling back to
 * ~/.local/share/opencode/opencode.db.
 */
function resolveOpenCodeDB(homeOverride: string): string {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && xdg !== "") {
        return join(xdg, "opencode", "opencode.db");
    }
    const home = resolveHome(homeOverride);
    return join(home, ".local", "share", "opencode", "opencode.db");
}
