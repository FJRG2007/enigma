/**
 * Cross-account session sharing: syncSessions must copy the transcripts one account's tree
 * is missing from the others, in both directions, preserving the workspace slug and any
 * nested subagent directory - and must leave alone a transcript that is still being written on
 * either side, one that is older than the mirroring window, and the user's own config dir (a
 * source, never a destination). A copy whose origin has since grown is refreshed rather than
 * frozen, unless a client is still writing the copy itself.
 *
 * unshareSessions is the undo, and what it must not do carries the weight: it deletes, so it
 * removes only a copy the kept file contains byte for byte, never touches the user's own config
 * dir, and defers a copy a client still has open.
 *
 * The trees are passed in rather than discovered: account discovery freezes its base paths
 * when accounts.ts is imported, so in a full-suite run (one process, many files) the HOME a
 * single test sets does not win. Naming the roots keeps this test order-independent.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { syncSessions, unshareSessions } from "../src/session-share";
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
const OTHER_TOOL = "ffffffff-0000-4000-8000-000000000006";
const HELD = "aaaaaaaa-0000-4000-8000-000000000007";

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

test("syncSessions leaves a destination that a client is still writing alone", () => {
    // The stale prefix is in the destination this time: side holds what it was mirrored, work has
    // continued the session, and a client has side's copy open right now. Replacing it renames the
    // file out from under that writer - its later turns go to an unlinked inode on POSIX, and the
    // rename fails outright on Windows - so the refresh waits for the session to go idle.
    const rel = join(SLUG, `${HELD}.jsonl`);
    writeTranscript(WORK_ROOT, rel, "{\"n\":1}\n");
    expect(syncSessions("claude", ROOTS)).toBe(1);

    writeTranscript(WORK_ROOT, rel, "{\"n\":1}\n{\"n\":2}\n", 300_000);
    const target = join(SIDE_ROOT, rel);
    const now = new Date();
    utimesSync(target, now, now);

    expect(syncSessions("claude", ROOTS)).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("{\"n\":1}\n");

    // Idle again: the copy the live window deferred is taken on the next run.
    const idle = new Date(Date.now() - 600_000);
    utimesSync(target, idle, idle);
    expect(syncSessions("claude", ROOTS)).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("{\"n\":1}\n{\"n\":2}\n");
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

test("syncSessions clears the temp file an interrupted copy left behind", () => {
    const dir = join(WORK_ROOT, SLUG);
    const abandoned = join(dir, ".aaaaaaaa-0000-4000-8000-00000000000a.tmp");
    const inFlight = join(dir, ".bbbbbbbb-0000-4000-8000-00000000000b.tmp");
    writeFileSync(abandoned, "half a transcript");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(abandoned, old, old);
    // Another run copying right now: young enough that deleting it would fail that copy.
    writeFileSync(inFlight, "half a transcript");

    syncSessions("claude", ROOTS);

    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(inFlight)).toBe(true);
    rmSync(inFlight, { force: true });
});

test("syncSessions mirrors nothing for a tool whose transcript format is not this one", () => {
    // Every rule here is Claude Code's; another tool that grows a projects/ tree is left alone
    // until its format is verified rather than copied on assumptions taken from this one.
    const rel = join(SLUG, `${OTHER_TOOL}.jsonl`);
    writeTranscript(DEFAULT_ROOT, rel, "{\"type\":\"user\"}\n");

    expect(syncSessions("codex", ROOTS)).toBe(0);
    expect(syncSessions("opencode", ROOTS)).toBe(0);
    expect(existsSync(join(WORK_ROOT, rel))).toBe(false);

    // The same transcript under the tool this DOES mirror for: what the calls above refused was
    // the tool, not an empty tree.
    expect(syncSessions("claude", ROOTS)).toBe(2);
    expect(existsSync(join(WORK_ROOT, rel))).toBe(true);
    expect(existsSync(join(SIDE_ROOT, rel))).toBe(true);
});

test("syncSessions is a no-op without at least two trees, or without a writable one", () => {
    expect(syncSessions("claude", [{ dir: DEFAULT_ROOT, writable: false }])).toBe(0);
    // Only the user's own dir and nothing that may be written: nowhere to mirror to.
    expect(syncSessions("claude", [{ dir: DEFAULT_ROOT, writable: false }, { dir: join(BASE, "other", "projects"), writable: false }])).toBe(0);
});

/**
 * The prune runs on its own trees: it deletes, and the mirroring cases above build up shared
 * state across tests that a deletion would pull out from under them.
 */
const PRUNE_OWN = join(BASE, "prune-own", "projects");
const PRUNE_OTHER = join(BASE, "prune-other", "projects");
const PRUNE_USER = join(BASE, "prune-user", "projects");
const PRUNE_ROOTS = [
    { dir: PRUNE_OWN, writable: true },
    { dir: PRUNE_OTHER, writable: true },
    { dir: PRUNE_USER, writable: false },
];

/** Rebuild the prune trees, so each case starts from a tree nothing before it deleted from. */
const resetPruneTrees = (): void => {
    for (const root of [PRUNE_OWN, PRUNE_OTHER, PRUNE_USER]) {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
    }
};

