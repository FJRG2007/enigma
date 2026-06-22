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
import { readProxyStats } from "./proxy";

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
    /** Experimental Claude Code measuring proxy enabled. */
    proxy: boolean;
    /** Real token usage measured by the proxy so far (zeros when it has never run). */
    proxyStats: { calls: number; input: number; output: number; cacheRead: number; cacheCreation: number };
    /** Security posture: permission-bypass state + the commit guard's fixed protections. */
    security: { permissionBypass: boolean; bypassDisabled: string[]; guardProtects: string[] };
    /** Skill counts across installed agents. */
    skills: { total: number; enigma: number; external: number; disabled: number };
}

/** What enigma's commit guard blocks from being committed (fixed behavior; per-repo opt-outs aside). */
const GUARD_PROTECTS = ["API keys / tokens", "private keys (.pem)", ".env files", "node_modules"];

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
        proxy: c.proxy,
        proxyStats: (() => { const p = readProxyStats(); return { calls: p.calls, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheCreation: p.cacheCreation }; })(),
        security: { permissionBypass: c.permissionBypass, bypassDisabled: c.bypassDisabled || [], guardProtects: GUARD_PROTECTS },
        skills: {
            total: skills.length,
            enigma: skills.filter((s) => s.source === "enigma").length,
            external: skills.filter((s) => s.source === "external").length,
            disabled: skills.filter((s) => s.discarded).length,
        },
    };
}
