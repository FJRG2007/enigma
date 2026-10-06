/**
 * Handoffs: what one agent session leaves for the next, so a context can be cleared without losing
 * the work.
 *
 * WHY. Every model call re-reads the whole conversation, so a long session pays for its history on
 * each step; measured on one user's projects, the average call re-read 400-550k tokens. Clearing is
 * the cheapest way back to the ~60k base, but it forgets the task. A handoff is the bridge: the
 * agent writes down the goal, the state and the next step, the context is cleared, and the next
 * session starts from that page instead of from the transcript. The same shape is what the
 * Ralph-style loops (snarktank/ralph, open-ralph-wiggum) and the Claude Code handoff hooks
 * (set-claude-handoff, cc-clear-handoff) converged on: a file, then a fresh context that reads it.
 *
 * ONE HANDOFF PER PROJECT, stored outside the repo (~/.enigma/handoff/<key>.md + .json) so it is
 * never committed, keyed by the git root so a session started in any subdirectory finds it. It is
 * delivered ONCE: the session that picks it up marks it consumed, so a later unrelated session in
 * the same project does not resume yesterday's task. A handoff older than MAX_AGE_MS is stale and
 * never delivered.
 */

import { enigmaHome } from "./util";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** A handoff is a page, not a transcript: anything past this is the agent pasting history. */
export const MAX_HANDOFF_BYTES = 32 * 1024;

/** A handoff older than this is not about the work the user is doing now. */
export const MAX_AGE_MS = 24 * 60 * 60_000;

/** The line a handoff carries when the work it describes is finished: nothing left to resume. */
const DONE_RE = /^\s*status\s*:\s*done\b/im;

/** Set on every `enigma relay` step: the session-start hook leaves that step's context to the relay. */
export const RELAY_STEP_ENV = "ENIGMA_RELAY_STEP";

export interface HandoffMeta { savedAt: number; root: string; consumedAt: number | null; done: boolean; }

export interface Handoff extends HandoffMeta { text: string; }

/** The project a directory belongs to: the nearest ancestor holding `.git`, else the directory itself. */
export function projectRoot(dir: string): string {
    let current = resolve(dir);
    for (;;) {
        if (existsSync(join(current, ".git"))) return current;
        const parent = dirname(current);
        if (parent === current) return resolve(dir);
        current = parent;
    }
}

function storeDir(): string {
    return join(enigmaHome(), ".enigma", "handoff");
}

/** `{ root, savedAt, done, text, meta }` of the most recent save in any project. */
export function latestFile(): string {
    return join(storeDir(), "latest.json");
}

/** Stable per-project file stem, case-folded on Windows where `C:\\Repo` and `c:\\repo` are one path. */
function keyOf(root: string): string {
    const normal = process.platform === "win32" ? root.toLowerCase() : root;
    return createHash("sha1").update(normal).digest("hex").slice(0, 12);
}

function paths(dir: string): { root: string; text: string; meta: string; } {
    const root = projectRoot(dir);
    const key = keyOf(root);
    return { root, text: join(storeDir(), `${key}.md`), meta: join(storeDir(), `${key}.json`) };
}

/** Save the handoff for the project containing `dir`. Throws on an empty or oversized page. */
export function saveHandoff(dir: string, text: string, now = Date.now()): Handoff {
    const body = text.replace(/^\uFEFF/, "").trim();
    if (!body) throw new Error("the handoff is empty - write the goal, what is done, what is next and how to verify it");
    if (Buffer.byteLength(body) > MAX_HANDOFF_BYTES) throw new Error(`the handoff is over ${MAX_HANDOFF_BYTES / 1024} KB - it is a page for the next session, not the transcript`);
    const p = paths(dir);
    mkdirSync(storeDir(), { recursive: true });
    const meta: HandoffMeta = { savedAt: now, root: p.root, consumedAt: null, done: DONE_RE.test(body) };
    writeFileSync(p.text, `${body}\n`);
    writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`);
    // The newest save, at a fixed path: the Claude Code relay mod runs with no shell and no hashing,
    // so it finds the handoff through this pointer rather than by recomputing the project key.
    writeFileSync(latestFile(), `${JSON.stringify({ ...meta, text: p.text, meta: p.meta }, null, 2)}\n`);
    return { ...meta, text: body };
}

/** The project's handoff, or null when there is none (or its files are unreadable). */
export function readHandoff(dir: string): Handoff | null {
    const p = paths(dir);
    try {
        const meta = JSON.parse(readFileSync(p.meta, "utf8")) as HandoffMeta;
        if (typeof meta.savedAt !== "number") return null;
        return { savedAt: meta.savedAt, root: p.root, consumedAt: typeof meta.consumedAt === "number" ? meta.consumedAt : null, done: meta.done === true, text: readFileSync(p.text, "utf8").trim() };
    } catch {
        return null;
    }
}

/** The handoff a new session should resume from, or null: none, already delivered, stale, or finished. */
export function pendingHandoff(dir: string, now = Date.now()): Handoff | null {
    const h = readHandoff(dir);
    if (!h || h.consumedAt !== null || h.done || now - h.savedAt > MAX_AGE_MS) return null;
    return h;
}

/** Mark the project's handoff delivered, so no later session resumes it again. */
export function consumeHandoff(dir: string, now = Date.now()): void {
    const h = readHandoff(dir);
    if (!h) return;
    const { text: _text, ...meta } = h;
    writeFileSync(paths(dir).meta, `${JSON.stringify({ ...meta, consumedAt: now }, null, 2)}\n`);
}

/** Remove the project's handoff. */
export function clearHandoff(dir: string): boolean {
    const p = paths(dir);
    const had = existsSync(p.meta) || existsSync(p.text);
    rmSync(p.meta, { force: true });
    rmSync(p.text, { force: true });
    return had;
}

/** When the handoff was saved, for messages: "12 min ago". */
export function ageOf(savedAt: number, now = Date.now()): string {
    const min = Math.max(0, Math.round((now - savedAt) / 60_000));
    return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

/** What a new session is told: continue the work, without waiting to be asked. */
export function resumeText(h: Handoff, now = Date.now()): string {
    return [
        `[enigma] Handoff from the previous session in this project (saved ${ageOf(h.savedAt, now)}). That session was cleared to save tokens; this page is everything it left. Continue the work it describes now, starting from its next step, without asking whether to.`,
        "",
        h.text,
    ].join("\n");
}
