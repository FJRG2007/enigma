/**
 * Recall (local session memory): deterministic transcript extraction, the SQLite/FTS store,
 * incremental sync, and the MCP tool gating. All isolated to a temp HOME (set BEFORE import):
 * ENIGMA_CONFIG_HOME isolates .enigma.json, ENIGMA_RECALL_DIR the database, and
 * ENIGMA_CLAUDE_PROJECTS the single transcript source so sync counts are deterministic.
 *
 * Test credentials are concatenated at runtime so the repo's own commit guard never flags
 * this file as leaking a real secret.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-recall-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_RECALL_DIR = join(HOME, "recall");
process.env.ENIGMA_CLAUDE_PROJECTS = join(HOME, "projects");

const { extractSession } = await import("../src/recall/extract");
const { openDb, closeDb } = await import("../src/recall/db");
const { localEmbed, cosine } = await import("../src/recall/embed");
const store = await import("../src/recall/store");
const { syncRecall, searchRecall, recallStatus, enrichRecall } = await import("../src/recall");
const { setEnigmaValue } = await import("../src/config");
const { handleMcpRequest } = await import("../src/mcp");

// Close the DB first; on Windows the WAL files can stay briefly locked, so temp cleanup is
// best-effort (a leftover temp dir is harmless).
afterAll(() => { closeDb(); try { rmSync(HOME, { recursive: true, force: true }); } catch { /* temp dir cleanup is best-effort */ } });

/** Build a minimal Claude-style JSONL transcript file with the given lines. */
function writeTranscript(name: string, lines: Record<string, unknown>[]): string {
    const dir = join(HOME, "projects", "proj");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
}

const FAKE_KEY = `sk-ant-api03-${"A".repeat(40)}abcd`;

