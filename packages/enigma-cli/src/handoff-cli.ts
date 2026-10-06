/**
 * `enigma handoff` and the session-start hook that delivers a handoff to the next session.
 *
 * The hook is one runtime for every host that has a session-start event, because the decision is
 * the same everywhere - deliver a pending handoff once, to a fresh context - and only the envelope
 * differs: Claude Code and Codex read `hookSpecificOutput.additionalContext` from JSON on stdout,
 * Kimi adds plain stdout to the context.
 */

import * as handoff from "./handoff";
import { readFileSync } from "node:fs";

export const HANDOFF_HELP = `usage: enigma handoff <save | show | status | clear>
Hand the work to the next session, so the context can be cleared without losing it.

  save                  read the handoff from stdin (or --file <path>) and keep it for this project
  show                  print the pending handoff
  status [--json]       whether there is one, when it was saved, and whether it was delivered
  clear                 drop it

The next session in this project (after /clear, /new or a new terminal) receives it once and
continues from it. A handoff that says "STATUS: done", or is older than a day, is not delivered.`;

/** Hosts whose session-start hook this runtime answers, and how each reads the answer. */
const JSON_HOSTS = new Set(["claude", "codex"]);

/** Session-start sources that begin a fresh context. `resume` keeps its history; `compact` its summary. */
const FRESH_SOURCES = new Set(["startup", "clear", ""]);

/** Validated subset of a session-start payload. */
interface StartPayload { cwd: string; source: string; }

function parsePayload(raw: string): StartPayload | null {
    let data: unknown;
    try { data = JSON.parse(raw.replace(/^﻿/, "") || "{}"); } catch { return null; }
    if (typeof data !== "object" || data === null) return null;
    const r = data as Record<string, unknown>;
    return { cwd: typeof r.cwd === "string" && r.cwd ? r.cwd : process.cwd(), source: typeof r.source === "string" ? r.source : "" };
}

/**
 * `enigma __handoff-hook <host>`: deliver the project's pending handoff to a session that starts
 * fresh, then mark it delivered. Always exits 0: a missing or unreadable handoff is nothing to say,
 * never a reason to break the session start.
 */
export function runHandoffHook(host: string, raw: string, now = Date.now()): number {
    const payload = parsePayload(raw);
    if (!payload || !FRESH_SOURCES.has(payload.source)) return 0;
    const pending = handoff.pendingHandoff(payload.cwd, now);
    if (!pending) return 0;
    const text = handoff.resumeText(pending, now);
    process.stdout.write(JSON_HOSTS.has(host)
        ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`
        : `${text}\n`);
    handoff.consumeHandoff(payload.cwd, now);
    return 0;
}

/** `enigma handoff ...`. Returns the exit code. */
export function runHandoffCli(argv: string[], cwd = process.cwd()): number {
    const [sub, ...rest] = argv;
    switch (sub) {
        case "save": {
            const at = rest.indexOf("--file");
            let text: string;
            try { text = at >= 0 ? readFileSync(rest[at + 1] ?? "", "utf8") : readFileSync(0, "utf8"); } catch (e) {
                console.error(`enigma handoff: could not read the handoff (${(e as Error).message}).`);
                return 1;
            }
            try {
                const h = handoff.saveHandoff(cwd, text);
                console.log(h.done
                    ? "Handoff saved as finished work (STATUS: done): it will not be resumed."
                    : "Handoff saved. Clear the context (/clear, or /new) and the next session continues from it.");
                return 0;
            } catch (e) {
                console.error(`enigma handoff: ${(e as Error).message}.`);
                return 1;
            }
        }
        case "show": {
            const h = handoff.readHandoff(cwd);
            if (!h) { console.log("No handoff for this project."); return 0; }
            console.log(h.text);
            return 0;
        }
        case "status": {
            const h = handoff.readHandoff(cwd);
            const pending = handoff.pendingHandoff(cwd) !== null;
            if (rest.includes("--json")) {
                console.log(JSON.stringify(h ? { exists: true, pending, savedAt: h.savedAt, consumedAt: h.consumedAt, done: h.done, root: h.root } : { exists: false, pending: false }));
                return 0;
            }
            if (!h) { console.log("No handoff for this project."); return 0; }
            const state = h.done ? "finished (STATUS: done)" : h.consumedAt !== null ? `delivered ${handoff.ageOf(h.consumedAt)}` : pending ? "waiting for the next session" : "stale (over a day old)";
            console.log(`Handoff saved ${handoff.ageOf(h.savedAt)} - ${state}.`);
            return 0;
        }
        case "clear":
            console.log(handoff.clearHandoff(cwd) ? "Handoff removed." : "No handoff for this project.");
            return 0;
        default:
            console.log(HANDOFF_HELP);
            return sub === undefined || sub === "--help" || sub === "-h" ? 0 : 2;
    }
}
