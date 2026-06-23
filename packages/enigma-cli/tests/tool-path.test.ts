/**
 * OS-agnostic tool-path discovery and repair. Temp HOME (set BEFORE import) isolates
 * the config (config.ts resolves the home lazily per call). ENIGMA_TOOL_PATH_DIRS
 * pins the off-PATH search to a controlled dir and PATH is emptied, so the result is
 * hermetic - a real install of claude/codex on the host (CI or dev) never leaks in.
 * Must run under Bun: bun test tests/tool-path.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-toolpath-"));
const OFF_PATH_DIR = join(HOME, ".local", "bin");
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ENIGMA_CLAUDE_BIN;
// Pin discovery to one controlled dir (empty until a case creates a fake binary in it)
// and empty PATH, so neither depends on what the host has installed.
process.env.ENIGMA_TOOL_PATH_DIRS = OFF_PATH_DIR;
process.env.PATH = "";
process.env.Path = "";

const { locateToolBinary, fixToolPath } = await import("../src/tool-path");
const { readConfig } = await import("../src/config");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Create a fake executable for `bin` in `dir` (Windows needs a PATHEXT extension). */
function fakeBin(dir: string, bin: string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, process.platform === "win32" ? `${bin}.cmd` : bin);
    writeFileSync(file, "#!/bin/sh\n");
    return file;
}

test("reports a tool that is not installed anywhere", () => {
    const loc = locateToolBinary("claude");
    expect(loc.effective).toBeNull();
    const result = fixToolPath("claude");
    expect(result.installed).toBe(false);
    expect(result.ok).toBe(false);
});

test("finds an off-PATH install, persists it, and is idempotent", () => {
    const file = fakeBin(join(HOME, ".local", "bin"), "claude");

    const loc = locateToolBinary("claude");
    expect(loc.onPath).toBeNull();
    expect(loc.offPath).toBe(file);

    const fixed = fixToolPath("claude");
    expect(fixed.ok).toBe(true);
    expect(fixed.changed).toBe(true);
    expect(fixed.path).toBe(file);
    expect(readConfig().config.toolPaths.claude).toBe(file);

    // Second run sees the persisted path and changes nothing.
    const again = fixToolPath("claude");
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
    expect(locateToolBinary("claude").configured).toBe(file);
});

test("leaves the config untouched when the tool is on PATH", () => {
    // Use a tool that was never fixed (codex) so its config entry stays absent; this
    // keeps the same HOME (os.homedir() does not reliably re-read $HOME mid-process on
    // POSIX, so switching it would be unreliable across platforms).
    const binDir = join(HOME, "pathbin");
    const file = fakeBin(binDir, "codex");
    process.env.PATH = binDir;
    process.env.Path = binDir;

    const loc = locateToolBinary("codex");
    expect(loc.onPath).toBe(file);

    const result = fixToolPath("codex");
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(readConfig().config.toolPaths.codex).toBeUndefined();

    process.env.PATH = "";
    process.env.Path = "";
});
