/**
 * Real tool-usage observer: aggregates Claude Code session transcripts into per-day and
 * per-model token totals, counts only assistant messages carrying usage, de-duplicates by
 * message id within a file, distinguishes session files from subagent transcripts, and
 * reuses an mtime/size cache so unchanged files are not re-read. Temp HOME (set BEFORE
 * import) isolates ~/.claude and ~/.enigma, resolved lazily per call.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-usage-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// Pin the transcript dir explicitly: under bun on Linux os.homedir() does not reflect a
// runtime-reassigned $HOME, so the override (not homedir()) makes the test deterministic.
process.env.ENIGMA_CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
// Isolate the proxy stats/limits dir too (bun-linux os.homedir() ignores a runtime $HOME).
process.env.ENIGMA_PROXY_DIR = join(HOME, ".enigma", "proxy");

const { buildUsage, costOf, priceFor } = await import("../src/usage");
const { setEnigmaValue } = await import("../src/config");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const projDir = join(HOME, ".claude", "projects", "proj-a");
const subDir = join(projDir, "sess1", "subagents");

function assistant(ts: string, id: string, model: string, u: Record<string, number>): string {
    return JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, role: "assistant", usage: u } });
}

test("aggregates real usage, dedupes by id, and splits sessions from subagents", () => {
    mkdirSync(projDir, { recursive: true });
    mkdirSync(subDir, { recursive: true });

    const lines = [
        // non-usage lines are skipped by the cheap pre-filter
        JSON.stringify({ type: "user", timestamp: "2026-06-01T10:00:00Z", message: { role: "user", content: "hi" } }),
        assistant("2026-06-01T10:00:01Z", "msg_1", "claude-opus-4-8", { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 }),
        // duplicate id (streamed-then-final / retry) must not double-count
        assistant("2026-06-01T10:00:01Z", "msg_1", "claude-opus-4-8", { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 }),
        assistant("2026-06-02T09:00:00Z", "msg_2", "claude-sonnet-4-6", { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ];
    writeFileSync(join(projDir, "sess1.jsonl"), lines.join("\n") + "\n");
    // a subagent transcript: counts toward tokens but not the session count
    writeFileSync(join(subDir, "agent-x.jsonl"), assistant("2026-06-02T09:05:00Z", "msg_3", "claude-opus-4-8", { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n");

    const r = buildUsage();

    // Grand totals: msg_1 (once) + msg_2 + msg_3.
    expect(r.input).toBe(100 + 50 + 7);
    expect(r.output).toBe(20 + 10 + 3);
    expect(r.cacheRead).toBe(5000);
    expect(r.cacheCreation).toBe(200);
    expect(r.messages).toBe(3);

    // Two files scanned, one of them a session file (the subagent transcript is not).
    expect(r.scannedFiles).toBe(2);
    expect(r.sessions).toBe(1);

    // Per-day and per-model splits.
    expect(r.byDay["2026-06-01"].output).toBe(20);
    expect(r.byDay["2026-06-02"].output).toBe(10 + 3);
    expect(r.byModel["claude-opus-4-8"].input).toBe(107);
    expect(r.byModel["claude-sonnet-4-6"].input).toBe(50);
});

test("prices per model and reconstructs an active 5-hour block from recent activity", () => {
    expect(priceFor("claude-opus-4-8")!.input).toBe(5);
    expect(priceFor("claude-sonnet-4-6")!.output).toBe(15);
    expect(priceFor("totally-unknown-model")).toBeNull();
    // 1M input tokens of Opus at $5/1M = $5.
    expect(costOf("claude-opus-4-8", { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 })).toBeCloseTo(5, 5);

    const now = Date.now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    const recent = join(HOME, ".claude", "projects", "proj-recent");
    mkdirSync(recent, { recursive: true });
    writeFileSync(join(recent, "live.jsonl"),
        assistant(iso(now - 30 * 60 * 1000), "r1", "claude-opus-4-8", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n"
        + assistant(iso(now - 5 * 60 * 1000), "r2", "claude-opus-4-8", { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n");

    const r = buildUsage();
    expect(r.cost).toBeGreaterThan(0);
    expect(r.byProject["proj-recent"].output).toBe(1300);
    expect(r.recentSessions.some((s) => s.id === "live")).toBe(true);
    expect(r.block).not.toBeNull();
    expect(r.block!.active).toBe(true);
    // The huge gap to the old June fixtures resets the block to just the two recent events.
    expect(r.block!.tokens).toBe(1000 + 500 + 2000 + 800);
    expect(r.block!.burnRatePerMin).toBeGreaterThan(0);
});

test("builds Claude-style usage windows with % against configured plan limits", () => {
    // The recent 'live.jsonl' (2 Opus messages, 4300 tokens) drives the active session +
    // this week's all-models window; the old June fixtures fall outside the weekly window.
    setEnigmaValue("planSessionLimit", 10000, "global");
    setEnigmaValue("planWeeklyLimit", 100000, "global");
    setEnigmaValue("planWeeklySonnetLimit", 50000, "global");
    setEnigmaValue("planWeeklyReset", "mon 00:00", "global");
    try {
        const r = buildUsage();
        expect(r.windows.session.limit).toBe(10000);
        expect(r.windows.session.used).toBe(4300);
        expect(r.windows.session.pct).toBeCloseTo(43, 1);
        expect(r.windows.weeklyAll.used).toBeGreaterThan(0);
        expect(r.windows.weeklyAll.pct).toBeCloseTo(r.windows.weeklyAll.used / 100000 * 100, 3);
        expect(r.windows.weeklyAll.resetsAt).toBeGreaterThan(Date.now());
        // No recent Sonnet activity -> the Sonnet window is empty (the UI shows "not used yet").
        expect(r.windows.weeklySonnet.used).toBe(0);
        expect(r.windows.weeklySonnet.pct).toBe(0);
    } finally {
        for (const k of ["planSessionLimit", "planWeeklyLimit", "planWeeklySonnetLimit"] as const) setEnigmaValue(k, 0, "global");
    }
});

test("overlays Anthropic's real rate-limit windows when the proxy captured them", () => {
    // The proxy persists captured limits here; usage overlays them as the live %/reset.
    const proxyDir = join(HOME, ".enigma", "proxy"); // == ENIGMA_PROXY_DIR set above
    mkdirSync(proxyDir, { recursive: true });
    const limPath = join(proxyDir, "limits.json");
    writeFileSync(limPath, JSON.stringify({
        session: { utilization: 0.33, resetsAt: Date.now() + 3600_000 },
        weekly: { utilization: 0.09, resetsAt: Date.now() + 5 * 86400_000 },
        weeklyOpus: null, weeklySonnet: null, capturedAt: Date.now(),
    }));
    try {
        const r = buildUsage();
        expect(r.windows.session.live).toBe(true);
        expect(r.windows.session.pct).toBeCloseTo(33, 1); // 0.33 -> 33%, no plan limit needed
        expect(r.windows.weeklyAll.live).toBe(true);
        expect(r.windows.weeklyAll.pct).toBeCloseTo(9, 1);
        expect(r.windows.weeklyAll.resetsAt).toBeGreaterThan(Date.now());
    } finally {
        rmSync(limPath, { force: true });
    }
});

test("reads every Claude account (default + managed) and reports provider coverage", () => {
    // A managed account lives under ~/.enigma/claude/<name>/projects - it must be read too.
    const managed = join(homedir(), ".enigma", "claude", "work", "projects", "proj-w");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "w1.jsonl"),
        assistant("2026-06-03T10:00:00Z", "w_1", "claude-opus-4-8", { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) + "\n");
    try {
        const r = buildUsage();
        expect(Object.keys(r.byAccount).sort()).toEqual(["default", "work"]);
        expect(r.byAccount.work.output).toBe(22);
        expect(r.byAccount.default.output).toBeGreaterThan(0);
        expect(r.recentSessions.some((s) => s.account === "work")).toBe(true);

        // Per-account drill-down: each login gets a self-contained sub-report scoped to its
        // own transcripts (totals, models, sessions), not the global figures.
        expect(Object.keys(r.accounts).sort()).toEqual(["default", "work"]);
        expect(r.accounts.work.output).toBe(22);
        expect(r.accounts.work.input).toBe(11);
        expect(r.accounts.work.byModel["claude-opus-4-8"].output).toBe(22);
        expect(r.accounts.work.recentSessions.every((s) => s.account === "work")).toBe(true);
        // The work account alone is far smaller than the global total.
        expect(r.accounts.work.output).toBeLessThan(r.output);
        const claude = r.providers.find((p) => p.tool === "claude")!;
        const codex = r.providers.find((p) => p.tool === "codex")!;
        expect(claude.available).toBe(true);
        expect(codex.available).toBe(false);
    } finally {
        rmSync(join(homedir(), ".enigma", "claude", "work"), { recursive: true, force: true });
    }
});

test("empty when there are no transcripts", () => {
    const empty = mkdtempSync(join(tmpdir(), "enigma-usage-empty-"));
    const prevHome = process.env.HOME, prevProfile = process.env.USERPROFILE, prevProjects = process.env.ENIGMA_CLAUDE_PROJECTS;
    process.env.HOME = empty; process.env.USERPROFILE = empty;
    process.env.ENIGMA_CLAUDE_PROJECTS = join(empty, ".claude", "projects");
    try {
        const r = buildUsage();
        expect(r.scannedFiles).toBe(0);
        expect(r.input).toBe(0);
        expect(Object.keys(r.byModel)).toHaveLength(0);
    } finally {
        process.env.HOME = prevHome; process.env.USERPROFILE = prevProfile; process.env.ENIGMA_CLAUDE_PROJECTS = prevProjects;
        rmSync(empty, { recursive: true, force: true });
    }
});
