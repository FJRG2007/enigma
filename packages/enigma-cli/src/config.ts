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

import { join } from "node:path";
import { isDir, readJson, enigmaHome } from "./util";
import { decryptSecret, encryptSecret } from "./secret-box";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

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

/**
 * What a skill update does to a skill the user edited locally (a "tampered" copy).
 * "overwrite" (default) replaces it with the new shipped version - local edits are lost;
 * "keep" preserves the user's edited copy and skips the update for it.
 */
export type SkillUpdatePolicy = "overwrite" | "keep";
export const SKILL_UPDATE_POLICIES: readonly SkillUpdatePolicy[] = ["overwrite", "keep"];

/**
 * LLM provider used to curate recall memory. "claude-local" reuses the local Claude Code
 * login (no API key). "anthropic" uses an Anthropic API key. "openai" targets any
 * OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, Groq, Gemini's compat
 * endpoint, local Ollama/LM Studio) via recallApiBase + recallApiKey.
 */
export type RecallProvider = "claude-local" | "anthropic" | "openai";
export const RECALL_PROVIDERS: readonly RecallProvider[] = ["claude-local", "anthropic", "openai"];

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
    /** On update, overwrite (default) or keep a skill the user edited locally. */
    skillUpdatePolicy: SkillUpdatePolicy;
    /** Master switch for applying permission bypass on install (default on). */
    permissionBypass: boolean;
    /** Auto-lint edited files via a post-write hook (opt-in; installs @enigmax/linter on enable). */
    autoLint: boolean;
    /** Deploy the context-compression MCP server (enigma_compress/retrieve/stats) into managed agents (opt-in). */
    compress: boolean;
    /** EXPERIMENTAL, default off: the local AI quality gate. Enabling deploys the /gate command so agents can drive it; nothing runs until you `enigma gate init` a repo. */
    gate: boolean;
    /** Local savings dashboard: off | on-demand (default when enabled) | always (background daemon). */
    dashboard: DashboardMode;
    /** Dashboard money estimate: USD per 1M input tokens; 0 = use per-source defaults. */
    tokenPrice: number;
    /** Dashboard time estimate: model prefill speed in tokens/sec; 0 = use the default rate. */
    tokenSpeed: number;
    /** Read the agent's own session transcripts for real token usage + cache savings (opt-in). */
    usageStats: boolean;
    /** Build a local session-memory store from transcripts (recall), searchable + MCP-exposed (opt-in). */
    recall: boolean;
    /** Curate/generate recall observations with an LLM (default on; degrades to the deterministic heuristic with no provider creds). */
    recallLlm: boolean;
    /** Which LLM provider curates recall memory (claude-local | anthropic | openai-compatible). */
    recallProvider: RecallProvider;
    /** Model id for recall curation; empty = the provider's default. */
    recallModel: string;
    /** Base URL for the anthropic/openai-compatible provider; empty = the provider's default. */
    recallApiBase: string;
    /** API key for the anthropic/openai provider; empty = none. ENIGMA_RECALL_API_KEY overrides it and is preferred (kept out of config files). */
    recallApiKey: string;
    /** Experimental: route `enigma claude` through a local measuring proxy (opt-in, default off, Claude Code only). */
    proxy: boolean;
    /**
     * Actively probe Anthropic for the REAL usage windows (the %/reset Claude's own UI shows),
     * using the local Claude Code OAuth token, so the dashboard shows live percentages without
     * the proxy or live traffic (opt-in, default off, Claude Code only). It makes one throttled
     * network call with the user's token and consumes a tiny amount of quota - see claude-usage-api.ts.
     */
    usageApi: boolean;
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
    planWeeklyOpusLimit: number;
    /** Weekly window reset anchor as "<weekday> HH:MM" in local time (e.g. "mon 11:00"). */
    planWeeklyReset: string;
    /** Dashboard auto-refreshes its data while the tab is focused (default on; off = manual refresh only). */
    dashboardLive: boolean;
    /**
     * Preferred port for the local dashboard server. 0 = auto (try 80, then 24282, then an
     * ephemeral port). When set (1-65535) it is tried first, falling back to the defaults if
     * busy, so the dashboard always opens. Changing it needs a dashboard restart to rebind.
     */
    dashboardPort: number;
    /**
     * Persisted absolute launch path per tool, keyed by tool name (e.g. claude).
     * Set by `enigma fix-path` when a tool is installed but not on PATH; consumed by
     * launchTool (accounts.ts) between the ENIGMA_<TOOL>_BIN env override and a plain
     * PATH lookup, so `enigma <tool>` works even when the shell PATH does not find it.
     */
    toolPaths: Record<string, string>;
    /** Agents the user explicitly opted out of bypass; never auto-enabled even when permissionBypass is on. */
    bypassDisabled: string[];
    /** Skills the user discarded: removed from deployments and skipped by installs/updates until restored. */
    discardedSkills: string[];
    /**
     * Per-agent skill opt-outs: skillName -> agent names to skip for that skill. A skill
     * deploys to an agent unless it is globally discarded OR that agent is listed here, so
     * you can keep a skill for Claude Code but not OpenCode, for example.
     */
    skillAgentsOff: Record<string, string[]>;
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
    autoSync: true, remoteSkills: true, skillUpdatePolicy: "overwrite", permissionBypass: true, autoLint: false, compress: false, gate: false, dashboard: "off", tokenPrice: 0, tokenSpeed: 0, usageStats: false, recall: false, recallLlm: true, recallProvider: "claude-local", recallModel: "", recallApiBase: "", recallApiKey: "", proxy: false, usageApi: false, promptSecretGuard: false, promptSecretMode: "redact",
    planSessionLimit: 0, planWeeklyLimit: 0, planWeeklySonnetLimit: 0, planWeeklyOpusLimit: 0, planWeeklyReset: "mon 00:00",
    dashboardLive: true, dashboardPort: 0, toolPaths: {}, bypassDisabled: [], discardedSkills: [], skillAgentsOff: {},
};

