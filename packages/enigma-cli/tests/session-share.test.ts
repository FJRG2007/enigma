/**
 * Cross-account session sharing: syncSessions must copy the transcripts one account's tree
 * is missing from the others, in both directions, preserving the workspace slug and any
 * nested subagent directory - and must leave a transcript that is still being written alone.
 *
 * The trees are passed in rather than discovered: account discovery freezes its base paths
 * when accounts.ts is imported, so in a full-suite run (one process, many files) the HOME a
 * single test sets does not win. Naming the roots keeps this test order-independent.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSessions } from "../src/session-share";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";

const BASE = mkdtempSync(join(tmpdir(), "enigma-session-share-"));
const DEFAULT_ROOT = join(BASE, "default", "projects");
const WORK_ROOT = join(BASE, "work", "projects");
const ROOTS = [DEFAULT_ROOT, WORK_ROOT];
const SLUG = "C--Users-test-Documents-DEV-demo";

const FIRST = "aaaaaaaa-0000-4000-8000-000000000001";
const SECOND = "bbbbbbbb-0000-4000-8000-000000000002";
const LIVE = "cccccccc-0000-4000-8000-000000000003";

/** Write a transcript and back-date it, so the live-session guard does not skip it. */
const writeTranscript = (root: string, rel: string, body: string): void => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    const old = new Date(Date.now() - 600_000);
    utimesSync(path, old, old);
};

beforeAll(() => {
    mkdirSync(DEFAULT_ROOT, { recursive: true });
    mkdirSync(WORK_ROOT, { recursive: true });
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

test("syncSessions mirrors missing transcripts both ways and is idempotent", () => {
    writeTranscript(DEFAULT_ROOT, join(SLUG, `${FIRST}.jsonl`), "{\"type\":\"user\"}\n");
    // Nested subagent transcript: the client stores these under the session's own directory,
    // and they are most of the file count - a top-level-only copy would silently drop them.
    writeTranscript(DEFAULT_ROOT, join(SLUG, FIRST, "subagents", "agent-a1.jsonl"), "{\"type\":\"assistant\"}\n");
    writeTranscript(WORK_ROOT, join(SLUG, `${SECOND}.jsonl`), "{\"type\":\"user\"}\n");

    expect(syncSessions("claude", ROOTS)).toBe(3);

    // One account's session, and its subagent transcript, reached the other tree.
    expect(existsSync(join(WORK_ROOT, SLUG, `${FIRST}.jsonl`))).toBe(true);
    expect(existsSync(join(WORK_ROOT, SLUG, FIRST, "subagents", "agent-a1.jsonl"))).toBe(true);
    // ...and the other account's session came back the other way.
    expect(existsSync(join(DEFAULT_ROOT, SLUG, `${SECOND}.jsonl`))).toBe(true);
    // Copies are real files with their content intact: the client resolves those and
    // refuses junctions and hardlinks, which is why sharing cannot avoid duplicating.
    expect(readFileSync(join(WORK_ROOT, SLUG, `${FIRST}.jsonl`), "utf8")).toBe("{\"type\":\"user\"}\n");

    // Idempotent: a second run copies nothing.
    expect(syncSessions("claude", ROOTS)).toBe(0);
});

test("syncSessions leaves a transcript that is still being written alone", () => {
    // Written now, so it falls inside the live window: copying it mid-append would
    // publish a truncated turn to the other account.
    const live = join(DEFAULT_ROOT, SLUG, `${LIVE}.jsonl`);
    mkdirSync(join(live, ".."), { recursive: true });
    writeFileSync(live, "{\"type\":\"user\"}\n");

    expect(syncSessions("claude", ROOTS)).toBe(0);
    expect(existsSync(join(WORK_ROOT, SLUG, `${LIVE}.jsonl`))).toBe(false);
});

test("syncSessions is a no-op when a tool has fewer than two trees", () => {
    expect(syncSessions("claude", [DEFAULT_ROOT])).toBe(0);
});
