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
import { GUARD_PROTECTIONS, readGlobalGuard } from "./guard-config";
import { toolPathStatuses } from "./tool-path";
import { availableAdapters } from "./api-agents";

export interface SystemsStatus {
    /** Context-compression MCP deployed into agents. */
    compress: boolean;
    /** Codebase-memory (code graph) MCP registered in agents. */
    codeGraph: boolean;
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
    /** Dashboard auto-refreshes while focused (the HTML polls only when this is true). */
    live: boolean;
    /** Experimental Claude Code proxy enabled. */
    proxy: boolean;
    /** Live usage probe enabled (fetch real usage windows via the local Claude Code login). */
    usageApi: boolean;
    /** Prompt secret guard enabled (blocks credentials in chat prompts via the proxy). */
    promptSecretGuard: boolean;
    /** What the prompt guard does on a hit: "redact" or "reject". */
    promptSecretMode: string;
    /**
     * Real token usage measured by the proxy so far (zeros when it has never run);
     * `lastRequestAt` is epoch ms of the last measured request, `redacted`/`rejected`/
     * `lastBlockedAt` track the prompt secret guard (0 = none yet).
     */
    proxyStats: { calls: number; input: number; output: number; cacheRead: number; cacheCreation: number; lastRequestAt: number; redacted: number; rejected: number; lastBlockedAt: number };
    /** Security posture: permission-bypass state + the commit guard's fixed protections. */
    security: { permissionBypass: boolean; bypassDisabled: string[]; guardProtects: string[] };
    /** Skill counts across installed agents. */
    skills: { total: number; enigma: number; external: number; disabled: number };
    /** Per-tool launch-path status (name, label, one-line status), for the "Fix tool paths" action. */
    tools: Array<{ name: string; label: string; status: string }>;
    /** Local OpenAI-compatible API server: the configured port, plus the agents it can back. */
    api: { port: number; agents: string[] };
}


/** Read the current configured state of every enigma system, plus skill counts. */
export function systemsStatus(): SystemsStatus {
    const c = readConfig().config;
    const skills = skillsReport();
    const guard = readGlobalGuard();
    return {
        compress: c.compress,
        codeGraph: c.codeGraph,
        outputStyle: c.outputStyle,
        minimalCode: c.minimalCode,
        parallelSubagents: c.parallelSubagents,
        autoLint: c.autoLint,
        usageStats: c.usageStats,
        dashboard: c.dashboard,
        commitEmoji: c.commitEmoji,
        proxy: c.proxy,
        usageApi: c.usageApi,
        promptSecretGuard: c.promptSecretGuard,
        promptSecretMode: c.promptSecretMode,
        live: c.dashboardLive,
        proxyStats: (() => { const p = readProxyStats(); return { calls: p.calls, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheCreation: p.cacheCreation, lastRequestAt: p.lastRequestAt, redacted: p.redacted, rejected: p.rejected, lastBlockedAt: p.lastBlockedAt }; })(),
        security: {
            permissionBypass: c.permissionBypass,
            bypassDisabled: c.bypassDisabled || [],
            // The protections currently enabled in the user-wide guard config (configurable in Settings).
            guardProtects: GUARD_PROTECTIONS.filter((p) => guard[p.value]).map((p) => p.label),
        },
        skills: {
            total: skills.length,
            enigma: skills.filter((s) => s.source === "enigma").length,
            external: skills.filter((s) => s.source === "external").length,
            disabled: skills.filter((s) => s.discarded).length,
        },
        tools: toolPathStatuses().map((t) => ({ name: t.name, label: t.label, status: t.status })),
        api: { port: c.apiPort || 8000, agents: availableAdapters().map((a) => a.tool) },
    };
}
