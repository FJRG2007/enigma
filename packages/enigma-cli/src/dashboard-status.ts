/**
 * Factual "what's active" snapshot for the dashboard overview: which enigma systems are on
 * and how they are configured, plus a skill count. This is STATE, not savings - it never
 * claims a token/time benefit for systems enigma cannot measure (output-style, minimal-code,
 * parallel sub-agents, skills), it just reports their configured value truthfully.
 *
 * dashboard.ts imports this DYNAMICALLY (only when the overview is requested), so there is no
 * static import cycle with skills.ts -> dashboard.ts.
 */

import { readConfig } from "./config";
import { skillsReport } from "./skills";

export interface SystemsStatus {
    /** Context-compression MCP deployed into agents. */
    compress: boolean;
    /** Token-efficient output level: off | lite | full | ultra. */
    outputStyle: string;
    /** Minimal-code (anti-overengineering) level: off | lite | full | ultra. */
    minimalCode: string;
    /** Parallel sub-agents memory section enabled. */
    parallelSubagents: boolean;
    /** Auto-lint on edit. */
    autoLint: boolean;
    /** Real tool-usage stats (transcript reading). */
    usageStats: boolean;
    /** Local dashboard mode: off | on-demand | always. */
    dashboard: string;
    /** Commit-subject emoji. */
    commitEmoji: boolean;
    /** Skill counts across installed agents. */
    skills: { total: number; enigma: number; external: number; disabled: number };
}

/** Read the current configured state of every enigma system, plus skill counts. */
export function systemsStatus(): SystemsStatus {
    const c = readConfig().config;
    const skills = skillsReport();
    return {
        compress: c.compress,
        outputStyle: c.outputStyle,
        minimalCode: c.minimalCode,
        parallelSubagents: c.parallelSubagents,
        autoLint: c.autoLint,
        usageStats: c.usageStats,
        dashboard: c.dashboard,
        commitEmoji: c.commitEmoji,
        skills: {
            total: skills.length,
            enigma: skills.filter((s) => s.source === "enigma").length,
            external: skills.filter((s) => s.source === "external").length,
            disabled: skills.filter((s) => s.discarded).length,
        },
    };
}
