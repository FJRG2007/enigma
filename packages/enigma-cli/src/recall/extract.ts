/**
 * Deterministic transcript -> memory extraction. Reads a coding-agent session transcript
 * and derives structured observations (one per user turn) plus a session summary WITHOUT
 * any LLM call - so it is free, offline, reproducible, and provider-agnostic. The richer,
 * LLM-written observations of the original design are intentionally out of scope here; this
 * captures the durable, mechanically-knowable facts (what was asked, which files were read
 * and changed, what the agent last said).
 *
 * Privacy: <private>...</private> blocks are dropped and any matched secret is redacted
 * (reusing the commit guard's secret matchers) BEFORE anything is stored.
 *
 * Two transcript shapes are parsed: Claude Code's JSONL and Codex's rollout JSONL. Both feed
 * the same turn model, so everything after parsing (what is worth storing, redaction, the
 * summary) is one code path. opencode slots in the same way once its format is verified.
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildSecretMatchers, redactSecrets, type SecretMatcher } from "../guard";
import type { Observation, ObservationType, RecallSession, RecallSource, SessionSummary } from "./types";

/** What extracting one transcript yields. `null` when the session held nothing worth storing. */
export interface ExtractResult {
    session: RecallSession;
    observations: Observation[];
    summary: SessionSummary | null;
}

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const MODIFY_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const TITLE_MAX = 90;
const NARRATIVE_MAX = 600;
/** A read-only turn is only worth recording when it read at least this many files (real investigation). */
const NOTABLE_READS = 3;

/** Drop <private>...</private> blocks entirely (never stored). Shared with explicit remember. */
export function stripPrivate(input: string): string {
    return input.replace(/<private>[\s\S]*?<\/private>/gi, " ");
}

/** Strip tag blocks, <private> content, and slash-command noise, then collapse whitespace. */
function cleanText(input: string): string {
    let t = stripPrivate(input);
    // Drop harness/command/meta blocks that are not user intent.
    t = t.replace(/<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-stdout|local-command-stderr|command-message|command-name|command-args|command-contents)>[\s\S]*?<\/\1>/gi, " ");
    t = t.replace(/<[^>]+>/g, " ");
    return t.replace(/\s+/g, " ").trim();
}

/** First non-empty line of a prompt, trimmed to a title length. */
function titleOf(prompt: string, project: string): string {
    const first = prompt.split(/[\n.]/).map((s) => s.trim()).find(Boolean) || `Worked on ${project}`;
    return first.length > TITLE_MAX ? first.slice(0, TITLE_MAX - 1).trimEnd() + "..." : first;
}

/** Infer an observation type from the turn's prompt text and file activity. */
function inferType(prompt: string, modified: number, read: number): ObservationType {
    const p = prompt.toLowerCase();
    const has = (...words: string[]): boolean => words.some((w) => p.includes(w));
    if (has("security", "vulnerab", "secret", "credential", "auth bypass")) return "security";
    if (modified > 0) {
        if (has("fix", "bug", "error", "crash", "broken", "regression")) return "bugfix";
        if (has("refactor", "rename", "cleanup", "clean up", "simplif", "dedup")) return "refactor";
        if (has("add", "implement", "create", "feature", "support", "new ")) return "feature";
        return "change";
    }
    if (has("decide", "decision", "choose", "should we", "approach", "design")) return "decision";
    if (read > 0 || has("how", "why", "what", "where", "investigate", "explain", "find")) return "discovery";
    return "discovery";
}

/** Concepts derived from touched files: directory names + extensions, deduped and capped. */
function conceptsFrom(files: string[]): string[] {
    const out = new Set<string>();
    for (const f of files) {
        const parts = f.split(/[\\/]/).filter(Boolean);
        const name = parts[parts.length - 1] || "";
        const dir = parts[parts.length - 2];
        if (dir && dir.length <= 20) out.add(dir.toLowerCase());
        const ext = name.includes(".") ? name.split(".").pop()! : "";
        if (ext && ext.length <= 5) out.add(ext.toLowerCase());
    }
    return [...out].slice(0, 8);
}

function hash(...parts: string[]): string {
    return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 16);
}

/**
 * A user prompt is meaningful if, once cleaned, it carries real intent. Rejects the harness
 * noise that arrives as type:"user" but is not the human asking: compaction/continuation
 * markers, caveat banners, and content carrying tool-use ids (a leaked tool_result, never a
 * real prompt).
 */
function isMeaningfulPrompt(cleaned: string): boolean {
    if (cleaned.length < 3) return false;
    if (/^caveat\b/i.test(cleaned)) return false;
    if (/^this session is being continued/i.test(cleaned)) return false;
    if (/\btoolu_[A-Za-z0-9]{6,}/.test(cleaned)) return false;
    return true;
}

interface Turn {
    prompt: string;
    promptNumber: number;
    ts: number;
    text: string[];
    read: Set<string>;
    modified: Set<string>;
    commands: number;
}

