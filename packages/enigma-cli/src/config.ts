/**
 * User-facing enigma runtime config (.enigma.json). Small, optional, and read by
 * the coding agent itself - it is how a user opts out of behaviors the policy
 * skills enable by default (e.g. commit-message emojis, update notifications).
 *
 * Precedence when reading: built-in defaults, overridden by the global file
 * (~/.enigma.json), overridden by a repo-local file (<cwd>/.enigma.json). A skill
 * rule only persuades the model; this file is the deterministic toggle it checks.
 *
 * This module is the data layer for .enigma.json only. The CLI/TUI config surface
 * (key registry, `enigma config` command, interactive menu) lives in settings.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isDir, readJson } from "./util";

export const CONFIG_FILE = ".enigma.json";

/**
 * Output compression level for agent prose replies. "off" disables it; the rest are
 * graded terseness, deployed as a memory-file section (see skills.ts renderMemory).
 * "lite" is professional terse (keeps grammar/language), "full"/"ultra" go shorter.
 */
export type OutputStyle = "off" | "lite" | "full" | "ultra";
export const OUTPUT_STYLES: readonly OutputStyle[] = ["off", "lite", "full", "ultra"];

/**
 * Minimal-code (anti-overengineering) intensity. "off" disables it; the rest grade how
 * aggressively the agent prefers the laziest solution that works, deployed as a memory-file
 * section (see skills.ts renderMemory) keyed to anti-overengineering-policy. "lite" only
 * names a lazier alternative, "full" enforces the YAGNI ladder, "ultra" is YAGNI-extremist.
 */
export type MinimalCode = "off" | "lite" | "full" | "ultra";
export const MINIMAL_CODE_LEVELS: readonly MinimalCode[] = ["off", "lite", "full", "ultra"];

/**
 * Local savings dashboard run mode. "off" disables it; "on-demand" serves only while
 * `enigma dashboard` runs (zero idle cost, the default when enabled); "always" keeps a
 * lightweight background daemon so http://enigma is reachable any time.
 */
export type DashboardMode = "off" | "on-demand" | "always";
export const DASHBOARD_MODES: readonly DashboardMode[] = ["off", "on-demand", "always"];

/**
 * What the prompt secret guard does when it finds a credential in a chat message on
 * its way to Claude (via the proxy). "redact" replaces the secret with a placeholder
 * so the key never reaches the model but the turn still works; "reject" blocks the
 * whole request so nothing reaches Claude.
 */
export type PromptSecretMode = "redact" | "reject";
export const PROMPT_SECRET_MODES: readonly PromptSecretMode[] = ["redact", "reject"];