export type EnigmaConfigKey = keyof EnigmaConfig;

function configPath(scope: "global" | "local"): string {
    // Global lives in the home dir (enigmaHome honors ENIGMA_CONFIG_HOME); local is the
    // nearest repo .enigma.json (current working directory).
    if (scope === "local") return join(process.cwd(), CONFIG_FILE);
    return join(enigmaHome(), CONFIG_FILE);
}

/** Merge the given .enigma.json files in order (nearest last), over the defaults. */
function mergeConfigFiles(paths: string[]): { config: EnigmaConfig; sources: string[] } {
    const sources: string[] = [];
    let config: EnigmaConfig = { ...CONFIG_DEFAULTS };
    for (const path of paths) {
        const raw = existsSync(path) ? readJson<Partial<EnigmaConfig>>(path) : null;
        if (raw) { config = { ...config, ...raw }; sources.push(path); }
    }
    return { config, sources };
}

/** Effective config plus the files that contributed, nearest (local) last. */
export function readConfig(): { config: EnigmaConfig; sources: string[] } {
    return mergeConfigFiles([configPath("global"), configPath("local")]);
}

/**
 * Effective config as seen from a specific project dir: global then that project's
 * own .enigma.json. Used by the dashboard to manage a project by path (its cwd is
 * the dashboard's, not the project's), so it never relies on process.cwd().
 */
export function readConfigAt(projectDir: string): EnigmaConfig {
    return mergeConfigFiles([configPath("global"), join(projectDir, CONFIG_FILE)]).config;
}

/** Only the keys a project's own .enigma.json sets (no global merge), for "what is overridden here". */
export function readProjectConfig(projectDir: string): Partial<EnigmaConfig> {
    const path = join(projectDir, CONFIG_FILE);
    return (existsSync(path) ? readJson<Partial<EnigmaConfig>>(path) : null) || {};
}