/** Pull a file path out of a tool_use input across the known field names. */
function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
    if (!input) return undefined;
    const v = input.file_path ?? input.notebook_path ?? input.path;
    return typeof v === "string" ? v : undefined;
}

/** Shorten an absolute path to something project-relative-ish for compact storage. */
function tidyPath(p: string, cwd: string): string {
    if (cwd && p.startsWith(cwd)) return p.slice(cwd.length).replace(/^[\\/]/, "");
    return p;
}

/**
 * Parse a Claude Code JSONL transcript into a session + per-turn observations + a summary.
 * Returns null when the file has no meaningful turns (so empty/aborted sessions are skipped).
 */
export function extractSession(path: string, source: RecallSource = "claude", matchers: SecretMatcher[] = buildSecretMatchers()): ExtractResult | null {
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { return null; }

    const fileId = basename(path).replace(/\.jsonl$/, "");
    let sessionId = fileId;
    let cwd = "";
    let project = "";
    let startedAt = 0;
    let endedAt = 0;
    let promptCounter = 0;
    const turns: Turn[] = [];
    let current: Turn | null = null;

    const pushCurrent = (): void => { if (current && (current.modified.size || current.read.size || current.text.length || isMeaningfulPrompt(current.prompt))) turns.push(current); };

    for (const line of raw.split("\n")) {
        if (!line) continue;
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(line); } catch { continue; }
        const type = rec.type;
        if (typeof rec.sessionId === "string") sessionId = rec.sessionId;
        if (typeof rec.cwd === "string" && rec.cwd) { cwd = rec.cwd; if (!project) project = basename(cwd); }
        const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
        if (!Number.isNaN(ts)) { if (!startedAt) startedAt = ts; endedAt = Math.max(endedAt, ts); }

        const msg = rec.message as Record<string, unknown> | undefined;
        const content = msg?.content;

        if (type === "user" && typeof content === "string" && !rec.isMeta) {
            const cleaned = cleanText(content);
            if (!isMeaningfulPrompt(cleaned)) continue;
            pushCurrent();
            current = { prompt: cleaned, promptNumber: ++promptCounter, ts: Number.isNaN(ts) ? endedAt : ts, text: [], read: new Set(), modified: new Set(), commands: 0 };
            continue;
        }

        if (type === "assistant" && Array.isArray(content)) {
            current ??= { prompt: "", promptNumber: ++promptCounter, ts: Number.isNaN(ts) ? endedAt : ts, text: [], read: new Set(), modified: new Set(), commands: 0 };
            for (const item of content as Record<string, unknown>[]) {
                if (!item || typeof item.type !== "string") continue;
                if (item.type === "text" && typeof item.text === "string") {
                    const cleaned = cleanText(item.text);
                    if (cleaned) current.text.push(cleaned);
                } else if (item.type === "tool_use" && typeof item.name === "string") {
                    const name = item.name;
                    const fp = filePathOf(item.input as Record<string, unknown> | undefined);
                    if (fp && MODIFY_TOOLS.has(name)) current.modified.add(tidyPath(fp, cwd));
                    else if (fp && READ_TOOLS.has(name)) current.read.add(tidyPath(fp, cwd));
                    else if (name === "Bash" || name === "PowerShell") current.commands++;
                }
            }
        }
    }
    pushCurrent();
    return assemble({ turns, sessionId, project, cwd, startedAt, endedAt, source, matchers });
}

/** What a parser hands to `assemble`: the turns plus the session's identity and span. */
interface ParsedSession {
    turns: Turn[];
    sessionId: string;
    project: string;
    cwd: string;
    startedAt: number;
    endedAt: number;
    source: RecallSource;
    matchers: SecretMatcher[];
}

/**
 * Turn parsed turns into stored memory: one observation per turn that did durable work, a
 * session row, and a summary. Shared by every transcript parser, so a new agent only has to
 * produce turns.
 */
