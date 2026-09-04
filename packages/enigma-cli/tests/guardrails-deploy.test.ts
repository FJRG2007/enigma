/**
 * Guardrails hook deployment: the opencode plugin is written and removed idempotently.
 *
 * The Claude Code half is NOT here any more. Guardrails is one of three features that write after
 * an edit, and they now share one PostToolUse entry owned by post-edit-deploy.ts - covered by
 * post-edit-deploy.test.ts, which is also where the toggle interaction between the three belongs,
 * since no one of them can decide that entry's presence alone.
 *
 * Explicit paths are passed, so no config is touched; a temp HOME is set only for hygiene.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gr-deploy-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { applyOpencodeGuardrailsPlugin } = await import("../src/guardrails-deploy");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("writes and removes the opencode plugin", () => {
    const dir = join(HOME, "opencode");
    const plugin = join(dir, "plugins", "enigma-guardrails.js");
    expect(applyOpencodeGuardrailsPlugin(dir, true)).toBe(true);
    expect(existsSync(plugin)).toBe(true);
    // opencode invokes the per-feature command directly, so that hidden command outlives the
    // merge of the Claude entries and must keep its name.
    expect(readFileSync(plugin, "utf8")).toContain("__guardrails-hook");
    expect(applyOpencodeGuardrailsPlugin(dir, true)).toBe(false); // idempotent
    expect(applyOpencodeGuardrailsPlugin(dir, false)).toBe(true);
    expect(existsSync(plugin)).toBe(false);
});
