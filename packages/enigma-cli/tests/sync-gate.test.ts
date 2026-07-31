/**
 * Gate delivery on the SYNC path. The gate is on by default, so `enigma update` (and every
 * `enigma <tool>` launch, both of which go through syncDeployed) has to carry it into a
 * deployment that was installed before it existed - the /gate command AND the memory block
 * that tells the agent to drive it. Verifies both halves, the one-time notice, and that a
 * user who switched the gate off gets neither back.
 *
 * Runs against a temp HOME with a fabricated global Claude deployment.
 * Must run under Bun: bun test tests/sync-gate.test.ts
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-sync-gate-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { syncDeployed, syncAccount } = await import("../src/skills");
const { CONFIG_DEFAULTS } = await import("../src/config");
const { AGENTS } = await import("../src/agents");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");
// Read from agents.ts rather than composed from HOME: that module resolves its targets at
// IMPORT time and `bun test` shares one process, so the first importer decides the home.
const SKILLS_DIR = AGENTS.claude!.targets.global!.skills;
const COMMANDS_DIR = AGENTS.claude!.targets.global!.commands!;
const GATE_COMMAND = join(COMMANDS_DIR, "gate.md");
const ACCOUNT_DIR = join(HOME, "account");

const priorConfigHome = process.env.ENIGMA_CONFIG_HOME;
const isGateNotice = (n: string): boolean => /quality gate/i.test(n);

beforeEach(() => {
    // Several test files repoint these on import, so pin them per test or the writes under
    // test land in a foreign home.
    process.env.ENIGMA_CONFIG_HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.HOME = HOME;
    // One managed skill in the global skills dir is what hasDeployment looks for - without a
    // deployment a sync must (and does) leave everything alone.
    mkdirSync(SKILLS_DIR, { recursive: true });
    cpSync(join(ASSETS, "skills", "git-policy"), join(SKILLS_DIR, "git-policy"), { recursive: true });
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
    rmSync(GATE_COMMAND, { force: true });
    rmSync(ACCOUNT_DIR, { recursive: true, force: true });
});

afterAll(() => {
    if (priorConfigHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorConfigHome;
    rmSync(join(SKILLS_DIR, "git-policy"), { recursive: true, force: true });
    rmSync(GATE_COMMAND, { force: true });
    rmSync(HOME, { recursive: true, force: true });
});

test("the gate ships on by default", () => {
    expect(CONFIG_DEFAULTS.gate).toBe(true);
});

test("an update delivers /gate to an existing deployment and says so once", () => {
    expect(existsSync(GATE_COMMAND)).toBe(false);

    const first = syncDeployed(["claude"]);
    expect(existsSync(GATE_COMMAND)).toBe(true);
    expect(readFileSync(GATE_COMMAND, "utf8")).toBe(readFileSync(join(ASSETS, "commands", "gate.md"), "utf8"));
    // The gate changes how the agent behaves, so its arrival is announced rather than folded
    // into the bare "N item(s) updated" count.
    expect(first.some(isGateNotice)).toBe(true);

    // Every launch runs this: it must go quiet once the command is in place.
    expect(syncDeployed(["claude"]).some(isGateNotice)).toBe(false);
    expect(existsSync(GATE_COMMAND)).toBe(true);
});

test("with the gate off an update neither ships nor re-adds the command", () => {
    writeFileSync(join(HOME, ".enigma.json"), `${JSON.stringify({ gate: false })}\n`);

    const notices = syncDeployed(["claude"]);
    expect(existsSync(GATE_COMMAND)).toBe(false);
    expect(notices.some(isGateNotice)).toBe(false);
});

test("the deployed memory carries the gate block, and drops it when switched off", () => {
    syncAccount("claude", ACCOUNT_DIR);
    const deployed = (): string => readFileSync(join(ACCOUNT_DIR, "CLAUDE.md"), "utf8");
    expect(deployed()).toContain("AI Quality Gate");
    // The instruction the agent actually acts on: drive it on whatever branch the work is on.
    expect(deployed()).toContain("gate is active");

    rmSync(ACCOUNT_DIR, { recursive: true, force: true });
    writeFileSync(join(HOME, ".enigma.json"), `${JSON.stringify({ gate: false })}\n`);
    syncAccount("claude", ACCOUNT_DIR);
    expect(deployed()).not.toContain("AI Quality Gate");
});
