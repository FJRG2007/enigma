/**
 * Per-agent skill scoping: a skill turned off for one agent is pruned from THAT agent's
 * deployment on the next sync but stays for the others. Exercised through the account
 * deployment path (syncAccount honors the same currentSkillSet filter). Temp HOME is set
 * BEFORE importing - skills.ts resolves some paths at import time.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-skill-scope-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { syncAccount } = await import("../src/skills");
const CFG = join(HOME, ".enigma.json");
const skillsDir = (dir: string) => join(dir, "skills");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("a skill turned off for an agent is pruned from that agent only", async () => {
    const claude = join(HOME, ".enigma", "claude", "work");
    mkdirSync(claude, { recursive: true });

    syncAccount("claude", claude);
    expect(existsSync(join(skillsDir(claude), "frontend-policy"))).toBe(true);
    expect(existsSync(join(skillsDir(claude), "core-engineering-policy"))).toBe(true);

    // Off for claude -> pruned from claude on the next sync; other skills untouched.
    writeFileSync(CFG, JSON.stringify({ skillAgentsOff: { "frontend-policy": ["claude"] } }) + "\n");
    syncAccount("claude", claude);
    expect(existsSync(join(skillsDir(claude), "frontend-policy"))).toBe(false);
    expect(existsSync(join(skillsDir(claude), "core-engineering-policy"))).toBe(true);

    // Turning it back on re-deploys it.
    writeFileSync(CFG, "{}\n");
    syncAccount("claude", claude);
    expect(existsSync(join(skillsDir(claude), "frontend-policy"))).toBe(true);

    // Off for a DIFFERENT agent (opencode) leaves the claude deployment intact.
    writeFileSync(CFG, JSON.stringify({ skillAgentsOff: { "frontend-policy": ["opencode"] } }) + "\n");
    syncAccount("claude", claude);
    expect(existsSync(join(skillsDir(claude), "frontend-policy"))).toBe(true);
});
