/**
 * Real tool-usage observer. Unlike the compression engine (which records what enigma
 * itself compressed), this reads the coding agent's own session transcripts to report
 * the REAL token consumption, the REAL prompt-cache savings, and an estimated USD cost.
 *
 * Honesty boundary: a transcript records what WAS used, never the counterfactual. So this
 * never attributes savings to a skill or to output-style (there is no baseline of "what it
 * would have cost without them" in the log). It reports only measured facts: input/output
 * tokens consumed, cache-read tokens (a genuine saving the tool made via prompt caching),
 * and an ESTIMATED cost from a per-model price table (real spend is billed by Anthropic).
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
import { join, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readConfig } from "./config";

/** Per-model price in USD per MILLION tokens. Ported from references/repos/claude-usage. */
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number; }

/**
 * USD per 1M tokens, by exact model id. Anthropic does not expose per-message cost in the
 * transcript, so cost is an ESTIMATE from this table; unknown models cost 0 (e.g. a
 * subscription-only or future id). Cache-read is far cheaper than fresh input, cache-write
 * (5m TTL creation) a touch dearer - the table reflects that.
 */
export const PRICING: Record<string, ModelPrice> = {
    "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
    "claude-mythos-5": { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
    "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-sonnet-4-7": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-haiku-4-7": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-haiku-4-6": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Per-model price, matched exactly then by family prefix (opus/sonnet/haiku), else null. */
export function priceFor(model: string): ModelPrice | null {
    if (PRICING[model]) return PRICING[model];
    const m = model.toLowerCase();
    if (m.includes("opus")) return PRICING["claude-opus-4-8"];
    if (m.includes("sonnet")) return PRICING["claude-sonnet-4-6"];
    if (m.includes("haiku")) return PRICING["claude-haiku-4-5"];
    return null;
}

/** Estimated USD cost of one message's token counts under its model's price. */
export function costOf(model: string, b: { input: number; output: number; cacheRead: number; cacheCreation: number }): number {
    const p = priceFor(model);
    if (!p) return 0;
    return b.input * p.input / 1e6 + b.output * p.output / 1e6 + b.cacheRead * p.cacheRead / 1e6 + b.cacheCreation * p.cacheWrite / 1e6;
}

/** Token counts (and estimated cost) for one bucket (a day, hour, model, project, or total). */
export interface UsageBucket {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    messages: number;
    /** Estimated USD cost from the per-model price table. */
    cost: number;
}

/** One recent session row (newest first) for the dashboard/TUI tables. */
export interface SessionRow {
    id: string;
    project: string;
    lastActive: number;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    messages: number;
    cost: number;
}

/**
 * One usage "window" mirroring Claude Code's own UI gauges: the current session (5h),
 * the weekly all-models window, and the weekly per-model (Sonnet) window. `pct` is null
 * when no plan limit is configured (we read transcripts, not Anthropic's API, so we never
 * fabricate a percentage - the card shows tokens used instead).
 */
export interface UsageWindow {
    label: string;
    kind: "session" | "weekly";
    used: number;
    cost: number;
    /** Configured plan token limit, 0 = unset. */
    limit: number;
    /** used/limit*100 (capped 100), or null when limit is unset. */
    pct: number | null;
    /** epoch ms the window resets; 0 = no active window. */
    resetsAt: number;
}

export interface UsageWindows { session: UsageWindow; weeklyAll: UsageWindow; weeklySonnet: UsageWindow; }

/** The current Claude billing-style 5-hour block, computed locally from transcript timestamps. */
export interface UsageBlock {
    /** True while now < endsAt (the window is still open). */
    active: boolean;
    /** epoch ms the block started (first message of the block). */
    startedAt: number;
    /** epoch ms the block ends (startedAt + 5h). */
    endsAt: number;
    /** Total tokens (input+output+cache) used in the block so far. */
    tokens: number;
    /** Estimated USD cost in the block so far. */
    cost: number;
    /** Tokens per minute over the block's elapsed time. */
    burnRatePerMin: number;
    /** Projected tokens by the end of the block at the current burn rate. */
    projectedTokens: number;
    /** Projected USD cost by the end of the block. */
    projectedCost: number;
}

export interface UsageReport extends UsageBucket {
    /** Per-UTC-day totals, keyed YYYY-MM-DD. */
    byDay: Record<string, UsageBucket>;
    /** Per-model totals, keyed by the model id the transcript recorded. */
    byModel: Record<string, UsageBucket>;
    /** Per-project totals, keyed by the ~/.claude/projects/<project> directory name. */
    byProject: Record<string, UsageBucket>;
    /** Per-UTC-hour-of-day totals, keyed "00".."23" (an average-day distribution). */
    byHour: Record<string, UsageBucket>;
    /** The newest sessions (top-level files), newest first, capped. */
    recentSessions: SessionRow[];
    /** The current 5-hour block, or null when there is no recent activity. */
    block: UsageBlock | null;
    /** Claude-style usage gauges: current session + weekly (all models / Sonnet only). */
    windows: UsageWindows;
    /** Number of top-level session files scanned (subagent files excluded from the count). */
    sessions: number;
    /** Total JSONL files aggregated (including subagent transcripts, which consume tokens too). */
    scannedFiles: number;
    /** epoch ms the report was built. */
    generatedAt: number;
}

/** One timestamped activity sample used to reconstruct the 5-hour block locally. */
interface UsageEvent { t: number; tok: number; cost: number; }

/** Cached aggregate for one file, reused while its (mtime, size) is unchanged. */
interface FileAgg {
    mtime: number;
    size: number;
    byDay: Record<string, UsageBucket>;
    byModel: Record<string, UsageBucket>;
    byHour: Record<string, UsageBucket>;
    /** Per-day, per-model-family buckets (for the weekly per-model windows). */
    byDayModel: Record<string, Record<string, UsageBucket>>;
    total: UsageBucket;
    lastActive: number;
    /** Recent activity samples (capped) for the 5-hour-block reconstruction. */
    events: UsageEvent[];
    sessionFile: boolean;
}

/** Coarse model family for the per-model weekly window (opus covers fable/mythos). */
function familyOf(model: string): string {
    const m = model.toLowerCase();
    if (m.includes("opus") || m.includes("fable") || m.includes("mythos")) return "opus";
    if (m.includes("sonnet")) return "sonnet";
    if (m.includes("haiku")) return "haiku";
    return "other";
}

const USAGE_TTL_MS = 20_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
/** Cap events per file so the cache stays small; only the most recent matter for the block. */
const EVENTS_PER_FILE = 400;
const RECENT_SESSIONS = 20;

function claudeProjectsDir(): string {
    return process.env.ENIGMA_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
}

function cacheFile(): string {
    return join(homedir(), ".enigma", "usage-cache.json");
}

function emptyBucket(): UsageBucket {
    return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, messages: 0, cost: 0 };
}

function emptyWindow(label: string, kind: "session" | "weekly"): UsageWindow {
    return { label, kind, used: 0, cost: 0, limit: 0, pct: null, resetsAt: 0 };
}

function emptyWindows(): UsageWindows {
    return { session: emptyWindow("Current session", "session"), weeklyAll: emptyWindow("All models", "weekly"), weeklySonnet: emptyWindow("Sonnet only", "weekly") };
}

function emptyReport(): UsageReport {
    return { ...emptyBucket(), byDay: {}, byModel: {}, byProject: {}, byHour: {}, recentSessions: [], block: null, windows: emptyWindows(), sessions: 0, scannedFiles: 0, generatedAt: Date.now() };
}

/** Add `b` into `a` in place. */
function foldBucket(a: UsageBucket, b: UsageBucket): void {
    a.input += b.input; a.output += b.output;
    a.cacheRead += b.cacheRead; a.cacheCreation += b.cacheCreation;
    a.messages += b.messages; a.cost += b.cost;
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

/** The dominant model in a per-model map (most messages), or "unknown". */
function topModel(byModel: Record<string, UsageBucket>): string {
    let best = "unknown", bestN = -1;
    for (const [model, b] of Object.entries(byModel)) if (b.messages > bestN) { best = model; bestN = b.messages; }
    return best;
}

/** The project segment a transcript path belongs to (its dir under ~/.claude/projects). */
function projectOf(path: string, root: string): string {
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    const seg = rel.split(/[\\/]/).filter(Boolean)[0];
    return seg || "unknown";
}

/**
 * Aggregate one Claude Code session file into per-day/model/hour buckets, a file total,
 * the last-active time and a capped recent-event list. Counts only assistant messages
 * carrying `message.usage`, de-duplicated by `message.id` within the file so a
 * streamed-then-final or retried message is not double-counted.
 */
function aggregateFile(path: string): Omit<FileAgg, "mtime" | "size" | "sessionFile"> {
    const byDay: Record<string, UsageBucket> = {};
    const byModel: Record<string, UsageBucket> = {};
    const byHour: Record<string, UsageBucket> = {};
    const byDayModel: Record<string, Record<string, UsageBucket>> = {};
    const total = emptyBucket();
    const events: UsageEvent[] = [];
    let lastActive = 0;
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { return { byDay, byModel, byHour, byDayModel, total, lastActive, events }; }
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
        const hour = ts.slice(11, 13) || "??";
        const model = typeof msg.model === "string" ? msg.model : "unknown";
        const b: UsageBucket = {
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            messages: 1,
            cost: 0,
        };
        b.cost = costOf(model, b);
        foldInto(byDay, day, b);
        foldInto(byModel, model, b);
        if (hour !== "??") foldInto(byHour, hour, b);
        foldInto((byDayModel[day] ??= {}), familyOf(model), b);
        foldBucket(total, b);
        const tms = ts ? Date.parse(ts) : NaN;
        if (!Number.isNaN(tms)) {
            lastActive = Math.max(lastActive, tms);
            events.push({ t: tms, tok: b.input + b.output + b.cacheRead + b.cacheCreation, cost: b.cost });
        }
    }
    // Keep only the most recent events (the block reconstruction only needs the tail).
    if (events.length > EVENTS_PER_FILE) { events.sort((a, c) => a.t - c.t); events.splice(0, events.length - EVENTS_PER_FILE); }
    return { byDay, byModel, byHour, byDayModel, total, lastActive, events };
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
 * Reconstruct the current 5-hour block from recent activity. Events are grouped into
 * 5h windows that reset on a >5h inactivity gap or once 5h elapse from the block start
 * (the same shape Claude bills on); the LAST window is the current block. Burn rate is
 * tokens/min over the elapsed time, and the projection extends it to the window end.
 */
function computeBlock(events: UsageEvent[], now: number): UsageBlock | null {
    if (!events.length) return null;
    events.sort((a, b) => a.t - b.t);
    let start = events[0]!.t, last = events[0]!.t, tokens = 0, cost = 0;
    for (const e of events) {
        if (e.t - start >= FIVE_HOURS_MS || e.t - last >= FIVE_HOURS_MS) { start = e.t; tokens = 0; cost = 0; }
        tokens += e.tok; cost += e.cost; last = e.t;
    }
    const endsAt = start + FIVE_HOURS_MS;
    const active = now < endsAt;
    const elapsedMin = Math.max(1, (Math.min(now, last) - start) / 60000);
    const burn = tokens / elapsedMin;
    const remainMin = active ? (endsAt - now) / 60000 : 0;
    const projectedTokens = Math.round(tokens + burn * remainMin);
    const costPerTok = tokens > 0 ? cost / tokens : 0;
    return { active, startedAt: start, endsAt, tokens, cost, burnRatePerMin: burn, projectedTokens, projectedCost: cost + costPerTok * burn * remainMin };
}

const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * The current weekly window from a "<weekday> HH:MM" local-time spec (e.g. "mon 11:00"):
 * the most recent past occurrence of that weekday/time, plus the next one (the reset). The
 * start date string is local, compared against the UTC day keys of byDay - a sub-day skew
 * at the boundary is acceptable for a weekly gauge.
 */
function weeklyAnchor(spec: string, now: number): { startDay: string; nextMs: number } {
    const m = /^([a-z]{3})\s+(\d{1,2}):(\d{2})$/.exec((spec || "").trim().toLowerCase());
    const wd = m && m[1]! in WEEKDAYS ? WEEKDAYS[m[1]!]! : 1;
    const hh = m ? Math.min(23, Number(m[2])) : 0;
    const mm = m ? Math.min(59, Number(m[3])) : 0;
    const start = new Date(now);
    start.setHours(hh, mm, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() - wd + 7) % 7));
    if (start.getTime() > now) start.setDate(start.getDate() - 7);
    const next = new Date(start.getTime());
    next.setDate(next.getDate() + 7);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const startDay = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    return { startDay, nextMs: next.getTime() };
}