function sampleLines(): Record<string, unknown>[] {
    return [
        { type: "user", cwd: "/home/me/proj", sessionId: "sess1", timestamp: "2026-06-20T10:00:00.000Z", message: { content: "Fix the login bug where the auth token never refreshes" } },
        { type: "assistant", sessionId: "sess1", timestamp: "2026-06-20T10:01:00.000Z", message: { content: [
            { type: "text", text: "Found the token TTL was zero in auth.ts and fixed it." },
            { type: "tool_use", name: "Read", input: { file_path: "/home/me/proj/src/auth.ts" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/home/me/proj/src/auth.ts" } },
        ] } },
        { type: "user", cwd: "/home/me/proj", sessionId: "sess1", timestamp: "2026-06-20T10:05:00.000Z", message: { content: `add a refresh endpoint, my key is ${FAKE_KEY} <private>do not store this paragraph</private>` } },
        { type: "assistant", sessionId: "sess1", timestamp: "2026-06-20T10:06:00.000Z", message: { content: [
            { type: "text", text: "Added the endpoint." },
            { type: "tool_use", name: "Write", input: { file_path: "/home/me/proj/src/refresh.ts" } },
        ] } },
    ];
}

test("extractSession derives a session, per-turn observations and a summary", () => {
    const path = writeTranscript("s.jsonl", sampleLines());
    const r = extractSession(path, "claude")!;
    expect(r).not.toBeNull();
    expect(r.session.project).toBe("proj");
    expect(r.session.source).toBe("claude");
    expect(r.observations.length).toBe(2);

    const first = r.observations[0]!;
    expect(first.type).toBe("bugfix"); // "fix"/"bug" + a file modified
    expect(first.filesModified).toContain("src/auth.ts");
    expect(first.filesRead).toContain("src/auth.ts");
    expect(first.facts.some((f) => /Modified 1 file/.test(f))).toBe(true);

    expect(r.summary).not.toBeNull();
    expect(r.summary!.filesEdited).toContain("src/refresh.ts");
});

test("secrets are redacted and <private> blocks are dropped before storage", () => {
    const path = writeTranscript("s.jsonl", sampleLines());
    const r = extractSession(path, "claude")!;
    const blob = JSON.stringify(r);
    expect(blob).not.toContain(FAKE_KEY);
    expect(blob).not.toContain("do not store this paragraph");
    // The redaction placeholder proves the secret was caught (not merely absent).
    expect(blob).toContain("REDACTED");
});

test("the store dedupes by content hash and FTS search ranks matches", () => {
    const db = openDb();
    store.clearRecall(db);
    const base = { sessionId: "x", project: "p", source: "claude" as const, narrative: "n", facts: [], concepts: [], filesRead: [], filesModified: [], createdAt: 1000 };
    expect(store.insertObservation({ ...base, type: "feature", title: "Add caching layer", contentHash: "h1" }, db)).toBe(true);
    expect(store.insertObservation({ ...base, type: "feature", title: "dup", contentHash: "h1" }, db)).toBe(false); // same hash -> ignored
    store.insertObservation({ ...base, type: "bugfix", title: "Fix caching eviction", contentHash: "h2" }, db);

    const hits = store.searchObservations("caching", {}, db);
    expect(hits.length).toBe(2);
    expect(store.searchObservations("caching", { type: "bugfix" }, db).length).toBe(1);
    expect(store.recallStats(db).observations).toBe(2);
});

test("syncRecall imports transcripts and is idempotent on a second pass", () => {
    store.clearRecall(openDb());
    writeTranscript("s.jsonl", sampleLines());
    const first = syncRecall();
    expect(first.available).toBe(true);
    expect(first.observations).toBeGreaterThan(0);
    expect(first.sessions).toBeGreaterThan(0);

    const again = syncRecall();
    expect(again.observations).toBe(0); // nothing changed -> no new rows

    expect(searchRecall("auth refresh login").length).toBeGreaterThan(0);
    expect(recallStatus().stats!.observations).toBe(first.observations);
});

test("MCP recall tools are gated by the recall setting", () => {
    setEnigmaValue("recall", false, "global");
    const off = handleMcpRequest({ id: 1, method: "tools/list" }, "1.0")!;
    const offNames = (off.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(offNames).not.toContain("enigma_recall");

    setEnigmaValue("recall", true, "global");
    const on = handleMcpRequest({ id: 2, method: "tools/list" }, "1.0")!;
    const onNames = (on.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(onNames).toContain("enigma_recall");
    expect(onNames).toContain("enigma_recall_get");

    const call = handleMcpRequest({ id: 3, method: "tools/call", params: { name: "enigma_recall", arguments: { query: "auth" } } }, "1.0")!;
    const text = (call.result as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain("auth"); // returns the matching index, not the "off" notice
});

test("local embeddings put related text closer than unrelated", () => {
    expect(localEmbed("x").length).toBe(256);
    const a = localEmbed("fix the authentication login token");
    const b = localEmbed("authentication login broke");
    const c = localEmbed("render the dashboard chart colors");
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
});

test("hybrid search fuses keyword + vector and respects filters", () => {
    const db = openDb();
    store.clearRecall(db);
    const base = { source: "claude" as const, narrative: "", facts: [], concepts: [], filesRead: [], filesModified: [] };
    store.insertObservation({ ...base, sessionId: "s", project: "p", type: "bugfix", title: "Fix authentication token refresh", contentHash: "a", createdAt: 1 }, db);
    store.insertObservation({ ...base, sessionId: "s", project: "p", type: "feature", title: "Add login JWT endpoint", contentHash: "b", createdAt: 2 }, db);
    store.insertObservation({ ...base, sessionId: "s", project: "q", type: "refactor", title: "Rename the widget helpers", contentHash: "c", createdAt: 3 }, db);
    expect(store.hybridSearch("authentication", {}, db)[0]!.title).toContain("authentication");
    // fuzzy via the vector half (a typo the FTS prefix term would miss)
    expect(store.hybridSearch("authentification", {}, db).some((o) => o.title.includes("authentication"))).toBe(true);
    expect(store.hybridSearch("widget", { project: "q" }, db).length).toBe(1);
    expect(store.hybridSearch("widget", { project: "p" }, db).length).toBe(0);
    expect(Number(db.query("SELECT COUNT(*) AS n FROM observation_vectors").get()!.n)).toBe(3);
});

test("timeline returns chronological neighbours in the same project", () => {
    const db = openDb();
    store.clearRecall(db);
    const base = { source: "claude" as const, sessionId: "s", project: "p", narrative: "", facts: [], concepts: [], filesRead: [], filesModified: [] };
    for (let i = 1; i <= 5; i++) store.insertObservation({ ...base, type: "change", title: `step ${i}`, contentHash: `h${i}`, createdAt: i * 1000 }, db);
    const anchor = store.recentObservations({}, db).find((o) => o.title === "step 3")!.id!;
    const tl = store.timelineAround({ id: anchor, before: 1, after: 1 }, db).map((o) => o.title);
    expect(tl).toEqual(["step 2", "step 3", "step 4"]);
});

test("sessions list and prune retention", () => {
    const db = openDb();
    store.clearRecall(db);
    store.insertSession({ sessionId: "s1", project: "p", source: "claude", startedAt: 1, endedAt: 10 }, db);
    const base = { source: "claude" as const, sessionId: "s1", project: "p", narrative: "", facts: [], concepts: [], filesRead: [], filesModified: [] };
    for (let i = 1; i <= 4; i++) store.insertObservation({ ...base, type: "change", title: `o${i}`, contentHash: `h${i}`, createdAt: i * 1000 }, db);
    const sessions = store.listSessions({}, db);
    expect(sessions[0]!.sessionId).toBe("s1");
    expect(sessions[0]!.observations).toBe(4);
    expect(store.prune({ maxRows: 2 }, db)).toBe(2);
    expect(store.recallStats(db).observations).toBe(2);
});

test("LLM enrichment is gated by the recall-llm setting; the timeline MCP tool appears when recall is on", async () => {
    setEnigmaValue("recall", false, "global");
    setEnigmaValue("recallLlm", false, "global");
    expect((await enrichRecall({ force: true })).enabled).toBe(false);

    setEnigmaValue("recall", true, "global");
    const tools = (handleMcpRequest({ id: 9, method: "tools/list" }, "1.0")!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toContain("enigma_recall_timeline");
});
