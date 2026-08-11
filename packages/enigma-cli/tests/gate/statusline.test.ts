/**
 * The status-bar bridge: `writeSnapshot` (Bun side, reads the gate DB) and the
 * reader/renderer in `bin/statusline.mjs` (Node side, reads only the snapshot).
 * The two never share a runtime, so the round trip is the thing worth testing -
 * plus the rejection rules that keep a stale or foreign run off the bar. The run
 * ledger (`recordRun`) crosses the same split for the completion gate, so it is
 * here too.
 *
 * Must run under Bun: bun test tests/gate/statusline.test.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const DIR = mkdtempSync(join(tmpdir(), "enigma-statusline-"));
process.env.USERPROFILE = DIR;
process.env.HOME = DIR;

const REPO_PATH = join(DIR, "repo").replace(/\\/g, "/");

const { Database, newId, insertRepoWithIDAndFork, insertRun, insertStepResult, startStep, completeStepWithStatus, updateRunStatus } = await import("@/gate/db");
const { Paths } = await import("@/gate/paths");
const { writeSnapshot } = await import("@/gate/daemon/snapshot");
const { recordRun } = await import("@/gate/daemon/ledger");
const { lastGateRun } = await import("@/gate-ledger");
const { render, readSnapshot, readSession } = await import("../../bin/statusline.mjs");

// Windows keeps a handle on SQLite's WAL files a moment after close, so a failed
// assertion can leave the temp dir locked. Cleanup is best-effort, never a failure.
afterAll(() => {
    try {
        rmSync(DIR, { recursive: true, force: true });
    } catch { /* the OS reclaims a temp dir on its own */ }
});

/** Builds a gate DB with one active run: intent done, review running. */
function seed() {
    const paths = Paths.withRoot(join(DIR, `gate-${newId()}`));
    paths.ensureDirs();
    const db = new Database(paths.db());
    const repo = insertRepoWithIDAndFork(db, newId(), REPO_PATH, "https://example.com/o/r.git", "", "main");
    const run = insertRun(db, repo.id, "feat/bar", "a".repeat(40), "b".repeat(40));
    updateRunStatus(db, run.id, "running");
    const intent = insertStepResult(db, run.id, "intent");
    completeStepWithStatus(db, intent.id, "completed", 0, 10, "");
    const review = insertStepResult(db, run.id, "review");
    startStep(db, review.id);
    return { db, paths, run };
}

test("a run written by the daemon is readable and renderable by the Node status bar", () => {
    const { db, paths, run } = seed();
    writeSnapshot(db, paths, run.id);
    process.env.ENIGMA_GATE_HOME = paths.root();

    const snap = readSnapshot(REPO_PATH);
    expect(snap).not.toBeNull();
    expect(snap.branch).toBe("feat/bar");
    expect(snap.steps.find((s) => s.name === "intent").status).toBe("completed");
    expect(snap.steps.find((s) => s.name === "review").status).toBe("running");

    // The rendered bar names the running step and counts the finished ones.
    const line = render({ snapshot: snap, columns: 120, frame: 0, nowSec: snap.startedAt, color256: false });
    expect(line).toContain("review");
    expect(line).toContain("1/2");
    db.close();
});

test("the bar animates: consecutive frames differ, and a settled run disappears", () => {
    const { db, paths, run } = seed();
    writeSnapshot(db, paths, run.id);
    process.env.ENIGMA_GATE_HOME = paths.root();
    const snap = readSnapshot(REPO_PATH);

    const frames = [0, 1, 2, 3].map((frame) => render({ snapshot: snap, columns: 120, frame, nowSec: snap.startedAt, color256: false }));
    expect(new Set(frames).size).toBeGreaterThan(1);

    // Once the run completes there is nothing to report, so the gate line is gone.
    updateRunStatus(db, run.id, "completed");
    writeSnapshot(db, paths, run.id);
    expect(readSnapshot(REPO_PATH)).toBeNull();
    db.close();
});

test("a snapshot is rejected when it is foreign, stale, or from a dead daemon", () => {
    const { db, paths, run } = seed();
    writeSnapshot(db, paths, run.id);
    process.env.ENIGMA_GATE_HOME = paths.root();
    const file = paths.statuslineFile();
    const base = readSnapshot(REPO_PATH);
    expect(base).not.toBeNull();

    // Another repository's run never leaks onto this repo's bar.
    expect(readSnapshot(join(DIR, "elsewhere"))).toBeNull();
    // A subdirectory of the repo still counts as inside it.
    expect(readSnapshot(join(REPO_PATH, "packages", "app"))).not.toBeNull();

    const rewrite = (patch) => writeFileSync(file, JSON.stringify({ ...base, ...patch }));
    // A daemon that died cannot leave a phantom run on screen. PID 0 is never a
    // live process on either platform.
    rewrite({ pid: 0 });
    expect(readSnapshot(REPO_PATH)).toBeNull();
    // A future schema is ignored rather than guessed at.
    rewrite({ version: 99 });
    expect(readSnapshot(REPO_PATH)).toBeNull();
    // Corrupt JSON degrades to no gate line, never an exception.
    writeFileSync(file, "{not json");
    expect(readSnapshot(REPO_PATH)).toBeNull();
    db.close();
});

