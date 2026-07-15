/**
 * gh telemetry: enigma must never report a value it did not actually read.
 *
 * `gh config get` exits non-zero on a key it does not know, which is exactly what a gh
 * predating the `telemetry` setting does - and distro packages lag many releases behind.
 * Folding that failure into `value !== "disabled"` reported telemetry as ENABLED on a read
 * that never happened: the dashboard showed it on, the write failed the same silent way,
 * and the toggle looked broken with no reason given.
 *
 * ENIGMA_GH_BIN points at a path that does not exist, which is how a gh that cannot answer
 * looks from here - so this needs neither gh nor a network, and never touches the real gh
 * config (which lives outside enigma's home and would otherwise be a real side effect).
 *
 * Temp HOME is set BEFORE the import: github.ts resolves its cache file at module load.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gh-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
mkdirSync(join(HOME, ".enigma"), { recursive: true });
process.env.ENIGMA_GH_BIN = join(HOME, "gh-that-cannot-answer");

const { getGhTelemetry, ghTelemetryBlocker, hasGhCli, setGhTelemetry } = await import("../src/github");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("a read gh could not answer is unknown, not enabled", () => {
    expect(hasGhCli()).toBe(true); // ENIGMA_GH_BIN is set, so enigma believes gh is there
    expect(getGhTelemetry()).toBeNull();
});

test("a write gh could not take reports why instead of passing silently", () => {
    // null, not false: false would mean "already that value", which would be a claim about
    // gh's state that we are in no position to make.
    expect(setGhTelemetry(false)).toBeNull();
    const blocker = ghTelemetryBlocker();
    expect(blocker).toContain("gh");
    // The reason has to name the likely cause; "not installed" sent people looking for a gh
    // that was sitting right there on their PATH.
    expect(blocker).toContain("too old");
});

test("the dashboard surfaces that reason rather than reporting a save", async () => {
    const { applySetting } = await import("../src/dashboard-settings");
    const out = await applySetting("gh-telemetry", false, "global");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("gh");
});
