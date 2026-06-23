/**
 * OS-agnostic tool-path discovery and repair. Temp HOME (set BEFORE import) isolates
 * the config and the home-based candidate dirs (config.ts + tool-path.ts resolve the
 * home lazily per call). PATH and the env-derived candidate dirs are neutralized so
 * a real local install of claude/codex on the dev machine never leaks into a case.
 * Must run under Bun: bun test tests/tool-path.test.ts
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-toolpath-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ENIGMA_CLAUDE_BIN;
// Drop every env-derived candidate dir so only the temp-HOME dirs are searched.
for (const k of ["APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramW6432", "NVM_BIN"]) delete process.env[k];
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
    // Fresh home so the previous test's persisted toolPaths does not interfere.
    const home2 = mkdtempSync(join(tmpdir(), "enigma-toolpath2-"));
    process.env.USERPROFILE = home2;
    process.env.HOME = home2;
    const binDir = join(home2, "pathbin");
    const file = fakeBin(binDir, "claude");
    process.env.PATH = binDir;
    process.env.Path = binDir;

    const loc = locateToolBinary("claude");
    expect(loc.onPath).toBe(file);

    const result = fixToolPath("claude");
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(readConfig().config.toolPaths.claude).toBeUndefined();

    rmSync(home2, { recursive: true, force: true });
    process.env.PATH = "";
    process.env.Path = "";
});
