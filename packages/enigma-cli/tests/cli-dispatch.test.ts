/**
 * The CLI's command dispatch contract, and specifically what happens to a command it does not
 * have. A `__`-prefixed command is one enigma wrote into an agent's hook config for itself, so
 * an older binary meeting a hook wired by a newer one must degrade to doing nothing - anything
 * that writes to stderr and exits non-zero is a hook failure the agent reports every turn.
 */
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "enigma-cli-dispatch-"));

/** Run the CLI with a throwaway home, so a dispatch test can never touch the real config. */
function cli(...args: string[]): { code: number; stdout: string; stderr: string; } {
    const run = spawnSync(process.execPath, [join(ROOT, "src", "bin", "enigma.ts"), ...args], {
        encoding: "utf8",
        input: "",
        env: { ...process.env, HOME, USERPROFILE: HOME, ENIGMA_CONFIG_HOME: HOME, ENIGMA_OFFLINE: "1" },
    });
    return { code: run.status ?? -1, stdout: run.stdout || "", stderr: run.stderr || "" };
}

test("a hidden command this binary does not implement exits 0 in silence", () => {
    // The real shape of the bug: hooks wired by a newer enigma naming a command an older one
    // never had. Two node runtimes on one machine, a global install per version, and the older
    // one printed `Unknown command: __codegraph-hook` on every turn of every session.
    for (const cmd of ["__codegraph-hook", "__some-future-hook"]) {
        const res = cli(cmd, "stop");
        expect(res.code).toBe(0);
        expect(res.stderr).not.toContain("Unknown command");
    }
});

test("an ordinary unknown command is still an error", () => {
    // The silence is bought for machine-written commands only. A person typing a command that
    // does not exist must still be told, or a typo turns into a no-op that reads as success.
    const res = cli("instal");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Unknown command: instal");
});

test("an unknown option is still an error", () => {
    // The exemption is keyed on the COMMAND name and must not widen to flags. It cannot reach
    // a hidden command's own flags - the unknown command name is hit first and ends the process
    // before any of them are read, which is correct: the whole invocation is unimplemented, so
    // grading its arguments says nothing useful.
    const res = cli("install", "--no-such-flag");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Unknown option: --no-such-flag");
});
