/**
 * Bridge exposing the user's skills to the dashboard Skills subpage and dispatching its
 * manage actions. The skill domain logic (listing across agents, update status, reading /
 * writing / removing SKILL.md, checking for updates) lives in skills.ts; this is the thin
 * shaping + action layer the loopback server calls.
 *
 * dashboard.ts imports this DYNAMICALLY (only when the Skills subpage is used), so there is
 * no static import cycle with skills.ts -> dashboard.ts (applyDashboardMode).
 */

import {
    skillsReport, discardSkill, setSkillAgent, removeExternalSkill, readSkillSource, writeSkillEverywhere,
    checkAndUpdateSkills, type SkillReport
} from "./skills";

/** Snapshot of every skill the user has (enigma + external) with deployment/update state. */
export function listSkillsForDashboard(): SkillReport[] {
    return skillsReport();
}

export interface SkillActionResult {
    ok: boolean;
    error?: string;
    note?: string;
    /** Present for the "read" action: the skill's SKILL.md content for the editor. */
    content?: string;
    /** The refreshed list after a mutating action, so the UI reflects the change. */
    skills?: SkillReport[];
}

/**
 * Dispatch a Skills-subpage action. Mutating actions return the refreshed list. Never throws.
 *  - read          : return the SKILL.md content (for the editor).
 *  - save          : overwrite the SKILL.md across every agent that holds the skill.
 *  - disable/enable : discard / restore an enigma skill across all deployments.
 *  - agent-toggle  : turn an enigma skill on/off for ONE agent (content = { agent, off }).
 *  - remove        : delete an external skill from every agent that holds it.
 *  - check-updates : refresh enigma skills from GitHub and re-sync deployments.
 */
export async function applySkillAction(name: string, action: string, content?: unknown): Promise<SkillActionResult> {
    if (action === "check-updates") {
        const { updated, synced } = await checkAndUpdateSkills();
        const note = updated.length ? `Updated from GitHub: ${updated.join(", ")}.`
            : synced.length ? `Re-synced: ${synced.join(", ")}.` : "All skills are up to date.";
        return { ok: true, note, skills: skillsReport() };
    }

    if (typeof name !== "string" || !name) return { ok: false, error: "missing skill name" };

    if (action === "read") {
        const c = readSkillSource(name);
        return c === null ? { ok: false, error: "skill content not found" } : { ok: true, content: c };
    }
    if (action === "save") {
        // content is either the SKILL.md string (write to every app that holds it) or
        // { text, agents } to write only to the chosen apps (per-app editing).
        let text: unknown = content;
        let agents: string[] | undefined;
        if (content && typeof content === "object") {
            text = (content as { text?: unknown; }).text;
            const a = (content as { agents?: unknown; }).agents;
            if (Array.isArray(a)) agents = a.filter((x): x is string => typeof x === "string");
        }
        if (typeof text !== "string") return { ok: false, error: "missing content" };
        if (agents && agents.length === 0) return { ok: false, error: "pick at least one app to save to" };
        const written = writeSkillEverywhere(name, text, agents);
        return written.length
            ? { ok: true, note: `Saved ${name} to ${written.join(", ")}.`, skills: skillsReport() }
            : { ok: false, error: "no deployed copy to write" };
    }
    if (action === "disable" || action === "enable") {
        const changed = discardSkill(name, action === "disable");
        const verb = action === "disable" ? "Disabled" : "Enabled";
        return { ok: true, note: changed.length ? `${verb} ${name} (${changed.join(", ")}).` : `${verb} ${name}.`, skills: skillsReport() };
    }
    if (action === "agent-toggle") {
        const p = (content && typeof content === "object" ? content : {}) as { agent?: unknown; off?: unknown; };
        const agent = typeof p.agent === "string" ? p.agent : "";
        if (!agent) return { ok: false, error: "missing agent" };
        const off = !!p.off;
        const notices = setSkillAgent(name, agent, off);
        const verb = off ? "Disabled" : "Enabled";
        return { ok: true, note: `${verb} ${name} for ${agent}${notices.length ? ` (${notices.join(", ")})` : ""}.`, skills: skillsReport() };
    }
    if (action === "remove") {
        const removed = removeExternalSkill(name);
        return removed.length
            ? { ok: true, note: `Removed ${name} from ${removed.join(", ")}.`, skills: skillsReport() }
            : { ok: false, error: `external skill not found: ${name}` };
    }
    return { ok: false, error: `unknown action: ${action}` };
}
