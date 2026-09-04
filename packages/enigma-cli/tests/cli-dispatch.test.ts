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
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "enigma-cli-dispatch-"));

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Run the CLI with a throwaway home, so a dispatch test can never touch the real config. */
function cli(...args: string[]): { code: number; stdout: string; stderr: string; } {
    return cliEnv({}, ...args);
}

/** `cli`, plus environment the child needs (e.g. the stand-in agent binary). */
function cliEnv(extra: Record<string, string>, ...args: string[]): { code: number; stdout: string; stderr: string; } {
    const run = spawnSync(process.execPath, [join(ROOT, "src", "bin", "enigma.ts"), ...args], {
        encoding: "utf8",
        input: "",
        windowsHide: true,
        env: { ...process.env, HOME, USERPROFILE: HOME, ENIGMA_CONFIG_HOME: HOME, ENIGMA_OFFLINE: "1", ...extra },
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

/**
 * A stand-in for the agent binary: it prints the argv it was handed and exits 0, so a launch
 * test asserts what the tool ACTUALLY received rather than what the parser meant to send.
 * `ENIGMA_CLAUDE_BIN` is the documented override `launchTool` resolves before anything else.
 */
function fakeAgent(): string {
    const win = process.platform === "win32";
    const file = join(HOME, win ? "fake-agent.cmd" : "fake-agent.sh");
    const script = win ? ["@echo off", "echo ARGV:%*"] : ["#!/bin/sh", "echo \"ARGV:$@\""];
    writeFileSync(file, `${script.join("\n")}\n`);
    if (!win) chmodSync(file, 0o755);
    return file;
}

/** Launch `claude` through the CLI with the stand-in agent in place, and return what it echoed. */
function launched(...args: string[]): { code: number; argv: string; } {
    const res = cliEnv({ ENIGMA_CLAUDE_BIN: fakeAgent() }, ...args);
    const line = res.stdout.split("\n").find((l) => l.includes("ARGV:")) ?? "";
    return { code: res.code, argv: line.slice(line.indexOf("ARGV:") + 5).trim() };
}

test("a launch line forwards its flags to the agent", () => {
    // The bug this pins: Windows PowerShell drops a bare `--` before the process is spawned, so
    // the documented `enigma claude -- --resume <id>` reached the CLI as `claude --resume <id>`
    // and died on `Unknown option: --resume` - the exact line Claude Code's own exit hint tells
    // the user to type. A launch line owns no flags, so every one of them is the agent's.
    expect(launched("claude", "--resume", "abc123").argv).toBe("--resume abc123");
    // The value follows its flag instead of being read as the account name, which is why the
    // forward starts at the first flag and takes the rest of the line with it. The account is
    // created first: a launch that cannot resolve one never reaches the binary at all, so the
    // row would pass on an error instead of on the forwarding it is here to assert.
    expect(cli("account", "add", "work").code).toBe(0);
    expect(launched("claude", "work", "--resume", "abc123").argv).toBe("--resume abc123");
    // Flags the shared parser owns for other commands (`-c` is `--cwd`, `-p` is `--path`) are
    // the agent's here, and must not be swallowed together with the argument behind them.
    expect(launched("claude", "-c").argv).toBe("-c");
    expect(launched("claude", "-p", "prompt").argv).toBe("-p prompt");
    // `--` still works, and is still stripped rather than passed on.
    expect(launched("claude", "--", "--version").argv).toBe("--version");
    // Six real CLI processes in one case, and a process start is the expensive part on a box with
    // real-time scanning: measured at 109-1658 ms for the same binary minutes apart. The default
    // 5 s makes this read as a broken test on a slow machine rather than as a slow one.
}, 60_000);

test("a launch line keeps enigma's own help", () => {
    // The one exception: `-h` prints the launch help rather than the agent's, which is what
    // documents the forwarding in the first place.
    const res = cli("claude", "-h");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("enigma claude");
});