export interface EnigmaConfig {
    commitEmoji: boolean;
    updateNotifier: boolean;
    fullscreen: boolean;
    parallelSubagents: boolean;
    outputStyle: OutputStyle;
    /** Anti-overengineering intensity for code the agent writes; deployed as a memory section. */
    minimalCode: MinimalCode;
    /** Silently re-deploy updated skills/memory when launching a tool through enigma. */
    autoSync: boolean;
    /** Fetch newer skills from the GitHub repo (install/update) without a package update. */
    remoteSkills: boolean;
    /** Master switch for applying permission bypass on install (default on). */
    permissionBypass: boolean;
    /** Auto-lint edited files via a post-write hook (opt-in; installs @enigmax/linter on enable). */
    autoLint: boolean;
    /** Deploy the context-compression MCP server (enigma_compress/retrieve/stats) into managed agents (opt-in). */
    compress: boolean;
    /** Local savings dashboard: off | on-demand (default when enabled) | always (background daemon). */
    dashboard: DashboardMode;
    /** Dashboard money estimate: USD per 1M input tokens; 0 = use per-source defaults. */
    tokenPrice: number;
    /** Dashboard time estimate: model prefill speed in tokens/sec; 0 = use the default rate. */
    tokenSpeed: number;
    /** Read the agent's own session transcripts for real token usage + cache savings (opt-in). */
    usageStats: boolean;
    /** Experimental: route `enigma claude` through a local measuring proxy (opt-in, default off, Claude Code only). */
    proxy: boolean;
    /**
     * Block secrets in chat prompts before they reach the agent (opt-in, default off,
     * Claude Code only). When on, `enigma claude` routes through the proxy and scans
     * outgoing messages for credentials. A deliberate security feature that inspects
     * request bodies, so it stays an explicit choice.
     */
    promptSecretGuard: boolean;
    /** What the prompt secret guard does on a hit: redact (default) or reject the request. */
    promptSecretMode: PromptSecretMode;
    /** Plan token limits for the usage windows (Claude-style gauges); 0 = unset (show tokens, no %). */
    planSessionLimit: number;
    planWeeklyLimit: number;
    planWeeklySonnetLimit: number;
    /** Weekly window reset anchor as "<weekday> HH:MM" in local time (e.g. "mon 11:00"). */
    planWeeklyReset: string;
    /** Dashboard auto-refreshes its data while the tab is focused (default on; off = manual refresh only). */
    dashboardLive: boolean;
    /** Agents the user explicitly opted out of bypass; never auto-enabled even when permissionBypass is on. */
    bypassDisabled: string[];
    /** Skills the user discarded: removed from deployments and skipped by installs/updates until restored. */
    discardedSkills: string[];
}

/**
 * Built-in defaults: everything the skills enable is on unless opted out.
 * fullscreen clears the screen so the TUI renders cleanly (on by default); it uses
 * an OS-agnostic clear rather than the alternate screen buffer, so exiting returns
 * to the shell without wiping/restoring the terminal.
 * parallelSubagents is opt-in (off): spawning sub-agents in parallel multiplies
 * token cost, so it stays explicit. When on, the deployed memory file gains the
 * parallel sub-agent section (subtask decomposition itself is always on).
 * outputStyle is opt-in (off): it changes the voice of every reply, so it is an
 * explicit choice. When not off, the memory file gains the token-efficient output
 * section keyed to the chosen level.
 * minimalCode is ON by default (full): the laziest-solution-that-works discipline is
 * a baseline enigma behavior, so the deployed memory file gains the anti-overengineering
 * section keyed to the chosen level unless the user opts out (minimal-code off). Security,
 * trust-boundary validation, data-loss handling and accessibility are never simplified
 * away (see anti-overengineering-policy "When NOT to Be Lazy").
 * permissionBypass is on by default: every install enables each agent's bypass
 * (approval prompts off) unless the user opts out globally (this flag) or per-agent
 * (bypassDisabled). It is a deliberate security downgrade - keep it visible in output.
 * autoSync is on by default: launching a tool through enigma (e.g. `enigma claude`)
 * refreshes an EXISTING deployment so package updates apply without re-running
 * `enigma install`. It never creates a first deployment (that stays explicit consent).
 * remoteSkills is on by default: `enigma install`/`enigma update` check the GitHub
 * repo for skills newer than the bundled ones and cache verified downloads, so
 * skill fixes reach users without waiting for an npm release (skills-remote.ts).
 * autoLint is opt-in (off): enabling it autonomously installs @enigmax/linter and
 * wires a post-write hook into each agent (auto-fix + surface only unfixable
 * findings). It changes agent behavior and installs a package, so it stays explicit.
 * compress is opt-in (off): when on, installs/syncs register enigma's compression
 * MCP server (enigma_compress/retrieve/stats) in each managed agent's config so the
 * agent can shrink large tool outputs. Adding an MCP server to the user's agents is
 * a meaningful change, so it stays an explicit choice; turning it off removes the entry.
 * dashboard is opt-in (off): enabling defaults to on-demand, which runs the local
 * savings dashboard only while `enigma dashboard` is open (no idle cost). "always" keeps
 * a background daemon, a deliberate trade for always-on reachability at http://enigma.
 * usageStats is opt-in (off): when on, the dashboard reads the agent's own session
 * transcripts (Claude Code only today) to show REAL token consumption and REAL prompt-cache
 * savings. These are the user's own session logs, broader than enigma's CCR data, so
 * reading them stays an explicit choice; it never attributes savings to a skill (a
 * transcript has no counterfactual baseline - see usage.ts).
 */
