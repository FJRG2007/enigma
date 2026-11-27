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

/** The stamps that decide which of several copies of one transcript is the authoritative one. */
export interface TranscriptStamps { size: number; birthtimeMs: number; }

/**
 * Whether `cand` is a better copy of one transcript than `best`.
 *
 * A transcript is append-only, so of two copies the larger holds every turn the smaller does:
 * taking it keeps a session that was mirrored while idle and then continued under its origin
 * from being read as the stale prefix. Copies that agree are settled by creation time rather
 * than by the order the source directories happened to be read in - a copy is made after its
 * origin, so the earlier birthtime is the account the conversation was recorded under. A
 * filesystem reporting no birthtime leaves the first copy seen the winner.
 *
 * Shared deliberately: usage.ts counts the winner and session-share.ts's prune keeps it, and the
 * prune is only safe to delete the losers because both pick the SAME copy. Two implementations
 * would let one drift and start deleting the file the other attributes spend to.
 */
export function outranks(cand: TranscriptStamps, best: TranscriptStamps): boolean {
    if (cand.size !== best.size) return cand.size > best.size;
    if (cand.birthtimeMs > 0 && best.birthtimeMs > 0) return cand.birthtimeMs < best.birthtimeMs;
    return false;
}

/** The project segment a transcript path belongs to (its dir under ~/.claude/projects). */
export function projectOf(path: string, root: string): string {
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    const seg = rel.split(/[\\/]/).filter(Boolean)[0];
    return seg || "unknown";
}

/** How much of a transcript's tail to read when only its final turn is wanted. */
const TAIL_BYTES = 256 * 1024;

/**
 * How much of a transcript's head to read when only its opening records are wanted. Generous
 * because the records that carry a time are not the first ones: a session opens with a few
 * untimed `last-prompt`/`mode`/`permission-mode` lines and a `file-history-snapshot` that can be
 * large, and the first timed record sits behind them.
 */
const HEAD_BYTES = 256 * 1024;

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

/** The first `bytes` of a file as text, dropping the last (probably partial) line. */
function head(path: string, bytes: number): string {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return ""; }
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, bytes);
        const buf = Buffer.alloc(length);
        const read = readSync(fd, buf, 0, length, 0);
        const text = buf.subarray(0, read).toString("utf8");
        return length < size ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
    } catch { return ""; }
    finally { closeSync(fd); }
}

/**
 * When this session began, as epoch milliseconds, or null when it cannot be told.
 *
 * The transcript is the only clock the provenance check shares with the session: it needs to know
 * whether a commit was made while this session was running, and a commit older than the first
 * record is one no evidence in this file can speak for.
 *
 * The first TOP-LEVEL `timestamp` is preferred over the file's own creation time for two reasons:
 * a `file-history-snapshot` carries a NESTED `snapshot.timestamp` that is not the record's time,
 * so the field has to be read off a parsed record rather than matched in the line; and the file is
 * created when the first prompt is submitted, which on a real transcript is over a minute after
 * the SessionStart record it already holds. birthtime is the fallback, and only when the
 * filesystem actually recorded one - a zero would read as "the session began at the epoch", which
 * puts every commit in the repository inside it.
 */
export function sessionStartedAt(transcriptPath: string): number | null {
    let birth: number;
    try { birth = statSync(transcriptPath).birthtimeMs; } catch { return null; }
    for (const line of head(transcriptPath, HEAD_BYTES).split("\n")) {
        if (!line.includes("\"timestamp\"")) continue;
        let entry: { timestamp?: unknown; };
        try { entry = JSON.parse(line); } catch { continue; }
        if (typeof entry.timestamp !== "string") continue;
        const at = Date.parse(entry.timestamp);
        if (Number.isFinite(at)) return at;
    }
    return birth > 0 ? birth : null;
}

/**
 * How much of a transcript `userTyped` reads. Generous, because the question it answers is
 * about ABSENCE and a window that stopped short would answer it wrongly - hence the null below
 * rather than a larger constant.
 */
const SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Harness text that Claude Code stores as a `user` record without a human having written it:
 * slash-command scaffolding, the stdout of a command the agent ran, the report a background or
 * subagent task hands back, and the reminders injected around a real prompt. Close to the block
 * set recall's `cleanText` drops (recall/extract.ts), kept here because this module is the leaf
 * that both the provenance check and recall can depend on (node builtins only, no enigma
 * imports) - but see COMMAND_ARGS below for the one tag the two lists deliberately disagree on.
 *
 * `<task-notification>` is the biggest of them and carries NEITHER flag below: measured over the
 * local transcript corpus it opens 226 user text blocks, more than `<command-name>`'s 208, and
 * not one of them is `isMeta` or `isSidechain`. That count is why a flag check alone was never
 * enough - the body is a report the agent wrote, quoting whatever it just did.
 *
 * These are STRIPPED rather than used to reject the whole record: a genuine prompt routinely
 * carries an appended `<system-reminder>`, so discarding the record would lose what the user
 * really typed, while leaving the block in would let injected text vouch for a value.
 */
