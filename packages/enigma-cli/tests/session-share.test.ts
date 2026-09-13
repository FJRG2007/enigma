/**
 * Cross-account session sharing: syncSessions must copy the transcripts one account's tree
 * is missing from the others, in both directions, preserving the workspace slug and any
 * nested subagent directory - and must leave alone a transcript that is still being written,
 * one that is older than the mirroring window, and the user's own config dir (a source, never
 * a destination). A copy whose origin has since grown is refreshed rather than frozen.
 *
 * The trees are passed in rather than discovered: account discovery freezes its base paths
 * when accounts.ts is imported, so in a full-suite run (one process, many files) the HOME a
 * single test sets does not win. Naming the roots keeps this test order-independent.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSessions } from "../src/session-share";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";

const BASE = mkdtempSync(join(tmpdir(), "enigma-session-share-"));
const DEFAULT_ROOT = join(BASE, "default", "projects");
const WORK_ROOT = join(BASE, "work", "projects");
const SIDE_ROOT = join(BASE, "side", "projects");
// The user's own config dir is readable but never written; the managed accounts are both.
const ROOTS = [
    { dir: DEFAULT_ROOT, writable: false },
    { dir: WORK_ROOT, writable: true },
    { dir: SIDE_ROOT, writable: true },
];
const SLUG = "C--Users-test-Documents-DEV-demo";

const FIRST = "aaaaaaaa-0000-4000-8000-000000000001";
const SECOND = "bbbbbbbb-0000-4000-8000-000000000002";
const LIVE = "cccccccc-0000-4000-8000-000000000003";
const ANCIENT = "dddddddd-0000-4000-8000-000000000004";
const GROWING = "eeeeeeee-0000-4000-8000-000000000005";

/** Write a transcript and back-date it by `ageMs`, so the live-session guard does not skip it. */
const writeTranscript = (root: string, rel: string, body: string, ageMs = 600_000): string => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    const old = new Date(Date.now() - ageMs);
    utimesSync(path, old, old);
    return path;
};