/** Write the merged object to `path`, creating its dir. Shared by every config writer. */
function writeConfigFile(path: string, next: Record<string, unknown>): string {
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return path;
}

/**
 * Set a single key in the chosen scope's .enigma.json, preserving any other keys
 * already present. Accepts boolean toggles and string-valued settings alike.
 * Returns the written file path.
 */
export function setEnigmaValue(key: EnigmaConfigKey, value: boolean | number | string | string[], scope: "global" | "local"): string {
    const path = configPath(scope);
    return writeConfigFile(path, { ...(readJson<Record<string, unknown>>(path) || {}), [key]: value });
}

/** Set a key in a specific project's .enigma.json (path-scoped twin of setEnigmaValue local). */
export function setEnigmaValueAt(projectDir: string, key: EnigmaConfigKey, value: boolean | number | string | string[]): string {
    const path = join(projectDir, CONFIG_FILE);
    return writeConfigFile(path, { ...(readJson<Record<string, unknown>>(path) || {}), [key]: value });
}

/** Remove a key from a project's .enigma.json so it inherits the global value again. Returns the path. */
export function unsetEnigmaValueAt(projectDir: string, key: EnigmaConfigKey): string {
    const path = join(projectDir, CONFIG_FILE);
    const current = readJson<Record<string, unknown>>(path) || {};
    delete current[key];
    return writeConfigFile(path, current);
}

/** Boolean-toggle convenience over setEnigmaValue, for the on/off settings. */
export function setEnigmaToggle(key: EnigmaConfigKey, value: boolean, scope: "global" | "local"): string {
    return setEnigmaValue(key, value, scope);
}

/**
 * The recall provider API key, decrypted (empty when unset). The stored field is encrypted at
 * rest (see secret-box.ts); decryptSecret passes through any legacy plain-text value unchanged.
 * ENIGMA_RECALL_API_KEY still takes precedence and is read by the caller, not here.
 */
export function getRecallApiKey(config: EnigmaConfig): string {
    return decryptSecret(config.recallApiKey || "");
}

/** Persist the recall API key encrypted at rest (empty clears it). Returns the written path. */
export function setRecallApiKey(value: string, scope: "global" | "local"): string {
    return setEnigmaValue("recallApiKey", value ? encryptSecret(value) : "", scope);
}

/**
 * Persist `binPath` as the launch path for `tool` in the chosen scope's
 * .enigma.json, merging into the existing toolPaths map so other tools' fixes are
 * preserved. Returns the written file path. Used by `enigma fix-path`.
 */
export function setToolPath(tool: string, binPath: string, scope: "global" | "local" = "global"): string {
    const path = configPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const existing = (current.toolPaths && typeof current.toolPaths === "object") ? current.toolPaths as Record<string, string> : {};
    const next = { ...current, toolPaths: { ...existing, [tool]: binPath } };
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return path;
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

/**
 * Turn a skill off (`off=true`) or back on for ONE agent in the global
 * `skillAgentsOff` map. An empty agent list is removed so the map stays clean.
 * Deployment cleanup (prune from that agent) lives in skills.ts.
 */
export function setSkillAgentOff(skill: string, agent: string, off: boolean): void {
    const path = configPath("global");
    const current = readJson<Record<string, unknown>>(path) || {};
    const existing = (current.skillAgentsOff && typeof current.skillAgentsOff === "object") ? current.skillAgentsOff as Record<string, string[]> : {};
    const list = new Set(Array.isArray(existing[skill]) ? existing[skill] : []);
    if (off) list.add(agent); else list.delete(agent);
    const nextMap = { ...existing };
    if (list.size) nextMap[skill] = [...list]; else delete nextMap[skill];
    const next = { ...current, skillAgentsOff: nextMap };
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
}
