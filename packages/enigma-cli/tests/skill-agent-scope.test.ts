/**
 * Per-agent skill scoping: a skill turned off for one agent is pruned from THAT agent's
 * deployment on the next sync but stays for the others. Exercised through the account
 * deployment path (syncAccount honors the same currentSkillSet filter). Temp HOME is set
 * BEFORE importing - skills.ts resolves some paths at import time.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-skill-scope-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// bun on Linux ignores a runtime-reassigned $HOME via os.homedir(), so point the global
// config explicitly at the temp dir (configPath honors ENIGMA_CONFIG_HOME).
process.env.ENIGMA_CONFIG_HOME = HOME;

const { syncAccount } = await import("../src/skills");
const { applySkillAction } = await import("../src/dashboard-skills");
const { readConfig } = await import("../src/config");
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

test("the dashboard agent-toggle action records and clears a per-agent opt-out", async () => {
    writeFileSync(CFG, "{}\n");

    const offRes = await applySkillAction("frontend-policy", "agent-toggle", { agent: "codex", off: true });
    expect(offRes.ok).toBe(true);
    expect(readConfig().config.skillAgentsOff["frontend-policy"]).toContain("codex");

    const onRes = await applySkillAction("frontend-policy", "agent-toggle", { agent: "codex", off: false });
    expect(onRes.ok).toBe(true);
    expect(readConfig().config.skillAgentsOff["frontend-policy"] || []).not.toContain("codex");

    // A missing agent is rejected, not silently written.
    const bad = await applySkillAction("frontend-policy", "agent-toggle", { off: true });
    expect(bad.ok).toBe(false);
});

test("skillUpdatePolicy decides whether a locally-edited skill survives a sync", () => {
    writeFileSync(CFG, "{}\n");
    const claude = join(HOME, ".enigma", "claude", "policy");
    mkdirSync(claude, { recursive: true });
    syncAccount("claude", claude);
    const skMd = join(skillsDir(claude), "frontend-policy", "SKILL.md");
    expect(existsSync(skMd)).toBe(true);

    // keep -> a local edit (tampered) is preserved across the next sync.
    writeFileSync(skMd, "EDITED BY USER\n");
    writeFileSync(CFG, JSON.stringify({ skillUpdatePolicy: "keep" }) + "\n");
    syncAccount("claude", claude);
    expect(readFileSync(skMd, "utf8")).toContain("EDITED BY USER");

    // overwrite (default) -> the local edit is replaced by the shipped content.
    writeFileSync(CFG, JSON.stringify({ skillUpdatePolicy: "overwrite" }) + "\n");
    syncAccount("claude", claude);
    expect(readFileSync(skMd, "utf8")).not.toContain("EDITED BY USER");
});
