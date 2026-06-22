/**
 * Bridge exposing the user's skills to the dashboard - both enigma's own skills and any
 * EXTERNAL (foreign) skill the user installed into an agent - plus the manage actions:
 *   - enigma skill: enable / disable (restore / discard), applied to every deployment.
 *   - external skill: remove, deleting its folder from each agent that holds it.
 *
 * "enigma's own" vs "external" is decided by the skill.json provider (isManagedProvider).
 * The list merges the canonical enigma skill set (bundled + remote overlay, including
 * disabled ones) with what is actually deployed in each installed agent's GLOBAL skills
 * dir, recording which agents hold each skill. Local (per-repo) deployments are out of
 * scope - the dashboard is machine-wide.
 *
 * dashboard.ts imports this DYNAMICALLY (only when the Skills subpage is used), so there is
 * no static import cycle with skills.ts -> dashboard.ts (applyDashboardMode).
 */

import { join } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { isManagedProvider, discoverAgents } from "./agents";
import { listSkillsStatus, discardSkill } from "./skills";
import { isDir, readJson } from "./util";

interface SkillMetaLite { version?: string; provider?: string; description?: string; }

export interface DashboardSkill {
    name: string;
    source: "enigma" | "external";
    version: string | null;
    description: string | null;
    provider: string | null;
    /** enigma skills only: true when the user disabled (discarded) it. */
    discarded: boolean;
    /** Labels of the agents whose global skills dir currently holds this skill. */
    agents: string[];
}

function readMeta(dir: string): SkillMetaLite {
    return readJson<SkillMetaLite>(join(dir, "skill.json")) || {};
}

/** Skill folders (those with a SKILL.md) deployed in one agent's global skills dir. */
function scanAgentSkills(skillsDir: string): { name: string; meta: SkillMetaLite }[] {
    if (!isDir(skillsDir)) return [];
    return readdirSync(skillsDir)
        .filter((e) => isDir(join(skillsDir, e)) && existsSync(join(skillsDir, e, "SKILL.md")))
        .map((e) => ({ name: e, meta: readMeta(join(skillsDir, e)) }));
}

/**
 * Every skill the user has, merged across installed agents: enigma's own skills (canonical
 * version/description + discard state, disabled ones included) and any external skill found
 * deployed in an agent's skills dir. enigma skills sort first, then alphabetically.
 */
export function listSkillsForDashboard(): DashboardSkill[] {
    const byName = new Map<string, DashboardSkill>();

    for (const s of listSkillsStatus()) {
        byName.set(s.name, {
            name: s.name, source: "enigma", version: s.version, description: s.description,
            provider: "FJRG2007/enigma", discarded: s.discarded, agents: [],
        });
    }

    for (const agent of discoverAgents()) {
        for (const { name, meta } of scanAgentSkills(agent.targets.global.skills)) {
            let entry = byName.get(name);
            if (!entry) {
                entry = {
                    name, source: isManagedProvider(meta.provider) ? "enigma" : "external",
                    version: meta.version || null, description: meta.description || null,
                    provider: meta.provider || null, discarded: false, agents: [],
                };
                byName.set(name, entry);
            }
            if (!entry.agents.includes(agent.label)) entry.agents.push(agent.label);
        }
    }

    return [...byName.values()].sort((a, b) =>
        a.source === b.source ? a.name.localeCompare(b.name) : (a.source === "enigma" ? -1 : 1));
}

export interface SkillActionResult { ok: boolean; error?: string; note?: string; skills?: DashboardSkill[]; }

/** Delete an external skill folder from every installed agent's global skills dir. */
function removeExternalSkill(name: string): string[] {
    const removed: string[] = [];
    for (const agent of discoverAgents()) {
        const dir = join(agent.targets.global.skills, name);
        if (!existsSync(join(dir, "SKILL.md"))) continue;
        // Never delete an enigma-managed skill through this path - those use disable/enable.
        if (isManagedProvider(readMeta(dir).provider)) continue;
        try { rmSync(dir, { recursive: true, force: true }); removed.push(agent.label); } catch { /* skip a busy/locked dir */ }
    }
    return removed;
}

/**
 * Manage one skill. enigma skills: "disable" (discard) / "enable" (restore), applied to
 * every deployment at once. External skills: "remove", deleting the folder from each agent
 * that holds it. Returns the refreshed list so the UI reflects the change. Never throws.
 */
export function applySkillAction(name: string, action: string): SkillActionResult {
    if (typeof name !== "string" || !name) return { ok: false, error: "missing skill name" };
    if (action === "disable" || action === "enable") {
        const changed = discardSkill(name, action === "disable");
        const verb = action === "disable" ? "Disabled" : "Enabled";
        return { ok: true, note: changed.length ? `${verb} ${name} (${changed.join(", ")}).` : `${verb} ${name}.`, skills: listSkillsForDashboard() };
    }
    if (action === "remove") {
        const removed = removeExternalSkill(name);
        if (!removed.length) return { ok: false, error: `external skill not found: ${name}` };
        return { ok: true, note: `Removed ${name} from ${removed.join(", ")}.`, skills: listSkillsForDashboard() };
    }
    return { ok: false, error: `unknown action: ${action}` };
}
