/**
 * The idle watchdog on gate agents. A step agent that goes silent is hung - one was measured
 * holding its run for ten hours - so a child that produces no output for the budget is stopped
 * and the step fails saying why, while a child that keeps talking is left alone.
 */
import { test, expect } from "bun:test";
import { spawnConfigured } from "@/gate/shellenv";
import { awaitProcessOutcome } from "@/gate/agent/proc";

const node = process.execPath;

test("a silent child is stopped and the outcome names the silence", async () => {
    const child = spawnConfigured(node, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: ["ignore", "pipe", "pipe"], idleTimeoutMs: 1500 });
    const outcome = await awaitProcessOutcome(child);
    expect(outcome.exitError?.message).toContain("stopped as hung");
}, 60_000);

test("a child that keeps producing output outlives the budget", async () => {
    const script = "let n = 0; const t = setInterval(() => { process.stdout.write('.'); if (++n === 12) { clearInterval(t); } }, 300);";
    const child = spawnConfigured(node, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], idleTimeoutMs: 1500 });
    child.stdout?.resume();
    const outcome = await awaitProcessOutcome(child);
    // Ran ~3.6 s against a 1.5 s budget, and was never stopped.
    expect(outcome.exitError).toBeUndefined();
}, 60_000);