export const CONFIG_DEFAULTS: EnigmaConfig = {
    commitEmoji: true, updateNotifier: true, fullscreen: true, parallelSubagents: false, outputStyle: "off", minimalCode: "full",
    autoSync: true, remoteSkills: true, permissionBypass: true, autoLint: false, compress: false, dashboard: "off", tokenPrice: 0, tokenSpeed: 0, usageStats: false, proxy: false, promptSecretGuard: false, promptSecretMode: "redact",
    planSessionLimit: 0, planWeeklyLimit: 0, planWeeklySonnetLimit: 0, planWeeklyReset: "mon 00:00",
    dashboardLive: true, bypassDisabled: [], discardedSkills: [],
};

export type EnigmaConfigKey = keyof EnigmaConfig;

function configPath(scope: "global" | "local"): string {
    return scope === "global" ? join(homedir(), CONFIG_FILE) : join(process.cwd(), CONFIG_FILE);
}

/** Effective config plus the files that contributed, nearest (local) last. */
export function readConfig(): { config: EnigmaConfig; sources: string[] } {
    const sources: string[] = [];
    let config: EnigmaConfig = { ...CONFIG_DEFAULTS };
    for (const scope of ["global", "local"] as const) {
        const path = configPath(scope);
        const raw = existsSync(path) ? readJson<Partial<EnigmaConfig>>(path) : null;
        if (raw) { config = { ...config, ...raw }; sources.push(path); }
    }
    return { config, sources };
}

/**
 * Set a single key in the chosen scope's .enigma.json, preserving any other keys
 * already present. Accepts boolean toggles and string-valued settings alike.
 * Returns the written file path.
 */
export function setEnigmaValue(key: EnigmaConfigKey, value: boolean | number | string | string[], scope: "global" | "local"): string {
    const path = configPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const next = { ...current, [key]: value };
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return path;
}

/** Boolean-toggle convenience over setEnigmaValue, for the on/off settings. */
export function setEnigmaToggle(key: EnigmaConfigKey, value: boolean, scope: "global" | "local"): string {
    return setEnigmaValue(key, value, scope);
}

/** Keys of EnigmaConfig holding a string list, maintained as a set in the global file. */
type ListConfigKey = { [K in EnigmaConfigKey]: EnigmaConfig[K] extends string[] ? K : never }[EnigmaConfigKey];

/**
 * Add (include=true) or remove (false) an entry in one of the global .enigma.json
 * string-list keys. Operates on the global file's own list, not the merged view,
 * so a deliberate opt-out survives future installs.
 */
function updateGlobalList(key: ListConfigKey, name: string, include: boolean): void {
    const set = new Set((readJson<Partial<EnigmaConfig>>(configPath("global")) || {})[key] || []);
    if (include) set.add(name); else set.delete(name);
    setEnigmaValue(key, [...set], "global");
}

/**
 * Record (disabled=true) or clear (false) a per-agent permission-bypass opt-out in
 * the global .enigma.json `bypassDisabled` list, so a deliberate "off" survives
 * future installs and is never auto-re-enabled.
 */
export function setBypassDisabled(name: string, disabled: boolean): void {
    updateGlobalList("bypassDisabled", name, disabled);
}

/**
 * Record (discarded=true) or clear (false) a skill discard in the global
 * .enigma.json `discardedSkills` list. A discarded skill is never installed or
 * updated until restored; deployment cleanup lives in skills.ts (discardSkill).
 */
export function setSkillDiscarded(name: string, discarded: boolean): void {
    updateGlobalList("discardedSkills", name, discarded);
}
