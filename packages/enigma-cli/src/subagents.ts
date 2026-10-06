/**
 * The subagent budget: how many subagents one Claude Code session may run at once, enforced by
 * hooks instead of asked for in prose.
 *
 * WHY A HOOK: the memory kernel already told agents not to fan out (`parallel-subagents`, off by
 * default), and they did anyway - one session launched 82 subagents in a day, another 54, each
 * running 200-1,200 model calls with a 400-550k context, and that burned a weekly plan limit in
 * under three days. A user asking "stop creating so many subagents" changes nothing either. A
 * PreToolUse hook on the Agent tool is the one place a launch can be refused deterministically.
 *
 * THE COUNT IS LOCK-FREE. Each session has a directory under ~/.enigma/subagents/<session>/ with
 * one empty file per running subagent (`run-<agent_id>`, created by SubagentStart and removed by
 * SubagentStop) and one per launch approved but not yet started (`pend-<tool_use_id>`). Parallel
 * Agent calls in one message fire their PreToolUse hooks before any SubagentStart, so a pending
 * file is what makes them count against each other: each hook writes its own, lists the directory,
 * and admits itself only if it is among the first free slots in a deterministic order (mtime, then
 * name). Two racing hooks therefore agree on who goes first without sharing a write. A crashed
 * session leaves files behind, so stale entries expire: a pending one after PENDING_TTL_MS (a launch
 * starts within seconds), a running one after RUNNING_TTL_MS.
 *
 * A SUBAGENT NEVER LAUNCHES SUBAGENTS while a limit is set: every hook payload fired from inside a
 * subagent carries `agent_id`, and nesting is how one task became a tree of full-context workers.
 *
 * SubagentStart also hands each subagent a short brief on spending (one task, small tool output,
 * scripted batch edits), because a subagent inherits none of the main session's conversation and
 * the waste measured was inside the subagents: 87% of one project's model calls.
 */

import { join } from "node:path";
import { enigmaHome } from "./util";
import { readConfigAt } from "./config";
import { mkdirSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";

/** A launch that never started (the call was refused later, or the session died) frees its slot. */
const PENDING_TTL_MS = 2 * 60_000;

/** A subagent whose SubagentStop never arrived (crash, killed terminal) frees its slot. */
const RUNNING_TTL_MS = 6 * 60 * 60_000;

/** Highest limit accepted: past this the setting no longer limits anything a plan can afford. */
export const MAX_SUBAGENT_LIMIT = 20;

/** The tools that launch a subagent, by the names Claude Code has used for it. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** What every subagent is told on start. Kept short: it is paid once per subagent. */
export const SUBAGENT_BRIEF = [
    "enigma: you are a subagent and your whole context is re-read on every call, so spend it carefully:",
    "- do the one task you were given, then stop and return a short report (what changed, what was verified, what remains);",
    "- keep tool output small: filter builds, tests and logs to the failing lines (`| tail -20`, `| grep -E \"error|fail\"`);",
    "- make a mechanical change across many files with one script, not one call per file;",
    "- do not launch subagents.",
].join("\n");

/** The fields of a hook payload this module reads, checked before use. */
export interface SubagentPayload {
    event: string;
    sessionId: string;
    cwd: string;
    toolName: string;
    toolUseId: string;
    agentId: string;
}

/** Validates a hook payload; null when it lacks what the event needs. */
export function parseSubagentPayload(raw: string): SubagentPayload | null {
    let data: unknown;
    try { data = JSON.parse(raw.replace(/^﻿/, "")); } catch { return null; }
    if (typeof data !== "object" || data === null) return null;
    const r = data as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const sessionId = str(r.session_id);
    // The id names a directory, so anything outside a plain token is refused rather than joined.
    if (!/^[\w-]{1,128}$/.test(sessionId)) return null;
    return {
        event: str(r.hook_event_name),
        sessionId,
        cwd: str(r.cwd) || process.cwd(),
        toolName: str(r.tool_name),
        toolUseId: str(r.tool_use_id).replace(/[^\w-]/g, "").slice(0, 128),
        agentId: str(r.agent_id).replace(/[^\w-]/g, "").slice(0, 128),
    };
}

/**
 * Parses the `subagent-limit` value: a whole number of concurrent subagents from 0 (none) to
 * MAX_SUBAGENT_LIMIT, or `off` for no limit (stored as -1).
 */
export function parseSubagentLimit(value: string): number {
    const text = value.trim().toLowerCase();
    if (text === "off" || text === "unlimited") return -1;
    const n = Number(text);
    if (!/^\d+$/.test(text) || n > MAX_SUBAGENT_LIMIT) {
        throw new Error(`expected a number of subagents from 0 to ${MAX_SUBAGENT_LIMIT}, or "off", got "${value}"`);
    }
    return n;
}

/** The per-session directory holding the running and pending markers. */
function sessionDir(sessionId: string): string {
    return join(enigmaHome(), ".enigma", "subagents", sessionId);
}

interface Marker { name: string; mtime: number; }

/** The live markers of a session, oldest first; expired ones are deleted on the way. */
function liveMarkers(dir: string, now: number): Marker[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const live: Marker[] = [];
    for (const name of names) {
        const ttl = name.startsWith("run-") ? RUNNING_TTL_MS : name.startsWith("pend-") ? PENDING_TTL_MS : 0;
        if (!ttl) continue;
        let mtime: number;
        try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
        if (now - mtime > ttl) { rmSync(join(dir, name), { force: true }); continue; }
        live.push({ name, mtime });
    }
    return live.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}

/**
 * Decides an Agent launch. Returns the refusal shown to the model, or "" to let it through.
 * Records the launch as pending when it is admitted.
 */
export function admitLaunch(payload: SubagentPayload, limit: number, now = Date.now()): string {
    if (limit < 0) return "";
    if (limit === 0) return `enigma: subagents are turned off here (subagent-limit 0). Do this part yourself in this conversation. (\`enigma config subagent-limit <n>\` allows some.)`;
    if (payload.agentId) return "enigma: a subagent cannot launch subagents. Do this part yourself, inside your own task.";
    const dir = sessionDir(payload.sessionId);
    const own = `pend-${payload.toolUseId || `${now}-${process.pid}`}`;
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, own), "");
    } catch {
        // No state means no count; refusing every launch over a full disk would be worse.
        return "";
    }
    const live = liveMarkers(dir, now);
    const running = live.filter((m) => m.name.startsWith("run-")).length;
    const queue = live.filter((m) => m.name.startsWith("pend-")).map((m) => m.name);
    const position = queue.indexOf(own);
    const taken = running + (position < 0 ? queue.length : position);
    if (position >= 0 && taken < limit) return "";
    rmSync(join(dir, own), { force: true });
    return `enigma: ${taken} subagent(s) are already running or starting in this session and the limit is ${limit} (\`enigma config subagent-limit\`). Wait for one to finish, or do this part yourself in this conversation.`;
}

