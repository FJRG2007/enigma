/**
 * Starting the gate daemon, and specifically what happens while it is not answering yet.
 *
 * `enigma gate axi run` starts the daemon first, so this wait is the gate's front door: when it
 * gives up, every run on that machine is blocked with `start daemon: ...` and no gate happens at
 * all. It used to give up after a fixed 15 s on Windows and blame the clock either way, which is
 * wrong in both directions - too short for a cold start behind an antivirus that rescans the
 * ~96 MB binary, and a needless 15 s wait when the child had already died.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const ROOT = mkdtempSync(join(tmpdir(), "enigma-gate-daemon-"));

const { Paths } = await import("../../src/gate/paths");
const { startDaemon } = await import("../../src/gate/cli/daemonCmd");

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A PID no process can hold, so `processRunning` reports it as definitely gone. */
const DEAD_PID = 0x7ffffffe;

test("a child that already exited fails at once, naming its log instead of the clock", async () => {
    const paths = Paths.withRoot(join(ROOT, "dead-child"));
    const started = Date.now();

    // A generous ceiling: the point is that it is NOT waited out. Reaching it would mean the
    // loop is still spending the whole window on a process that can never answer.
    process.env.ENIGMA_GATE_DAEMON_START_TIMEOUT = "30000";
    try {
        await expect(startDaemon(paths, () => DEAD_PID)).rejects.toThrow(/exited while starting up/);
    } finally {
        delete process.env.ENIGMA_GATE_DAEMON_START_TIMEOUT;
    }

    expect(Date.now() - started, "the dead child was waited out instead of detected").toBeLessThan(5_000);
});

test("the timeout is overridable by a name that is not the test suite's", async () => {
    const paths = Paths.withRoot(join(ROOT, "slow-start"));
    const started = Date.now();

    // PID 0 means "unknown" to startDaemon, so the dead-child shortcut cannot fire and the wait
    // runs to its ceiling - which is what makes this a test of the ceiling itself.
    process.env.ENIGMA_GATE_DAEMON_START_TIMEOUT = "700";
    try {
        await expect(startDaemon(paths, () => 0)).rejects.toThrow(/still starting after 700ms/);
    } finally {
        delete process.env.ENIGMA_GATE_DAEMON_START_TIMEOUT;
    }

    const elapsed = Date.now() - started;
    expect(elapsed, "the override was ignored").toBeGreaterThanOrEqual(700);
    expect(elapsed, "the override was ignored in the other direction").toBeLessThan(15_000);
});

test("the timeout message says what to do about it", async () => {
    const paths = Paths.withRoot(join(ROOT, "message"));

    process.env.ENIGMA_GATE_DAEMON_START_TIMEOUT = "300";
    try {
        await startDaemon(paths, () => 0);
        throw new Error("expected the wait to fail");
    } catch (error) {
        const message = (error as Error).message;
        // A blocked gate is the one failure a user cannot diagnose from the outside: the error
        // has to carry both the knob and the log, or the next step is a support question.
        expect(message).toContain("ENIGMA_GATE_DAEMON_START_TIMEOUT");
        expect(message).toContain("daemon.log");
    } finally {
        delete process.env.ENIGMA_GATE_DAEMON_START_TIMEOUT;
    }
});
