/**
 * Global commit-guard config (~/.enigma-guard.json): defaults all-on, one protection can be
 * toggled off without disturbing the rest, and the settings registry surfaces each protection
 * as a `guard-<key>` toggle (so it appears in both the TUI and the dashboard Settings page).
 * Temp HOME (set BEFORE import) isolates the file; paths resolve lazily per call.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-guard-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { readGlobalGuard, setGuardProtection } = await import("../src/guard-config");
const { ALL_SETTINGS } = await import("../src/settings-registry");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("defaults to every protection on", () => {
    const g = readGlobalGuard();
    expect(g.secrets).toBe(true);
    expect(g.envFiles).toBe(true);
    expect(g.depDirs).toBe(true);
});

test("toggling one protection off leaves the others on", () => {
    setGuardProtection("envFiles", false);
    const g = readGlobalGuard();
    expect(g.envFiles).toBe(false);
    expect(g.secrets).toBe(true);
    expect(g.depDirs).toBe(true);
    setGuardProtection("envFiles", true); // restore
    expect(readGlobalGuard().envFiles).toBe(true);
});

test("the registry exposes the guard protections as settings", () => {
    const keys = ALL_SETTINGS.map((s) => s.key);
    expect(keys).toContain("guard-secrets");
    expect(keys).toContain("guard-envFiles");
});
