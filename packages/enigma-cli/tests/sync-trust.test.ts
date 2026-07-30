/**
 * Workspace trust on the SYNC path. `enigma update`, the hub's "update now" action and
 * every `enigma <tool>` launch all reach Claude's trust state through syncDeployed, so
 * that is where the pre-answer has to be re-asserted: it is what makes the setting hold
 * for any directory, including ones that did not exist at install time. Verifies it fires
 * on an existing deployment, says so only once, and stays out of the file when the setting
 * is off. Runs against a temp HOME with a fabricated global Claude deployment.
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, parse } from "node:path";
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-sync-trust-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { syncDeployed } = await import("../src/skills");
const { claudeWorkspaceKey } = await import("../src/claude");
const { AGENTS } = await import("../src/agents");

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "skills");
/**
 * Where the deployment fixture goes. Read from agents.ts rather than composed from HOME:
 * that module resolves its target paths at IMPORT time, and `bun test` shares one process,
 * so whichever test file imported it first decided the home it points at. Trust itself is
 * resolved per call (enigmaHome), so it still lands in this file's HOME - which is the
 * behavior under test here, not where the skills happen to sit.
 */
const SKILLS_DIR = AGENTS.claude!.targets.global!.skills;
/** Claude's user-global state file, where workspace trust lives. */
const STATE = join(HOME, ".claude.json");
/** The filesystem root enigma trusts to cover every path on the drive. */
const ROOT = normalize(parse(HOME).root).replaceAll("\\", "/");
const trustOf = (key: string): unknown => {
    const projects = JSON.parse(readFileSync(STATE, "utf8")).projects as Record<string, Record<string, unknown>>;
    return projects[key]?.hasTrustDialogAccepted;
};

let priorConfigHome: string | undefined;

beforeEach(() => {
    // `bun test` shares one process across files and several of them point
    // ENIGMA_CONFIG_HOME at their own temp dir on import, so pin it per test (and restore
    // it after) or the writes under test land in a foreign home.
    priorConfigHome = process.env.ENIGMA_CONFIG_HOME;
    process.env.ENIGMA_CONFIG_HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.HOME = HOME;
    // A deployment is the precondition for any sync: one managed skill in the global
    // Claude skills dir is what hasDeployment looks for.
    mkdirSync(SKILLS_DIR, { recursive: true });
    cpSync(join(ASSETS, "git-policy"), join(SKILLS_DIR, "git-policy"), { recursive: true });
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
    rmSync(STATE, { force: true });
});

afterEach(() => {
    if (priorConfigHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorConfigHome;
});

afterAll(() => {
    rmSync(join(SKILLS_DIR, "git-policy"), { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
});

test("a sync answers the trust prompt for the root and the current workspace, once", () => {
    expect(existsSync(STATE)).toBe(false);

    // Default on: the update/launch sync records the trust and reports it.
    expect(syncDeployed().some((n) => /trust/i.test(n))).toBe(true);
    expect(trustOf(ROOT)).toBe(true);
    expect(trustOf(claudeWorkspaceKey(process.cwd()))).toBe(true);

    // Every launch runs this, so it must go quiet once the blanket is in place.
    expect(syncDeployed().some((n) => /trust/i.test(n))).toBe(false);
    expect(trustOf(ROOT)).toBe(true);
});

test("with the setting off a sync leaves Claude's trust state alone", () => {
    writeFileSync(join(HOME, ".enigma.json"), `${JSON.stringify({ claudeTrust: false })}\n`);

    syncDeployed();
    // Not even created: an off setting must never pre-answer a prompt the user wants to see.
    expect(existsSync(STATE)).toBe(false);
});
