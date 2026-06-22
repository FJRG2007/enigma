/**
 * Real tool-usage observer: aggregates Claude Code session transcripts into per-day and
 * per-model token totals, counts only assistant messages carrying usage, de-duplicates by
 * message id within a file, distinguishes session files from subagent transcripts, and
 * reuses an mtime/size cache so unchanged files are not re-read. Temp HOME (set BEFORE
 * import) isolates ~/.claude and ~/.enigma, resolved lazily per call.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-usage-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// Pin the transcript dir explicitly: under bun on Linux os.homedir() does not reflect a
// runtime-reassigned $HOME, so the override (not homedir()) makes the test deterministic.
process.env.ENIGMA_CLAUDE_PROJECTS = join(HOME, ".claude", "projects");

const { buildUsage } = await import("../src/usage");

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