test("the bar never exceeds the terminal width, dropping the least useful parts first", () => {
    const { db, paths, run } = seed();
    writeSnapshot(db, paths, run.id);
    process.env.ENIGMA_GATE_HOME = paths.root();
    const snapshot = readSnapshot(REPO_PATH);
    const session = {
        model: { display_name: "Opus 5" },
        workspace: { current_dir: REPO_PATH },
        context_window: { used_percentage: 38 },
        cost: { total_cost_usd: 1.24 }
    };
    const at = (columns) => render({ session, snapshot, columns, frame: 0, nowSec: snapshot.startedAt, color256: false });
    for (const columns of [200, 80, 60, 40, 24]) {
        for (const line of at(columns).split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
    }
    // Given room the bar carries the branch; squeezed, that is the first thing to go
    // while the step and its progress - the reason the line exists - survive.
    expect(at(200)).toContain("feat/bar");
    const tight = at(30);
    expect(tight).not.toContain("feat/bar");
    expect(tight).toContain("review");
    db.close();
});

test("a run is recorded in the ledger the completion gate reads", () => {
    // Second half of the same Bun/Node split: the turn-end gate cannot open the database, so
    // what it asks - has any run seen this repository, and when - has to survive the run here.
    const { db, paths, run } = seed();
    recordRun(db, paths, run.id);

    const record = lastGateRun(join(REPO_PATH, "src", "deep"), paths.runLedgerFile());
    expect(record).not.toBeNull();
    expect(record.branch).toBe("feat/bar");
    expect(record.at).toBeGreaterThan(0);
    // Coverage belongs to one repository: another checkout gets none from this run.
    expect(lastGateRun(join(DIR, "other-repo"), paths.runLedgerFile())).toBeNull();
    db.close();
});

test("the session read never waits on a pipe the harness leaves open", async () => {
    // The regression this locks: the renderer used to read stdin with readFileSync(0),
    // which blocks until EOF. A harness that writes the session and keeps its end of the
    // pipe open left the process hung forever - one orphaned renderer per session, each
    // holding memory and a pipe handle until reboot.
    const open = new PassThrough();
    open.write(JSON.stringify({ model: { display_name: "Opus 5" } }));
    expect(await readSession(open, 5000)).toEqual({ model: { display_name: "Opus 5" } });

    // Nothing ever written and never closed: the bar renders without the session
    // rather than waiting on a writer that is not coming.
    const started = Date.now();
    expect(await readSession(new PassThrough(), 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);

    // EOF still settles it, with or without a payload, and junk is not guessed at.
    const ended = new PassThrough();
    ended.end(JSON.stringify({ cwd: "/tmp" }));
    expect(await readSession(ended, 5000)).toEqual({ cwd: "/tmp" });
    const empty = new PassThrough();
    empty.end();
    expect(await readSession(empty, 5000)).toBeNull();
    const junk = new PassThrough();
    junk.end("not json");
    expect(await readSession(junk, 5000)).toBeNull();

    // A session split across writes settles the moment it completes, not at EOF.
    const split = new PassThrough();
    const pending = readSession(split, 5000);
    split.write("{\"cwd\":\"/tmp\",");
    split.write("\"model\":{\"display_name\":\"Opus 5\"}}\n");
    expect(await pending).toEqual({ cwd: "/tmp", model: { display_name: "Opus 5" } });

    // A writer streaming something that is not a session is abandoned at the cap
    // rather than reparsed for the whole timeout.
    const flood = new PassThrough();
    const capped = readSession(flood, 30000);
    for (let i = 0; i < 20; i++) flood.write("x".repeat(64 * 1024));
    expect(await capped).toBeNull();

    // Settling detaches: a read that only resolves keeps buffering everything the
    // writer sends after the cap, and on a stream the renderer does not own the
    // listeners would never come off at all.
    expect(flood.listenerCount("data")).toBe(0);
    expect(flood.isPaused()).toBe(true);
    for (let i = 0; i < 20; i++) flood.write("x".repeat(64 * 1024));
    await new Promise((r) => setTimeout(r, 10));
    expect(flood.listenerCount("data")).toBe(0);
});

const NODE = Bun.which("node");

// Without a `node` on PATH the child cannot be spawned at all. Skipping says so;
// returning early would report the one test that locks this regression as green.
test.skipIf(!NODE)("the bar exits quietly when its reader is already gone", async () => {
    // The regression this locks: a dead reader answers the write with EPIPE an
    // event-loop turn later, and an unhandled `error` event is an uncaught exception -
    // a stack trace on stderr and a nonzero exit, from a status bar.
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string; }>((resolve) => {
        const child = spawn(NODE as string, [join(import.meta.dir, "../../bin/enigma.mjs"), "statusline"], { stdio: ["pipe", "pipe", "pipe"] });
        let err = "";
        child.stderr.on("data", (chunk) => { err += chunk; });
        child.stdout.destroy();
        // The child destroys its own stdin to release itself, so the parent's write can
        // land on a pipe with no read end: EPIPE here would be an uncaught exception
        // that kills the whole run, testing the harness rather than the bar.
        child.stdin.on("error", () => {});
        child.stdin.write(JSON.stringify({ cwd: DIR, model: { display_name: "Opus 5" } }));
        child.on("exit", (status) => {
            child.stdin.destroy();
            resolve({ code: status, stderr: err.trim() });
        });
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
});
