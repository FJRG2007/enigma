/**
 * The hook doctor's collection contract. Timing is a measurement and cannot be asserted, but
 * WHICH hooks it finds can be, and that is where the command is either useful or misleading:
 * an event carries hooks from three settings files at once plus every enabled plugin, so a
 * source it fails to walk is a hook that silently escapes the report - exactly the hook the
 * user is looking for when they run this.
 */
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-doctor-home-"));
const CWD = mkdtempSync(join(tmpdir(), "enigma-doctor-cwd-"));
process.env.ENIGMA_CONFIG_HOME = HOME;

const { collectHooks, probePayload, timeHook, HOT_EVENTS } = await import("../src/doctor-hooks");

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
});

/** Write a JSON file, creating its directory. */
function write(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
}

const PLUGIN_ROOT = join(HOME, ".claude", "plugins", "cache", "market", "noisy", "1.0.0");

write(join(HOME, ".claude", "settings.json"), {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-hook", timeout: 25 }] }] },
    enabledPlugins: { "noisy@market": true, "quiet@market": false },
});
write(join(CWD, ".claude", "settings.json"), {
    hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "project-hook" }] }] },
});
write(join(CWD, ".claude", "settings.local.json"), {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "local-hook" }] }] },
});
write(join(HOME, ".claude", "plugins", "installed_plugins.json"), {
    plugins: { "noisy@market": [{ installPath: PLUGIN_ROOT }] },
});
write(join(PLUGIN_ROOT, "hooks", "hooks.json"), {
    hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/notify.sh" }] }] },
});
write(join(HOME, ".claude", "plugins", "cache", "market", "quiet", "1.0.0", "hooks", "hooks.json"), {
    hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "disabled-plugin-hook" }] }] },
});

test("every settings file that contributes a hook is walked, and tagged by where it came from", () => {
    const found = collectHooks(CWD);
    const byCommand = Object.fromEntries(found.map((h) => [h.command, h]));

    expect(byCommand["user-hook"]?.source).toBe("user settings");
    expect(byCommand["user-hook"]?.event).toBe("UserPromptSubmit");
    expect(byCommand["user-hook"]?.timeout).toBe(25);

    expect(byCommand["project-hook"]?.source).toBe("project settings");
    expect(byCommand["project-hook"]?.matcher).toBe("Edit|Write");
    // No timeout of its own is not zero: it falls back to Claude Code's default, which this
    // command must report as unknown rather than invent a number for.
    expect(byCommand["project-hook"]?.timeout).toBe(null);

    expect(byCommand["local-hook"]?.source).toBe("local settings");
});

test("an enabled plugin's hooks are collected with the root ${CLAUDE_PLUGIN_ROOT} expands to", () => {
    const found = collectHooks(CWD);
    const plugin = found.find((h) => h.command.includes("notify.sh"));

    expect(plugin?.source).toBe("plugin noisy@market");
    expect(plugin?.pluginRoot).toBe(PLUGIN_ROOT);
    expect(found.some((h) => h.command === "disabled-plugin-hook")).toBe(false);
});

test("the default scope is the events that fire on every turn", () => {
    const hot = collectHooks(CWD).filter((h) => HOT_EVENTS.includes(h.event));

    expect(hot.map((h) => h.command).sort()).toEqual(["${CLAUDE_PLUGIN_ROOT}/scripts/notify.sh", "project-hook", "user-hook"]);
    expect(hot.some((h) => h.event === "Stop")).toBe(false);
});

test("the probe payload carries the event's own fields and never asks a hook to act", () => {
    const prompt = JSON.parse(probePayload("UserPromptSubmit", CWD));
    expect(prompt.hook_event_name).toBe("UserPromptSubmit");
    expect(typeof prompt.prompt).toBe("string");

    const post = JSON.parse(probePayload("PostToolUse", CWD));
    // A Read with no input: a hook that formats or lints the edited file finds no file.
    expect(post.tool_name).toBe("Read");
    expect(post.tool_input).toEqual({});

    // Telling a stop hook a stop is already in flight is what stops it blocking a turn that
    // is not running - the documented way a Stop hook avoids recursing.
    expect(JSON.parse(probePayload("Stop", CWD)).stop_hook_active).toBe(true);
});

test("a hook is graded against its own declared timeout", () => {
    const base = { event: "UserPromptSubmit", source: "test", matcher: null, pluginRoot: null };
    const fast = timeHook({ ...base, command: "exit 0", timeout: 600 }, CWD, 1);
    const impossible = timeHook({ ...base, command: "exit 0", timeout: 0 }, CWD, 1);

    expect(fast.verdict).not.toBe("over");
    expect(fast.runs.length).toBe(1);
    expect(impossible.verdict).toBe("over");
});