const SYNTHETIC_BLOCK = /<(system-reminder|task-notification|local-command-stdout|local-command-stderr|local-command-caveat|command-message|command-name|command-contents)>[\s\S]*?<\/\1>/gi;

/**
 * The one wrapper in the slash-command trio whose content a PERSON typed: `/commit add co-author
 * me@example.org` is stored as `<command-message>`, `<command-name>` and `<command-args>` in one
 * user string, and only the first two are the harness naming the command. Dropping this one with
 * them read a legitimately sourced address as unsourced and denied the turn over a correct commit,
 * which is the direction this check must never fail in - so it is unwrapped and its text kept.
 *
 * This is where the list above diverges from recall's `cleanText`, deliberately: recall summarizes
 * INTENT, for which the arguments are noise, while this module adjudicates PROVENANCE, for which
 * they are the evidence. The two want different answers from the same tag - do not reconcile them.
 */
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/gi;

/**
 * Text this hook itself fed back, which is the one channel that would otherwise let the check
 * clear the exact value it just blocked: the block message quotes the invented address verbatim,
 * Claude Code appends the hook's stderr to the transcript as a `user` record, and the next turn
 * would read it as the user having supplied it. Verified on disk: those records carry
 * `isMeta: true`, but the prefix is matched too so the filter does not rest on one flag.
 */
const HOOK_FEEDBACK = /^\s*(?:\w[\w -]*)?hook feedback:/i;

/** An unclosed synthetic block (a truncated tail), whose opening tag still marks it as not-user. */
const SYNTHETIC_OPEN = /^\s*<(?:system-reminder|task-notification|local-command-(?:stdout|stderr|caveat)|command-(?:message|name|contents))>/i;

/**
 * The part of one user-record text a HUMAN can be said to have written, or "" when none of it
 * is. Strips the harness blocks and drops text that is wholly hook feedback or harness output.
 *
 * The closed blocks come out BEFORE the unclosed-tag test, or a record that merely OPENS with a
 * closed one would be discarded whole - which is exactly how the slash-command shape lost the
 * arguments the user typed, since `<command-message>` leads it and `<command-args>` trails it.
 * After the strip, a leading synthetic tag is genuinely an unclosed block.
 */
function humanText(text: string): string {
    if (HOOK_FEEDBACK.test(text)) return "";
    const kept = text.replace(COMMAND_ARGS, " $1 ").replace(SYNTHETIC_BLOCK, " ");
    return SYNTHETIC_OPEN.test(kept) ? "" : kept;
}

/**
 * Whether the USER typed `needle` anywhere in this transcript.
 *
 * Returns null - never false - when the file could not be read WHOLE, because the one caller
 * uses a false to conclude that a value came from nowhere, and an unread prefix is not evidence
 * of that. Only genuine `text` blocks count: a tool_result is content this session produced,
 * not something the user supplied, and reading one as a source would let a value the agent
 * invented three turns ago vouch for itself.
 *
 * A `user` record is not by itself a person: `isMeta` marks harness-authored text (this hook's
 * own feedback among it), `isSidechain` marks a prompt the agent wrote for a subagent, and the
 * synthetic blocks above are injected around real prompts. All of them are excluded, or any
 * text the agent produced could vouch for a value the agent invented.
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
        for (const text of humanBlocks(line)) if (text.toLowerCase().includes(wanted)) return true;
    }
    return false;
}

/**
 * The text blocks a PERSON wrote in one transcript line, or [] when the line is not a human
 * prompt. A subagent prompt (`isSidechain`) is text the agent wrote, and `isMeta` text is the
 * harness's (including hook feedback); a tool_result is content the session produced. Shared by
 * `userTyped` (provenance) and `recentUserMessages` (handoffs), so both agree on what a user said.
 */
function humanBlocks(line: string): string[] {
    if (!line.includes("\"user\"")) return [];
    let entry: { type?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { role?: string; content?: unknown; }; };
    try { entry = JSON.parse(line); } catch { return []; }
    // Only a `user` record is a prompt: an `api-request-blob` record carries a whole API request,
    // whose user-role messages hold injected skill text and every earlier prompt again.
    if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return [];
    const content = entry.message?.role === "user" ? entry.message.content : undefined;
    if (typeof content === "string") return [humanText(content)];
    if (!Array.isArray(content)) return [];
    const out: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string; };
        if (b.type === "text" && typeof b.text === "string") out.push(humanText(b.text));
    }
    return out;
}

/** How much of a transcript's tail `recentUserMessages` reads: long tool output sits between prompts. */
const RECENT_BYTES = 4 * 1024 * 1024;

/**
 * The last `count` messages the user typed in a transcript, oldest first, harness text stripped.
 *
 * WHY. A handoff written by the model alone summarizes the big task and drops the small asks of
 * the last few turns ("also fix X", "leave Y for later"); carrying the user's own words verbatim
 * is the deterministic part of the bridge, so a cleared session can check each one against Done.
 */
