/**
 * Shared discovery of Claude Code session transcripts. Both the usage observer (token
 * accounting) and recall (session memory) need to find every *.jsonl transcript across
 * the default config dir and each enigma-managed account, so that logic lives here once
 * rather than in each consumer. Node-builtins only and no enigma imports beyond the
 * accounts registry JSON shape, so it stays a light leaf with no cycles.
 *
 * Only Claude Code is covered today: it stores per-session JSONL under
 * ~/.claude/projects/<project>/*.jsonl. Codex and OpenCode use undocumented/absent local
 * session stores, so a reader is added here only when their format is verified.
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";

/** One Claude account's transcript source: its display name and its projects directory. */
export interface ClaudeSource { account: string; dir: string; }

/**
 * Every Claude account's transcript directory: the default config dir plus each
 * enigma-managed account under ~/.enigma/claude/<name>/projects, so consumers reflect ALL
 * logins, not just the default one. ENIGMA_CLAUDE_PROJECTS overrides the default source
 * (used by tests).
 */
export function claudeProjectsDirs(): ClaudeSource[] {
    const out: ClaudeSource[] = [{ account: "default", dir: process.env.ENIGMA_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects") }];
    const base = join(homedir(), ".enigma", "claude");
    // Account directories are opaque (a UUID since names were decoupled from paths), so map
    // each back to its display name from the registry; fall back to the basename for a legacy
    // name-based dir or one not in the registry.
    const names = managedClaudeNames();
    try {
        for (const e of readdirSync(base, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const dir = join(base, e.name, "projects");
            if (existsSync(dir)) out.push({ account: names[e.name] ?? e.name, dir });
        }
    } catch { /* no managed accounts */ }
    return out;
}

/**
 * Map a managed Claude account's directory basename to its display name, read straight from
 * the accounts registry (not via accounts.ts - this stays light and only depends on the
 * registry's JSON shape, defensively). Absent/unreadable registry yields an empty map.
 */
function managedClaudeNames(): Record<string, string> {
    const map: Record<string, string> = {};
    try {
        const reg = JSON.parse(readFileSync(join(homedir(), ".enigma", "accounts.json"), "utf8")) as {
            tools?: { claude?: { accounts?: { name?: unknown; dir?: unknown; }[]; }; };
        };
        for (const a of reg.tools?.claude?.accounts ?? []) {
            if (typeof a?.name === "string" && typeof a?.dir === "string") map[basename(a.dir)] = a.name;
        }
    } catch { /* no registry */ }
    return map;
}

/** Recursively list every *.jsonl under `dir` (sessions live nested in subagents/ too). */
export function listJsonl(dir: string): string[] {
    const out: string[] = [];
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...listJsonl(p));
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
    return out;
}

/** The project segment a transcript path belongs to (its dir under ~/.claude/projects). */
export function projectOf(path: string, root: string): string {
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    const seg = rel.split(/[\\/]/).filter(Boolean)[0];
    return seg || "unknown";
}

/** How much of a transcript's tail to read when only its final turn is wanted. */
const TAIL_BYTES = 256 * 1024;

/** The last `bytes` of a file as text, dropping the first (probably partial) line. */
function tail(path: string, bytes: number): string {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return ""; }
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, bytes);
        const buf = Buffer.alloc(length);
        // Decode only what was actually read: a short read would otherwise leave NUL padding on
        // the final line, which is exactly the line the newest message is on.
        const read = readSync(fd, buf, 0, length, size - length);
        const text = buf.subarray(0, read).toString("utf8");
        return length < size ? text.slice(text.indexOf("\n") + 1) : text;
    } catch { return ""; }
    finally { closeSync(fd); }
}

/**
 * How much of a transcript `userTyped` reads. Generous, because the question it answers is
 * about ABSENCE and a window that stopped short would answer it wrongly - hence the null below
 * rather than a larger constant.
 */
const SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Whether the USER typed `needle` anywhere in this transcript.
 *
 * Returns null - never false - when the file could not be read WHOLE, because the one caller
 * uses a false to conclude that a value came from nowhere, and an unread prefix is not evidence
 * of that. Only genuine `text` blocks count: a tool_result is content this session produced,
 * not something the user supplied, and reading one as a source would let a value the agent
 * invented three turns ago vouch for itself.
 */
export function userTyped(transcriptPath: string, needle: string): boolean | null {
    if (!needle) return null;
    let raw: string;
    try {
        if (statSync(transcriptPath).size > SCAN_BYTES) return null;
        raw = readFileSync(transcriptPath, "utf8");
    } catch { return null; }
    const wanted = needle.toLowerCase();
    for (const line of raw.split("\n")) {
        if (!line.includes("\"user\"")) continue;
        let entry: { message?: { role?: string; content?: unknown; }; };
        try { entry = JSON.parse(line); } catch { continue; }
        const content = entry.message?.role === "user" ? entry.message.content : undefined;
        if (typeof content === "string") { if (content.toLowerCase().includes(wanted)) return true; continue; }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as { type?: string; text?: string; };
            if (b.type !== "text" || typeof b.text !== "string") continue;
            if (b.text.toLowerCase().includes(wanted)) return true;
        }
    }
    return false;
}

/**
 * The text of the final assistant message in a transcript, or "" when there is none.
 *
 * Used as a fallback by the completion gate when a Stop payload does not carry
 * `last_assistant_message`: without it, a change in the payload shape would silently turn
 * the gate into a permanent no-op. Only the tail is read, since a transcript grows without
 * bound but the last turn is always at the end.
 */
export function lastAssistantMessage(transcriptPath: string): string {
    const lines = tail(transcriptPath, TAIL_BYTES).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes("\"assistant\"")) continue;
        let entry: { message?: { role?: string; content?: unknown; }; };
        try { entry = JSON.parse(line); } catch { continue; }
        const message = entry.message;
        if (!message || message.role !== "assistant") continue;
        const content = message.content;
        if (typeof content === "string") { if (content.trim()) return content; continue; }
        if (!Array.isArray(content)) continue;
        const text = content
            .filter((b): b is { type: string; text: string; } => !!b && typeof b === "object" && (b as { type?: string; }).type === "text" && typeof (b as { text?: string; }).text === "string")
            .map((b) => b.text)
            .join("\n")
            .trim();
        if (text) return text;
    }
    return "";
}
