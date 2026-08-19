/**
 * The CLI's command dispatch contract, and specifically what happens to a command it does not
 * have. A `__`-prefixed command is one enigma wrote into an agent's hook config for itself, so
 * an older binary meeting a hook wired by a newer one must degrade to doing nothing - anything
 * that writes to stderr and exits non-zero is a hook failure the agent reports every turn.
 *
 * That tolerance has a cost this file also pays for: silence is the right answer to a command a
 * FUTURE enigma wired, and the wrong answer to one THIS build wires and forgets to implement,
 * which would now no-op forever with no signal at all. The two lists are coupled by nothing but
 * discipline, so the invariant is asserted here instead of trusted.
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "enigma-cli-dispatch-"));

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Run the CLI with a throwaway home, so a dispatch test can never touch the real config. */
function cli(...args: string[]): { code: number; stdout: string; stderr: string; } {
    const run = spawnSync(process.execPath, [join(ROOT, "src", "bin", "enigma.ts"), ...args], {
        encoding: "utf8",
        input: "",
        windowsHide: true,
        env: { ...process.env, HOME, USERPROFILE: HOME, ENIGMA_CONFIG_HOME: HOME, ENIGMA_OFFLINE: "1" },
    });
    return { code: run.status ?? -1, stdout: run.stdout || "", stderr: run.stderr || "" };
}

/** Every `.ts` under src/, so a hidden command added in any module is covered the day it lands. */
function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? sources(p) : e.name.endsWith(".ts") ? [p] : [];
    });
}

test("a hidden command this binary does not implement exits 0 in silence", () => {
    // The real shape of the bug: hooks wired by a newer enigma naming a command an older one
    // never had. Two node runtimes on one machine, a global install per version, and the older
    // one printed `Unknown command: __codegraph-hook` on every turn of every session. The names
    // below are deliberately ones nothing implements - an implemented one is dispatched in
    // `run()` before `parseArgs` ever sees it, so it would pass this with or without the fix.
    for (const cmd of ["__some-future-hook", "__not-a-command"]) {
        const res = cli(cmd, "stop");
        expect(res.code).toBe(0);
        expect(res.stderr).not.toContain("Unknown command");
        // Silence means stdout too: a hook's stdout is parsed by the harness, so a stray line
        // here is read as the hook's output rather than as nothing having happened.
        expect(res.stdout).toBe("");
    }
});

test("every hidden command enigma wires is one it dispatches", () => {
    // What the silence above costs: a hook command renamed in a `*-deploy.ts` module without the
    // matching branch in `run()` no longer fails on the first turn - it no-ops forever. The two
    // sides are matched mechanically so the discipline is not what holds them together.
    //
    // A hidden command is `__name`, never `__dunder__` (`__pycache__`, `__tests__`, `__none__`
    // and friends are data, not commands) and never node's own `__dirname`/`__filename`. Any
    // occurrence counts - a hook config string, an argv array, a spawned shell script, a doc
    // comment - because every one of them names a command someone can end up invoking.
    const TOKEN = /(?<![A-Za-z0-9_-])__[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![A-Za-z0-9_-])/g;
    const NOT_COMMANDS = new Set(["__dirname", "__filename"]);
    const wired = new Set<string>();
    for (const file of sources(join(ROOT, "src"))) {
        for (const m of readFileSync(file, "utf8").matchAll(TOKEN)) {
            if (!NOT_COMMANDS.has(m[0])) wired.add(m[0]);
        }
    }

    const cliSource = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
    const dispatched = new Set([...cliSource.matchAll(/argv\[0\] === "(__[a-z0-9-]+)"/g)].map((m) => m[1]!));
    expect(dispatched.size).toBeGreaterThan(0);
    // Scanner self-check first: `run()`'s own branches carry the literal, so a dispatched command
    // the scan failed to see means the token pattern broke, not that a command went missing. Without
    // this the invariant below would pass loudest exactly when it had stopped reading anything.
    expect([...dispatched].filter((c) => !wired.has(c)).sort()).toEqual([]);
    expect([...wired].filter((c) => !dispatched.has(c)).sort()).toEqual([]);
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
