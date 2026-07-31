/**
 * EOF-trimmer hook deployment: the Claude PostToolUse group and the opencode plugin are
 * added/removed idempotently, live alongside the guardrails hook rather than replacing it,
 * and never clobber a user's own hooks. Explicit paths are passed, so no config is touched;
 * a temp HOME is set only for hygiene.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-trim-deploy-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { applyClaudeTrimHook, applyOpencodeTrimPlugin } = await import("../src/trim-deploy");
const { applyClaudeGuardrailsHook } = await import("../src/guardrails-deploy");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("adds and removes the Claude PostToolUse hook idempotently", () => {
    const settings = join(HOME, "settings.json");
    expect(applyClaudeTrimHook(settings, true)).toBe(true);
    const groups = JSON.parse(readFileSync(settings, "utf8")).hooks.PostToolUse;
    expect(groups.length).toBe(1);
    expect(groups[0].hooks[0].command).toContain("__trim-hook");
    expect(groups[0].matcher).toContain("Edit");
    expect(applyClaudeTrimHook(settings, true)).toBe(false); // idempotent
    expect(applyClaudeTrimHook(settings, false)).toBe(true); // remove
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks).toBeUndefined();
});

test("coexists with the guardrails hook instead of replacing it", () => {
    // Both are PostToolUse groups with the same matcher, so a group-identity bug here would
    // show up as one silently overwriting the other.
    const settings = join(HOME, "both.json");
    applyClaudeGuardrailsHook(settings, true);
    applyClaudeTrimHook(settings, true);
    const commands = JSON.parse(readFileSync(settings, "utf8")).hooks.PostToolUse.map((g: { hooks: { command: string; }[]; }) => g.hooks[0]!.command);
    expect(commands.some((c: string) => c.includes("__guardrails-hook"))).toBe(true);
    expect(commands.some((c: string) => c.includes("__trim-hook"))).toBe(true);
    // Removing one leaves the other in place.
    applyClaudeTrimHook(settings, false);
    const left = JSON.parse(readFileSync(settings, "utf8")).hooks.PostToolUse.map((g: { hooks: { command: string; }[]; }) => g.hooks[0]!.command);
    expect(left.some((c: string) => c.includes("__guardrails-hook"))).toBe(true);
    expect(left.some((c: string) => c.includes("__trim-hook"))).toBe(false);
});

test("preserves an unrelated user hook when adding and removing ours", () => {
    const settings = join(HOME, "settings2.json");
    writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }] }, other: 1 }));
    applyClaudeTrimHook(settings, true);
    const data = JSON.parse(readFileSync(settings, "utf8"));
    expect(data.hooks.PostToolUse.length).toBe(2);
    expect(data.other).toBe(1);
    applyClaudeTrimHook(settings, false);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.hooks.PostToolUse.length).toBe(1);
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe("echo hi");
});

test("refuses to write a settings file it cannot parse", () => {
    const settings = join(HOME, "broken.json");
    writeFileSync(settings, "{ not json");
    expect(applyClaudeTrimHook(settings, true)).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
});

test("writes and removes the opencode plugin", () => {
    const dir = join(HOME, "opencode");
    const plugin = join(dir, "plugins", "enigma-trim.js");
    expect(applyOpencodeTrimPlugin(dir, true)).toBe(true);
    const source = readFileSync(plugin, "utf8");
    expect(source).toContain("__trim-hook");
    // The Windows shell it uses must not flash a console window on every edit.
    expect(source).toContain("windowsHide: true");
    expect(applyOpencodeTrimPlugin(dir, true)).toBe(false); // idempotent
    expect(applyOpencodeTrimPlugin(dir, false)).toBe(true);
    expect(existsSync(plugin)).toBe(false);
});