beforeAll(() => {
    for (const root of [DEFAULT_ROOT, WORK_ROOT, SIDE_ROOT]) mkdirSync(root, { recursive: true });
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

test("syncSessions mirrors missing transcripts both ways and is idempotent", () => {
    writeTranscript(DEFAULT_ROOT, join(SLUG, `${FIRST}.jsonl`), "{\"type\":\"user\"}\n");
    // Nested subagent transcript: the client stores these under the session's own directory,
    // and they are most of the file count - a top-level-only copy would silently drop them.
    writeTranscript(DEFAULT_ROOT, join(SLUG, FIRST, "subagents", "agent-a1.jsonl"), "{\"type\":\"assistant\"}\n");
    writeTranscript(WORK_ROOT, join(SLUG, `${SECOND}.jsonl`), "{\"type\":\"user\"}\n");

    // The default tree's two files reach both managed trees; work's one file reaches side.
    expect(syncSessions("claude", ROOTS)).toBe(5);

    // One account's session, and its subagent transcript, reached the other tree.
    expect(existsSync(join(WORK_ROOT, SLUG, `${FIRST}.jsonl`))).toBe(true);
    expect(existsSync(join(WORK_ROOT, SLUG, FIRST, "subagents", "agent-a1.jsonl"))).toBe(true);
    // ...and the other account's session reached the second managed account.
    expect(existsSync(join(SIDE_ROOT, SLUG, `${SECOND}.jsonl`))).toBe(true);
    // Copies are real files with their content intact: the client resolves those and
    // refuses junctions and hardlinks, which is why sharing cannot avoid duplicating.
    expect(readFileSync(join(WORK_ROOT, SLUG, `${FIRST}.jsonl`), "utf8")).toBe("{\"type\":\"user\"}\n");

    // Idempotent: a second run copies nothing.
    expect(syncSessions("claude", ROOTS)).toBe(0);
});

test("syncSessions never writes into the user's own config dir", () => {
    // A managed account's session must not land in ~/.claude: that dir is the user's own, and
    // other logins' conversations are not copied into it (the boundary packs already hold).
    expect(existsSync(join(DEFAULT_ROOT, SLUG, `${SECOND}.jsonl`))).toBe(false);

    // Even with a second managed account holding it too, it stays out of the default tree.
    expect(syncSessions("claude", ROOTS)).toBe(0);
    expect(existsSync(join(DEFAULT_ROOT, SLUG, `${SECOND}.jsonl`))).toBe(false);
});

test("syncSessions refreshes a copy whose origin has since grown", () => {
    const origin = writeTranscript(WORK_ROOT, join(SLUG, `${GROWING}.jsonl`), "{\"n\":1}\n");
    expect(syncSessions("claude", ROOTS)).toBe(1);
    const copy = join(SIDE_ROOT, SLUG, `${GROWING}.jsonl`);
    expect(readFileSync(copy, "utf8")).toBe("{\"n\":1}\n");

    // The session continued under the origin account: the copy is now a stale prefix, and a
    // one-shot snapshot would resume a conversation with the later turns missing.
    writeTranscript(WORK_ROOT, join(SLUG, `${GROWING}.jsonl`), "{\"n\":1}\n{\"n\":2}\n", 300_000);
    expect(syncSessions("claude", ROOTS)).toBe(1);
    expect(readFileSync(copy, "utf8")).toBe("{\"n\":1}\n{\"n\":2}\n");
    // The copy carries the ORIGIN's age rather than the moment it was taken: stamped "now" it
    // would read as a live session in its new tree, and age out on a different clock.
    expect(statSync(copy).mtimeMs).toBeLessThanOrEqual(statSync(origin).mtimeMs);
    expect(Date.now() - statSync(copy).mtimeMs).toBeGreaterThan(60_000);
    expect(syncSessions("claude", ROOTS)).toBe(0);
});

test("syncSessions leaves a transcript that another account has continued alone", () => {
    // Both trees advanced past the last sync: neither is a superset, so overwriting either
    // would drop the turns appended on that side.
    writeTranscript(WORK_ROOT, join(SLUG, `${GROWING}.jsonl`), "{\"n\":1}\n{\"n\":2}\n{\"work\":3}\n", 240_000);
    writeTranscript(SIDE_ROOT, join(SLUG, `${GROWING}.jsonl`), "{\"n\":1}\n{\"n\":2}\n{\"side\":3}\n{\"side\":4}\n", 120_000);

    expect(syncSessions("claude", ROOTS)).toBe(0);
    expect(readFileSync(join(WORK_ROOT, SLUG, `${GROWING}.jsonl`), "utf8")).toContain("\"work\":3");
    expect(readFileSync(join(SIDE_ROOT, SLUG, `${GROWING}.jsonl`), "utf8")).toContain("\"side\":4");
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

test("syncSessions does not mirror history older than the sharing window", () => {
    // Sharing exists so a recent conversation can be resumed elsewhere; without a bound each
    // account accumulates every other account's entire history on the first launch.
    writeTranscript(DEFAULT_ROOT, join(SLUG, `${ANCIENT}.jsonl`), "{\"type\":\"user\"}\n", 400 * 24 * 60 * 60 * 1000);

    expect(syncSessions("claude", ROOTS)).toBe(0);
    expect(existsSync(join(WORK_ROOT, SLUG, `${ANCIENT}.jsonl`))).toBe(false);
});

test("syncSessions is a no-op without at least two trees, or without a writable one", () => {
    expect(syncSessions("claude", [{ dir: DEFAULT_ROOT, writable: false }])).toBe(0);
    // Only the user's own dir and nothing that may be written: nowhere to mirror to.
    expect(syncSessions("claude", [{ dir: DEFAULT_ROOT, writable: false }, { dir: join(BASE, "other", "projects"), writable: false }])).toBe(0);
});
