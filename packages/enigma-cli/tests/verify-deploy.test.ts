/**
 * Verify hook wiring: the Stop hook is added, removed and kept idempotent in a Claude
 * settings.json without disturbing anything else in the file. Temp HOME (set BEFORE import)
 * keeps every write inside the sandbox, and each case targets an explicit path, so the real
 * ~/.claude/settings.json is never read or written.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-verify-deploy-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { applyClaudeVerifyHook } = await import("../src/verify-deploy");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

let seq = 0;
function settingsFile(content?: string): string {
    const path = join(HOME, `settings-${seq++}.json`);
    if (content !== undefined) writeFileSync(path, content);
    return path;
}

function read(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf8"));
}

test("adds the Stop hook and is idempotent", () => {
    const path = settingsFile();
    expect(applyClaudeVerifyHook(path, true)).toBe(true);
    const stop = read(path).hooks as { Stop: Array<{ hooks: Array<{ command: string }> }> };
    expect(stop.Stop.length).toBe(1);
    expect(stop.Stop[0]!.hooks[0]!.command).toBe("enigma __verify-hook");
    // A second apply changes nothing.
    expect(applyClaudeVerifyHook(path, true)).toBe(false);
});

test("removes only its own hook, leaving the user's settings intact", () => {
    const path = settingsFile(JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-notifier" }] }] },
    }));
    applyClaudeVerifyHook(path, true);
    expect((read(path).hooks as { Stop: unknown[] }).Stop.length).toBe(2);

    expect(applyClaudeVerifyHook(path, false)).toBe(true);
    const after = read(path);
    const stop = (after.hooks as { Stop: Array<{ hooks: Array<{ command: string }> }> }).Stop;
    expect(stop.length).toBe(1);
    expect(stop[0]!.hooks[0]!.command).toBe("my-own-notifier");
    expect(after.model).toBe("opus");
    // Removing again is a no-op.
    expect(applyClaudeVerifyHook(path, false)).toBe(false);
});

test("drops the empty Stop key rather than leaving debris", () => {
    const path = settingsFile(JSON.stringify({ model: "opus" }));
    applyClaudeVerifyHook(path, true);
    applyClaudeVerifyHook(path, false);
    const after = read(path);
    expect(after.hooks).toBeUndefined();
    expect(after.model).toBe("opus");
});

test("never creates a settings file just to remove an absent hook", () => {
    const path = join(HOME, "missing-settings.json");
    expect(applyClaudeVerifyHook(path, false)).toBe(false);
    expect(() => readFileSync(path, "utf8")).toThrow();
});

test("refuses to rewrite a settings file it cannot parse", () => {
    const broken = "{ this is not json";
    const path = settingsFile(broken);
    expect(applyClaudeVerifyHook(path, true)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(broken);
});