function assemble(parsed: ParsedSession): ExtractResult | null {
    const { turns, sessionId, cwd, source, matchers } = parsed;
    let { project, startedAt, endedAt } = parsed;
    if (!turns.length) return null;
    if (!project) project = basename(cwd) || "unknown";
    if (!startedAt) startedAt = Date.now();

    const redact = (s: string): string => redactSecrets(s, matchers).text;
    const observations: Observation[] = [];
    const allModified = new Set<string>();

    for (const turn of turns) {
        const modified = [...turn.modified];
        const read = [...turn.read];
        modified.forEach((f) => allModified.add(f));
        // Only store a turn that did durable, recallable work - files changed, or a real
        // investigation (several files read). Plain chatter, one-line acknowledgements and
        // trivial prompts produce no observation (the per-session summary still captures the
        // session). This is the deterministic stand-in for "is this worth remembering?".
        if (modified.length === 0 && read.length < NOTABLE_READS) continue;
        const promptR = redact(turn.prompt);
        const title = redact(titleOf(promptR, project));
        const type = inferType(turn.prompt, modified.length, read.length);
        const narrative = turn.text.length ? redact(turn.text[turn.text.length - 1]!).slice(0, NARRATIVE_MAX) : undefined;
        const facts: string[] = [];
        if (modified.length) facts.push(`Modified ${modified.length} file${modified.length === 1 ? "" : "s"}`);
        if (read.length) facts.push(`Read ${read.length} file${read.length === 1 ? "" : "s"}`);
        if (turn.commands) facts.push(`Ran ${turn.commands} command${turn.commands === 1 ? "" : "s"}`);
        observations.push({
            sessionId, project, source, type, title,
            subtitle: promptR && promptR !== title ? promptR.slice(0, TITLE_MAX * 2) : undefined,
            narrative,
            facts,
            concepts: conceptsFrom([...modified, ...read]),
            filesRead: read.map(redact),
            filesModified: modified.map(redact),
            promptNumber: turn.promptNumber,
            contentHash: hash(sessionId, String(turn.promptNumber), title, modified.sort().join(",")),
            createdAt: turn.ts || startedAt,
        });
    }

    const firstPrompt = turns.find((t) => isMeaningfulPrompt(t.prompt))?.prompt;
    const lastText = [...turns].reverse().find((t) => t.text.length)?.text.slice(-1)[0];
    const session: RecallSession = {
        sessionId, project, source,
        title: observations[0]?.title,
        userPrompt: firstPrompt ? redact(firstPrompt).slice(0, 500) : undefined,
        startedAt, endedAt: endedAt || startedAt,
    };
    const summary: SessionSummary = {
        sessionId, project, source,
        request: firstPrompt ? redact(firstPrompt).slice(0, 300) : undefined,
        completed: lastText ? redact(lastText).slice(0, NARRATIVE_MAX) : undefined,
        filesEdited: [...allModified].map(redact).slice(0, 50),
        createdAt: endedAt || startedAt,
    };
    return { session, observations, summary };
}

/** Codex's patch envelope names each file it touches on a header line. */
const CODEX_PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** Codex tool names that run a shell command. */
const CODEX_SHELL_TOOLS = new Set(["exec_command", "shell", "local_shell", "container.exec"]);

/**
 * Parse a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) into the same turns
 * as a Claude transcript. The shape, checked against a real session fixture: a `session_meta`
 * line carries the id and cwd; each user prompt is an `event_msg` of type `user_message`; the
 * agent's prose is `agent_message`; a file edit is an `apply_patch` custom tool call whose
 * input names every file on `*** Update|Add|Delete File:` lines; a shell command is a
 * `function_call` to `exec_command`/`shell`. Developer and reasoning items are not memory.
 */
export function extractCodexSession(path: string, matchers: SecretMatcher[] = buildSecretMatchers()): ExtractResult | null {
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { return null; }

    let sessionId = basename(path).replace(/\.jsonl$/, "");
    let cwd = "";
    let startedAt = 0;
    let endedAt = 0;
    let promptCounter = 0;
    const turns: Turn[] = [];
    let current: Turn | null = null;
    const pushCurrent = (): void => { if (current && (current.modified.size || current.read.size || current.text.length || isMeaningfulPrompt(current.prompt))) turns.push(current); };
    const open = (ts: number): Turn => (current ??= { prompt: "", promptNumber: ++promptCounter, ts, text: [], read: new Set(), modified: new Set(), commands: 0 });

    for (const line of raw.split("\n")) {
        if (!line) continue;
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(line); } catch { continue; }
        const payload = (rec.payload ?? {}) as Record<string, unknown>;
        const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
        if (!Number.isNaN(ts)) { if (!startedAt) startedAt = ts; endedAt = Math.max(endedAt, ts); }
        const at = Number.isNaN(ts) ? endedAt : ts;

        if (rec.type === "session_meta") {
            if (typeof payload.id === "string") sessionId = payload.id;
            if (typeof payload.cwd === "string") cwd = payload.cwd;
        } else if (rec.type === "turn_context") {
            if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
        } else if (rec.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
            const cleaned = cleanText(payload.message);
            if (!isMeaningfulPrompt(cleaned)) continue;
            pushCurrent();
            current = { prompt: cleaned, promptNumber: ++promptCounter, ts: at, text: [], read: new Set(), modified: new Set(), commands: 0 };
        } else if (rec.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string") {
            const cleaned = cleanText(payload.message);
            if (cleaned) open(at).text.push(cleaned);
        } else if (rec.type === "response_item" && payload.type === "custom_tool_call" && payload.name === "apply_patch" && typeof payload.input === "string") {
            const turn = open(at);
            for (const m of payload.input.matchAll(CODEX_PATCH_FILE)) turn.modified.add(tidyPath(m[1]!.trim(), cwd));
        } else if (rec.type === "response_item" && payload.type === "function_call" && typeof payload.name === "string" && CODEX_SHELL_TOOLS.has(payload.name)) {
            open(at).commands++;
        }
    }
    pushCurrent();
    return assemble({ turns, sessionId, project: basename(cwd), cwd, startedAt, endedAt, source: "codex", matchers });
}
