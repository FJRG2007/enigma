/**
 * The `gate` toggle deploys/removes the /gate command immediately, without a full
 * `enigma install`. ENIGMA_CONFIG_HOME (set BEFORE import) anchors BOTH config.ts and
 * agents.ts to the temp dir via enigmaHome() - os.homedir() ignores a runtime $HOME on
 * bun/Linux, so $HOME alone is not enough to isolate the agent command dirs.
 * Must run under Bun: bun test tests/command-deploy.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gate-"));
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { applyGateToggle } = await import("../src/command-deploy");
const { setEnigmaToggle } = await import("../src/config");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const claudeGate = join(HOME, ".claude", "commands", "gate.md");
const opencodeGate = join(HOME, ".config", "opencode", "command", "gate.md");

test("enable deploys /gate into an existing command dir", () => {
    mkdirSync(join(HOME, ".claude", "commands"), { recursive: true }); // simulate a prior install
    setEnigmaToggle("gate", true, "global");
    const changed = applyGateToggle("global");
    expect(changed).toContain("claude");
    expect(existsSync(claudeGate)).toBe(true);
});

test("enable never creates a command dir for a tool with no deployment", () => {
    // opencode's command dir was never created, so it must stay absent.
    expect(existsSync(opencodeGate)).toBe(false);
});

test("disable removes the deployed /gate command", () => {
    setEnigmaToggle("gate", false, "global");
    const changed = applyGateToggle("global");
    expect(changed).toContain("claude");
    expect(existsSync(claudeGate)).toBe(false);
});
