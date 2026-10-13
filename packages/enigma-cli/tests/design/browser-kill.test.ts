/**
 * Stopping the design browser stops every process it spawned, not only the main one. Chrome's
 * helpers outlive the main process and rewrite the throwaway profile after it is deleted, which
 * left the profile behind on Linux CI. POSIX only: Windows keeps the single-process kill.
 *
 * Run: bun test tests/design/browser-kill.test.ts
 */
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { signalBrowser } from "../../src/design/browser/chrome";

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test.skipIf(process.platform === "win32")("a browser's helper processes die with it", async () => {
    // A stand-in browser: a group leader that leaves a long-lived helper behind, as Chrome does.
    const child = spawn("sh", ["-c", "sleep 60 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const helper = await new Promise<number>((resolve) => child.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    expect(alive(helper)).toBe(true);

    signalBrowser(child, "SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    for (let i = 0; i < 50 && alive(helper); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(helper)).toBe(false);
});
