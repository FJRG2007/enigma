/**
 * Real tool-usage observer. Unlike the compression engine (which records what enigma
 * itself compressed), this reads the coding agent's own session transcripts to report
 * the REAL token consumption and the REAL prompt-cache savings the tool already achieved.
 *
 * Honesty boundary: a transcript records what WAS used, never the counterfactual. So this
 * never attributes savings to a skill or to output-style (there is no baseline of "what it
 * would have cost without them" in the log). It reports only measured facts: input/output
 * tokens consumed, and cache-read tokens (a genuine saving the tool made via prompt caching).
 *
 * Only Claude Code is read today: it stores per-session JSONL under
 * ~/.claude/projects/<project>/*.jsonl with a per-message `message.usage`. Codex and
 * OpenCode use undocumented/absent local session stores, so they are deliberately not
 * guessed - add a reader here when a format is verified rather than improvising one.
 *
 * Reading is consent-gated by the `usageStats` config flag (default off): these are the
 * user's own session transcripts, broader than enigma's own CCR data.
 *
 * Cost control: the corpus can be hundreds of MB, so a per-file aggregate cache keyed by
 * (mtime, size) under ~/.enigma/usage-cache.json means only changed files are re-read, and
 * reads are served stale-while-revalidate so the dashboard request is never blocked.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

/** Token counts for one bucket (a day, a model, or the grand total). */
export interface UsageBucket {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    messages: number;
}

export interface UsageReport extends UsageBucket {
    /** Per-UTC-day totals, keyed YYYY-MM-DD. */
    byDay: Record<string, UsageBucket>;
    /** Per-model totals, keyed by the model id the transcript recorded. */
    byModel: Record<string, UsageBucket>;
    /** Number of top-level session files scanned (subagent files excluded from the count). */
    sessions: number;
    /** Total JSONL files aggregated (including subagent transcripts, which consume tokens too). */
    scannedFiles: number;
    /** epoch ms the report was built. */
    generatedAt: number;
}

/** Cached aggregate for one file, reused while its (mtime, size) is unchanged. */
interface FileAgg {
    mtime: number;
    size: number;
    byDay: Record<string, UsageBucket>;
    byModel: Record<string, UsageBucket>;
    sessionFile: boolean;
}

const USAGE_TTL_MS = 20_000;

function claudeProjectsDir(): string {
    return join(homedir(), ".claude", "projects");
}

function cacheFile(): string {
    return join(homedir(), ".enigma", "usage-cache.json");
}

function emptyBucket(): UsageBucket {
    return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, messages: 0 };
}

function emptyReport(): UsageReport {
    return { ...emptyBucket(), byDay: {}, byModel: {}, sessions: 0, scannedFiles: 0, generatedAt: Date.now() };
}

/** Add `b` into `a` in place. */
function foldBucket(a: UsageBucket, b: UsageBucket): void {
    a.input += b.input; a.output += b.output;
    a.cacheRead += b.cacheRead; a.cacheCreation += b.cacheCreation;
    a.messages += b.messages;
}

/** Add `b` into the bucket at `map[key]`, creating it if absent. */
function foldInto(map: Record<string, UsageBucket>, key: string, b: UsageBucket): void {
    (map[key] ??= emptyBucket());
    foldBucket(map[key], b);
}

/** Recursively list every *.jsonl under `dir` (sessions live nested in subagents/ too). */
function listJsonl(dir: string): string[] {
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

/**
 * Aggregate one Claude Code session file into per-day and per-model buckets. Counts only
 * assistant messages carrying `message.usage`, de-duplicated by `message.id` within the
 * file so a streamed-then-final or retried message is not double-counted.
 */
function aggregateFile(path: string): { byDay: Record<string, UsageBucket>; byModel: Record<string, UsageBucket> } {
    const byDay: Record<string, UsageBucket> = {};
    const byModel: Record<string, UsageBucket> = {};
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { return { byDay, byModel }; }
    const seen = new Set<string>();
    for (const line of raw.split("\n")) {
        // Cheap pre-filter: only assistant lines carry usage; skip the rest before parsing.
        if (!line || !line.includes('"usage"')) continue;
        let rec: Record<string, unknown>;
        try { rec = JSON.parse(line); } catch { continue; }
        const msg = rec.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, number> | undefined;
        if (!msg || !usage || typeof usage.output_tokens !== "number") continue;
        const id = typeof msg.id === "string" ? msg.id : "";
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const ts = typeof rec.timestamp === "string" ? rec.timestamp : "";
        const day = ts.slice(0, 10) || "unknown";
        const model = typeof msg.model === "string" ? msg.model : "unknown";
        const b: UsageBucket = {
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            messages: 1,
        };
        foldInto(byDay, day, b);
        foldInto(byModel, model, b);
    }
    return { byDay, byModel };
}

function readCache(): Record<string, FileAgg> {
    try { return JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, FileAgg>; } catch { return {}; }
}

function writeCache(cache: Record<string, FileAgg>): void {
    const dir = join(homedir(), ".enigma");
    try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(cacheFile(), JSON.stringify(cache));
    } catch { /* cache is best-effort */ }
}

/**
 * Build the usage report from scratch (re-reading only files whose mtime/size changed
 * since the last build). Synchronous and potentially heavy on a cold cache; callers run
 * it off the request path via readUsageCached.
 */
export function buildUsage(): UsageReport {
    const root = claudeProjectsDir();
    const files = listJsonl(root);
    const prev = readCache();
    const next: Record<string, FileAgg> = {};
    const report = emptyReport();
    for (const path of files) {
        let st: import("node:fs").Stats;
        try { st = statSync(path); } catch { continue; }
        const sessionFile = !path.replace(/\\/g, "/").includes("/subagents/");
        const hit = prev[path];
        const agg = (hit && hit.mtime === st.mtimeMs && hit.size === st.size)
            ? hit
            : { mtime: st.mtimeMs, size: st.size, sessionFile, ...aggregateFile(path) };
        next[path] = agg;
        for (const [day, b] of Object.entries(agg.byDay)) { foldInto(report.byDay, day, b); foldBucket(report, b); }
        for (const [model, b] of Object.entries(agg.byModel)) foldInto(report.byModel, model, b);
        report.scannedFiles++;
        if (agg.sessionFile) report.sessions++;
    }
    writeCache(next);
    report.generatedAt = Date.now();
    return report;
}

let memo: { report: UsageReport; expires: number } | null = null;
let building = false;

/**
 * The latest usage report, served stale-while-revalidate: returns the cached report
 * instantly and schedules a background rebuild when it is older than the TTL. The first
 * ever call (cold) returns an empty report with pending=true while the build runs.
 */
export function readUsageCached(): UsageReport & { pending: boolean } {
    const now = Date.now();
    if (memo && now < memo.expires) return { ...memo.report, pending: false };
    if (!building) {
        building = true;
        // Defer off the request path: a cold build re-reads the whole corpus once.
        setTimeout(() => {
            try { memo = { report: buildUsage(), expires: Date.now() + USAGE_TTL_MS }; }
            catch { /* leave the previous memo in place */ }
            finally { building = false; }
        }, 0);
    }
    if (memo) return { ...memo.report, pending: true };
    return { ...emptyReport(), pending: true };
}