test("unshareSessions removes what mirroring copied and leaves the conversation with its account", () => {
    resetPruneTrees();
    const rel = join(SLUG, `${FIRST}.jsonl`);
    const nested = join(SLUG, FIRST, "subagents", "agent-a1.jsonl");
    writeTranscript(PRUNE_OWN, rel, "{\"n\":1}\n");
    writeTranscript(PRUNE_OWN, nested, "{\"n\":1}\n");
    expect(syncSessions("claude", PRUNE_ROOTS)).toBe(2);

    // Only the copies go: the tree that recorded the conversation keeps it, so /resume lists it
    // once instead of listing the same session under every account that was ever launched.
    expect(unshareSessions("claude", PRUNE_ROOTS).removed).toBe(2);
    expect(existsSync(join(PRUNE_OWN, rel))).toBe(true);
    expect(existsSync(join(PRUNE_OWN, nested))).toBe(true);
    expect(existsSync(join(PRUNE_OTHER, rel))).toBe(false);
    // The session's own directory went with its transcripts: an empty shell still reads as a
    // tree holding conversations.
    expect(existsSync(join(PRUNE_OTHER, SLUG, FIRST))).toBe(false);

    // Idempotent, and nothing is left for a second pass to find.
    expect(unshareSessions("claude", PRUNE_ROOTS).removed).toBe(0);
});

test("unshareSessions drops a copy frozen mid-conversation, keeping the one with every turn", () => {
    resetPruneTrees();
    // What sharing being off leaves behind: the copy was taken while the session ran, the origin
    // continued, and nothing refreshes the copy any more - resuming it would miss the later turns.
    const rel = join(SLUG, `${GROWING}.jsonl`);
    writeTranscript(PRUNE_OTHER, rel, "{\"n\":1}\n");
    writeTranscript(PRUNE_OWN, rel, "{\"n\":1}\n{\"n\":2}\n{\"n\":3}\n", 300_000);

    expect(unshareSessions("claude", PRUNE_ROOTS).removed).toBe(1);
    expect(existsSync(join(PRUNE_OTHER, rel))).toBe(false);
    expect(readFileSync(join(PRUNE_OWN, rel), "utf8")).toBe("{\"n\":1}\n{\"n\":2}\n{\"n\":3}\n");
});

test("unshareSessions leaves a tree that has turns of its own, and the user's own dir", () => {
    resetPruneTrees();
    // Diverged: the longer file is not a superset of the shorter one, so deleting either would
    // lose the turns appended on that side. A prune that cannot prove redundancy keeps both.
    const diverged = join(SLUG, `${SECOND}.jsonl`);
    writeTranscript(PRUNE_OWN, diverged, "{\"n\":1}\n{\"own\":2}\n{\"own\":3}\n");
    writeTranscript(PRUNE_OTHER, diverged, "{\"n\":1}\n{\"other\":2}\n", 300_000);

    // A prefix held by the user's own config dir: redundant, but that dir is a source only - the
    // same boundary mirroring holds, and the user's transcripts are not enigma's to delete.
    const mine = join(SLUG, `${HELD}.jsonl`);
    writeTranscript(PRUNE_USER, mine, "{\"n\":1}\n");
    writeTranscript(PRUNE_OWN, mine, "{\"n\":1}\n{\"n\":2}\n", 300_000);

    expect(unshareSessions("claude", PRUNE_ROOTS).removed).toBe(0);
    expect(readFileSync(join(PRUNE_OWN, diverged), "utf8")).toContain("\"own\":3");
    expect(readFileSync(join(PRUNE_OTHER, diverged), "utf8")).toContain("\"other\":2");
    expect(existsSync(join(PRUNE_USER, mine))).toBe(true);
});

test("unshareSessions counts without writing under dryRun, and waits out a live copy", () => {
    resetPruneTrees();
    const rel = join(SLUG, `${LIVE}.jsonl`);
    const idle = join(SLUG, `${ANCIENT}.jsonl`);
    writeTranscript(PRUNE_OWN, rel, "{\"n\":1}\n");
    writeTranscript(PRUNE_OWN, idle, "{\"n\":1}\n");
    expect(syncSessions("claude", PRUNE_ROOTS)).toBe(2);

    const preview = unshareSessions("claude", PRUNE_ROOTS, { dryRun: true });
    expect(preview.removed).toBe(2);
    expect(preview.bytes).toBe(statSync(join(PRUNE_OWN, rel)).size * 2);
    expect(existsSync(join(PRUNE_OTHER, rel))).toBe(true);

    // A client has that copy open right now: deleting it takes the file out from under the
    // session writing it, so the copy waits for a prune run after it goes idle.
    const now = new Date();
    utimesSync(join(PRUNE_OTHER, rel), now, now);
    expect(unshareSessions("claude", PRUNE_ROOTS).removed).toBe(1);
    expect(existsSync(join(PRUNE_OTHER, rel))).toBe(true);
    expect(existsSync(join(PRUNE_OTHER, idle))).toBe(false);
});

test("unshareSessions touches nothing for another tool, or a single tree", () => {
    resetPruneTrees();
    const rel = join(SLUG, `${OTHER_TOOL}.jsonl`);
    writeTranscript(PRUNE_OWN, rel, "{\"n\":1}\n");
    writeTranscript(PRUNE_OTHER, rel, "{\"n\":1}\n", 300_000);

    expect(unshareSessions("codex", PRUNE_ROOTS).removed).toBe(0);
    expect(unshareSessions("claude", [{ dir: PRUNE_OWN, writable: true }]).removed).toBe(0);
    expect(existsSync(join(PRUNE_OTHER, rel))).toBe(true);
});
