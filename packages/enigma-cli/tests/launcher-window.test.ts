/**
 * The npm launcher must not pop a console window when it re-execs the compiled binary.
 *
 * This is the most-spawned code in the product - every hook, every MCP call, every command -
 * and its parent decides whether a console exists to inherit. From a terminal one does, and
 * the binary MUST get it (the TUI reads raw keys and mouse from it). From a hook there is
 * none, and Windows then allocates a fresh console per spawn: a terminal flashing on screen
 * several times a turn. The fix is a run-time decision, so what a test can pin is that the
 * decision is still MADE - a later edit dropping the option would restore the flashing with
 * nothing failing anywhere.
 *
 * `proc-windows-hide` does not cover this call: it exempts `stdio: "inherit"`, which is right
 * for a spawn that only ever runs from a terminal and wrong for this one.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const LAUNCHER = readFileSync(join(ROOT, "bin", "enigma.mjs"), "utf8");

test("the binary re-exec decides windowsHide instead of leaving it unset", () => {
    const spawnCall = /spawn\(\s*binary\s*,[\s\S]*?\)\s*;/.exec(LAUNCHER)?.[0] ?? "";

    expect(spawnCall, "the launcher no longer spawns the binary as expected").toContain("stdio");
    expect(spawnCall, "windowsHide dropped: a hook-spawned binary pops a console again").toContain("windowsHide");
    // A constant `true` would take the console away from the TUI, which needs it for raw keys
    // and mouse; a constant `false` is the defect. Only a computed value satisfies both.
    expect(spawnCall).not.toContain("windowsHide: true");
    expect(spawnCall).not.toContain("windowsHide: false");
});

test("the decision is read from the streams, so a terminal keeps its console", () => {
    const decision = /const\s+windowless\s*=([^;]+);/.exec(LAUNCHER)?.[1] ?? "";

    // All three, not just stdout: a command whose output is piped from a real terminal still
    // has a console, and hiding it there would be the TUI regression this guards against.
    for (const stream of ["stdin", "stdout", "stderr"]) {
        expect(decision, `${stream}.isTTY is not part of the decision`).toContain(`${stream}.isTTY`);
    }
});

test("the launcher still runs the binary with every stream piped", () => {
    const run = spawnSync(process.execPath, [join(ROOT, "bin", "enigma.mjs"), "--version"], {
        encoding: "utf8",
        input: "",
        windowsHide: true,
        env: { ...process.env, ENIGMA_OFFLINE: "1" },
    });

    // No binary is downloaded in a source checkout, and that is a clean, explained failure -
    // what must never happen is the launcher itself throwing on the spawn options.
    const output = `${run.stdout}${run.stderr}`;
    expect(output).not.toContain("TypeError");
    expect(output).not.toContain("ERR_INVALID_ARG");
});
