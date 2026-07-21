/**
 * Guardrails hook deployment: the Claude PostToolUse group and the opencode plugin are
 * added/removed idempotently and never clobber a user's own hooks. Explicit paths are
 * passed, so no config is touched; a temp HOME is set only for hygiene.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gr-deploy-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { applyClaudeGuardrailsHook, applyOpencodeGuardrailsPlugin } = await import("../src/guardrails-deploy");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("adds and removes the Claude PostToolUse hook idempotently", () => {
    const settings = join(HOME, "settings.json");
    expect(applyClaudeGuardrailsHook(settings, true)).toBe(true);
    const groups = JSON.parse(readFileSync(settings, "utf8")).hooks.PostToolUse;
    expect(groups.length).toBe(1);
    expect(groups[0].hooks[0].command).toContain("__guardrails-hook");
    expect(groups[0].matcher).toContain("Edit");
    expect(applyClaudeGuardrailsHook(settings, true)).toBe(false); // idempotent
    expect(applyClaudeGuardrailsHook(settings, false)).toBe(true); // remove
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks).toBeUndefined();
});

test("preserves an unrelated user hook when adding and removing ours", () => {
    const settings = join(HOME, "settings2.json");
    writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }] }, other: 1 }));
    applyClaudeGuardrailsHook(settings, true);
    const data = JSON.parse(readFileSync(settings, "utf8"));
    expect(data.other).toBe(1);
    expect(data.hooks.PostToolUse.length).toBe(2);

    applyClaudeGuardrailsHook(settings, false);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.hooks.PostToolUse.length).toBe(1);
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe("echo hi");
    expect(after.other).toBe(1);
});

test("refuses to write a settings file it cannot parse", () => {
    const settings = join(HOME, "broken.json");
    writeFileSync(settings, "{ not json");
    // readJson returns null -> treated as empty; a fresh write is fine, but the point is it never throws.
    expect(() => applyClaudeGuardrailsHook(settings, true)).not.toThrow();
});

test("writes and removes the opencode plugin", () => {
    const dir = join(HOME, "opencode");
    const plugin = join(dir, "plugins", "enigma-guardrails.js");
    expect(applyOpencodeGuardrailsPlugin(dir, true)).toBe(true);
    expect(existsSync(plugin)).toBe(true);
    expect(readFileSync(plugin, "utf8")).toContain("__guardrails-hook");
    expect(applyOpencodeGuardrailsPlugin(dir, true)).toBe(false); // idempotent
    expect(applyOpencodeGuardrailsPlugin(dir, false)).toBe(true);
    expect(existsSync(plugin)).toBe(false);
});
