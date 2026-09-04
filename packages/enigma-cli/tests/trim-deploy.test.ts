/**
 * EOF-trimmer hook deployment: the opencode plugin is written and removed idempotently.
 *
 * The Claude Code half is NOT here any more. The trimmer is one of three features that write after
 * an edit, and they now share one PostToolUse entry owned by post-edit-deploy.ts - covered by
 * post-edit-deploy.test.ts, including the case this file used to guard as "coexists with the
 * guardrails hook": two entries can no longer clobber each other because there is only one, and
 * what replaced that risk is the toggle interaction, tested there.
 *
 * Kimi keeps its own entry (it wires only the trimmer, so there is nothing to merge) and is covered
 * by applyKimiTrimHook's own round-trip in the Kimi tests.
 *
 * Explicit paths are passed, so no config is touched; a temp HOME is set only for hygiene.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-trim-deploy-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { applyOpencodeTrimPlugin } = await import("../src/trim-deploy");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("writes and removes the opencode plugin", () => {
    const dir = join(HOME, "opencode");
    const plugin = join(dir, "plugins", "enigma-trim.js");
    expect(applyOpencodeTrimPlugin(dir, true)).toBe(true);
    const source = readFileSync(plugin, "utf8");
    // opencode invokes the per-feature command directly, so that hidden command outlives the merge
    // of the Claude entries and must keep its name.
    expect(source).toContain("__trim-hook");
    // The Windows shell it uses must not flash a console window on every edit.
    expect(source).toContain("windowsHide: true");
    expect(applyOpencodeTrimPlugin(dir, true)).toBe(false); // idempotent
    expect(applyOpencodeTrimPlugin(dir, false)).toBe(true);
    expect(existsSync(plugin)).toBe(false);
});