/** SubagentStart: the launch is now running - swap its pending slot for a running one. */
export function recordStart(payload: SubagentPayload, now = Date.now()): void {
    if (!payload.agentId) return;
    const dir = sessionDir(payload.sessionId);
    try {
        mkdirSync(dir, { recursive: true });
        const oldest = liveMarkers(dir, now).find((m) => m.name.startsWith("pend-"));
        if (oldest) rmSync(join(dir, oldest.name), { force: true });
        writeFileSync(join(dir, `run-${payload.agentId}`), "");
    } catch { /* the count is best effort; the launch already happened */ }
}

/**
 * SubagentStop: free the slot. Removes the session directory once it is empty, non-recursively, so
 * a marker a concurrent launch just wrote makes the removal fail instead of being deleted with it.
 */
export function recordStop(payload: SubagentPayload, now = Date.now()): void {
    if (!payload.agentId) return;
    const dir = sessionDir(payload.sessionId);
    try {
        rmSync(join(dir, `run-${payload.agentId}`), { force: true });
        if (!liveMarkers(dir, now).length) rmdirSync(dir);
    } catch { /* the count is best effort; a busy or non-empty directory stays */ }
}

/**
 * Hook entry for `enigma __subagent-hook <pre|start|stop>`. Exit 2 with the reason on stderr
 * refuses a PreToolUse call and shows the reason to the model; every unreadable payload lets the
 * call through, since this hook must never break an unrelated tool call.
 */
export function runSubagentHook(phase: string, raw: string): number {
    const payload = parseSubagentPayload(raw);
    if (!payload) return 0;
    let limit: number;
    try { limit = readConfigAt(payload.cwd).subagentLimit; } catch { return 0; }
    if (phase === "pre") {
        if (!AGENT_TOOLS.has(payload.toolName)) return 0;
        const refusal = admitLaunch(payload, limit);
        if (!refusal) return 0;
        process.stderr.write(`${refusal}\n`);
        return 2;
    }
    if (phase === "start") {
        recordStart(payload);
        if (limit >= 0) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: SUBAGENT_BRIEF } })}\n`);
        return 0;
    }
    if (phase === "stop") recordStop(payload);
    return 0;
}