export function recentUserMessages(transcriptPath: string, count: number): string[] {
    const out: string[] = [];
    const lines = tail(transcriptPath, RECENT_BYTES).split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
        const text = humanBlocks(lines[i]!).join("\n").trim();
        if (text) out.push(text);
    }
    return out.reverse();
}

/** A block the user pasted: material they brought in, not words they wrote. */
const PASTED_BLOCK = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/gi;

/**
 * The last `count` prompts a PERSON typed, newest first, with pasted blocks removed.
 *
 * Stricter than recentUserMessages: Claude Code also stores a plugin's prompt (`origin.kind`
 * "plugin", the relay's "context was cleared" message) and a background task's report
 * ("task-notification") as plain user records, and both are in English whatever the user writes.
 * When a record carries an `origin`, only `human` counts; an older transcript without the field
 * falls back to humanBlocks alone.
 */
export function lastHumanPrompts(transcriptPath: string, count: number): string[] {
    const out: string[] = [];
    const lines = tail(transcriptPath, RECENT_BYTES).split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
        const line = lines[i]!;
        const blocks = humanBlocks(line);
        if (!blocks.length) continue;
        let entry: { origin?: { kind?: unknown; }; isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown; };
        try { entry = JSON.parse(line); } catch { continue; }
        // A compaction summary is stored as a user record and is written by the model, in English.
        if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) continue;
        const origin = entry.origin?.kind;
        if (origin !== undefined && origin !== "human") continue;
        const text = blocks.join("\n").replace(PASTED_BLOCK, " ").trim();
        if (text) out.push(text);
    }
    return out;
}

/** A background subagent whose last word was a cut at its turn limit, with nothing done about it since. */
export interface StalledSubagent { id: string; name: string; }

/** One subagent report: the task id and the `Agent "<name>" <outcome>` summary Claude Code writes. */
const AGENT_NOTICE = /<task-notification>[\s\S]*?<task-id>([\w-]+)<\/task-id>[\s\S]*?<summary>Agent "([^"]*)" ([^<]*)<\/summary>/g;

/**
 * Background subagents this session left stopped at their turn limit (`subagent-turns`, the
 * agent definition's maxTurns) and never resumed, oldest first.
 *
 * WHY. The cap stops a subagent with a partial result and Claude Code tells the parent to
 * SendMessage the task id to continue; measured on one project's sessions (2026-11), 23 of 279
 * background agents ended that way with no SendMessage, TaskStop or later report, and the parent
 * went on reporting the work as "still running". Their state is in the transcript only: no hook
 * event fires for a cut subagent (subagents.md). Each agent's LAST event decides: a later report
 * (finished, failed, waiting) replaces the cut, and a SendMessage to it or a TaskStop of it is the
 * parent having acted on it. Only the tail is read, so a cut older than RECENT_BYTES is missed -
 * this check stands down there rather than read a transcript without bound on every stop.
 */
export function stalledSubagents(transcriptPath: string): StalledSubagent[] {
    const last = new Map<string, StalledSubagent | null>();
    for (const line of tail(transcriptPath, RECENT_BYTES).split("\n")) {
        const notice = line.includes("<task-notification>");
        if (!notice && !line.includes("\"tool_use\"")) continue;
        let entry: { type?: unknown; isSidechain?: unknown; message?: { content?: unknown; }; };
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.isSidechain === true) continue;
        const content = entry.message?.content;
        const blocks: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
        for (const block of blocks) {
            if (!block || typeof block !== "object") continue;
            const b = block as { type?: string; text?: unknown; name?: string; input?: Record<string, unknown>; };
            if (entry.type === "assistant" && b.type === "tool_use") {
                const target = b.name === "SendMessage" ? b.input?.to : b.name === "TaskStop" ? b.input?.task_id ?? b.input?.shell_id : undefined;
                if (typeof target === "string" && last.has(target)) last.set(target, null);
                continue;
            }
            // Only a `user` record is a report as it arrived: an api-request-blob replays old ones.
            if (entry.type !== "user" || b.type !== "text" || typeof b.text !== "string" || !notice) continue;
            for (const m of b.text.matchAll(AGENT_NOTICE)) {
                const [, id, name, outcome] = m;
                last.delete(id!);
                last.set(id!, /\bturn limit\b/.test(outcome!) ? { id: id!, name: name! } : null);
            }
        }
    }
    return [...last.values()].filter((a): a is StalledSubagent => a !== null);
}

/** The transcript of one Claude Code session, by id, under any account's projects dir; null when absent. */
export function transcriptOf(sessionId: string): string | null {
    // The id names a file: anything but a plain token could walk out of the projects dir.
    if (!/^[\w-]+$/.test(sessionId)) return null;
    for (const { dir } of claudeProjectsDirs()) {
        let projects: string[];
        try { projects = readdirSync(dir); } catch { continue; }
        for (const project of projects) {
            const path = join(dir, project, `${sessionId}.jsonl`);
            if (existsSync(path)) return path;
        }
    }
    return null;
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