/** Build the Claude-style usage gauges from the per-day-family map, the block and the config. */
function computeWindows(byDayModel: Record<string, Record<string, UsageBucket>>, block: UsageBlock | null, now: number): UsageWindows {
    const cfg = readConfig().config;
    const pctOf = (used: number, limit: number): number | null => limit > 0 ? Math.min(100, used / limit * 100) : null;
    const session: UsageWindow = {
        label: "Current session", kind: "session",
        used: block ? block.tokens : 0,
        cost: block ? block.cost : 0,
        limit: cfg.planSessionLimit || 0,
        pct: pctOf(block ? block.tokens : 0, cfg.planSessionLimit || 0),
        resetsAt: block && block.active ? block.endsAt : 0,
    };
    const { startDay, nextMs } = weeklyAnchor(cfg.planWeeklyReset, now);
    let allTok = 0, allCost = 0, sonTok = 0, sonCost = 0;
    for (const [day, fams] of Object.entries(byDayModel)) {
        if (day < startDay) continue; // only days within the current weekly window
        for (const [fam, b] of Object.entries(fams)) {
            const t = b.input + b.output + b.cacheRead + b.cacheCreation;
            allTok += t; allCost += b.cost;
            if (fam === "sonnet") { sonTok += t; sonCost += b.cost; }
        }
    }
    return {
        session,
        weeklyAll: { label: "All models", kind: "weekly", used: allTok, cost: allCost, limit: cfg.planWeeklyLimit || 0, pct: pctOf(allTok, cfg.planWeeklyLimit || 0), resetsAt: nextMs },
        weeklySonnet: { label: "Sonnet only", kind: "weekly", used: sonTok, cost: sonCost, limit: cfg.planWeeklySonnetLimit || 0, pct: pctOf(sonTok, cfg.planWeeklySonnetLimit || 0), resetsAt: nextMs },
    };
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
    const now = Date.now();
    const blockEvents: UsageEvent[] = [];
    const sessionRows: SessionRow[] = [];
    const byDayModel: Record<string, Record<string, UsageBucket>> = {};
    for (const path of files) {
        let st: import("node:fs").Stats;
        try { st = statSync(path); } catch { continue; }
        const sessionFile = !path.replace(/\\/g, "/").includes("/subagents/");
        const hit = prev[path];
        const agg: FileAgg = (hit && hit.mtime === st.mtimeMs && hit.size === st.size && Array.isArray(hit.events) && hit.byDayModel)
            ? hit
            : { mtime: st.mtimeMs, size: st.size, sessionFile, ...aggregateFile(path) };
        next[path] = agg;
        for (const [day, b] of Object.entries(agg.byDay)) { foldInto(report.byDay, day, b); foldBucket(report, b); }
        for (const [model, b] of Object.entries(agg.byModel)) foldInto(report.byModel, model, b);
        for (const [hour, b] of Object.entries(agg.byHour)) foldInto(report.byHour, hour, b);
        for (const [day, fams] of Object.entries(agg.byDayModel)) for (const [fam, b] of Object.entries(fams)) foldInto((byDayModel[day] ??= {}), fam, b);
        foldInto(report.byProject, projectOf(path, root + sep), agg.total);
        report.scannedFiles++;
        if (agg.sessionFile) {
            report.sessions++;
            if (agg.total.messages > 0) sessionRows.push({
                id: path.split(/[\\/]/).pop()!.replace(/\.jsonl$/, ""),
                project: projectOf(path, root + sep),
                lastActive: agg.lastActive,
                model: topModel(agg.byModel),
                ...agg.total,
            });
        }
        // Only recently-modified files can hold events inside the current 5h window.
        if (st.mtimeMs > now - FIVE_HOURS_MS - 60 * 60 * 1000) blockEvents.push(...agg.events);
    }
    writeCache(next);
    sessionRows.sort((a, b) => b.lastActive - a.lastActive);
    report.recentSessions = sessionRows.slice(0, RECENT_SESSIONS);
    report.block = computeBlock(blockEvents, now);
    report.windows = computeWindows(byDayModel, report.block, now);
    report.generatedAt = now;
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
