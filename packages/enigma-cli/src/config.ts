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
 * Which interface the dashboard binds. "loopback" (default) is reachable only from this
 * machine; "lan" binds every interface; "custom" binds `dashboardBindAddress` (use it to
 * pin one interface, e.g. a Tailscale IP). The dashboard is an admin surface - it can run
 * agents with your credentials, kill processes and rewrite config - so a non-loopback bind
 * REFUSES to start without a shared-secret token, and never binds unauthenticated.
 */
export type DashboardBind = "loopback" | "lan" | "custom";
export const DASHBOARD_BINDS: readonly DashboardBind[] = ["loopback", "lan", "custom"];

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
 * How the agent resolves a logo/background contrast clash (logo-sourcing-policy). "ask"
 * (default) stops and asks the user; "adapt-background" adds a contrasting container behind
 * the logo and keeps its official colors; "adapt-logo" recolors the logo (or swaps to the
 * opposite brand variant) to fit the background. Deployed as a memory-file placeholder
 * (see skills.ts renderMemory), so the agent always knows the active mode.
 */
export type LogoColorPolicy = "ask" | "adapt-background" | "adapt-logo";
export const LOGO_COLOR_POLICIES: readonly LogoColorPolicy[] = ["ask", "adapt-background", "adapt-logo"];

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
    /** How the agent resolves a logo/background contrast clash; deployed as a memory placeholder. */
    logoColorPolicy: LogoColorPolicy;
    /** Silently re-deploy updated skills/memory when launching a tool through enigma. */
    autoSync: boolean;
    /**
     * Agent status bar (default on): points Claude Code's statusLine at `enigma statusline`,
     * which shows the badge, model, context and cost, plus live gate progress during a run.
     * This records the INTENT; the effect lives in Claude's settings.json. Both are needed:
     * without the flag, "the user turned it off" would be indistinguishable from "never
     * installed", and every sync would silently reinstall a bar they deliberately removed.
     */
    statusline: boolean;
    /**
     * Pre-answer Claude Code's "Is this a project you trust?" prompt (default on, Claude
     * Code only). Same intent/effect split as `statusline`: this records the choice and the
     * effect is written into Claude's own `.claude.json`, so a deliberate off is never
     * re-applied by the next install or sync. A security trade-off by design - the prompt
     * exists to make you review unfamiliar code before an agent runs in it. See claude.ts.
     */
    claudeTrust: boolean;
    /** Fetch newer skills from the GitHub repo (install/update) without a package update. */
    remoteSkills: boolean;
    /** On update, overwrite (default) or keep a skill the user edited locally. */
    skillUpdatePolicy: SkillUpdatePolicy;
    /** Master switch for applying permission bypass on install (default on). */
    permissionBypass: boolean;
    /** Auto-lint edited files via a post-write hook (opt-in; installs @enigmax/linter on enable). */
    autoLint: boolean;
    /**
     * Enforce project conventions via a post-edit hook (default on): after an agent writes a
     * file, data-driven rules run (e.g. UUID primary keys, Prisma as the default ORM) and any
     * violation is fed back so the model self-corrects in the same turn. Rules live in
     * ~/.enigma-guardrails.json and guardrails.ts; a commit/CI backstop mirrors them. Rules marked
     * `stage: "diff"` run instead in the turn-end sweep, over the lines the change added (verify.ts),
     * which a repo-local `guardrails: false` stands down for that project. See guardrails.ts.
     */
    guardrails: boolean;
    /**
     * Remove the blank line agents leave at the end of a file (default on): a post-edit hook
     * tidies the file just written, and a pre-commit step tidies the staged ones and re-stages
     * them. Only a file with real content followed by blank lines is touched. See trim.ts.
     */
    trim: boolean;
    /**
     * Check completion claims against the work actually produced, via a turn-end hook
     * (default on, Claude Code only - the one agent with a turn-end hook that can deny the
     * stop). When the agent's final message says the work is finished, enigma scans the
     * code that turn produced for incompleteness markers and runs `verifyCommand`; evidence
     * to the contrary is fed back and the stop is denied. See verify.ts.
     */
    verify: boolean;
    /**
     * The project's own verification command (e.g. "npm test"), run by the completion gate
     * before a "done" claim is allowed through. Empty = markers only. Read from the GLOBAL
     * config only: a repo-local .enigma.json travels with a clone, so honouring one here
     * would let a cloned repository run a command on the machine that opens it.
     */
    verifyCommand: string;
    /** Deploy the context-compression MCP server (enigma_compress/retrieve/stats) into managed agents (opt-in). */
    compress: boolean;
    /** Expose enigma's native code-graph tools (index a codebase into a knowledge graph of symbols/imports/references) to agents over MCP (opt-in). */
    codeGraph: boolean;
    /** EXPERIMENTAL but ON by default: the local AI quality gate. Deploys the /gate command AND renders an always-on memory block telling agents to auto-drive the gate once a code task is committed (auto `enigma gate init`, no prompt needed); per-project opt-out via a repo `.enigma.json` gate:false (nearest-wins). */
    gate: boolean;
    /**
     * Branches the gate refuses to validate, by exact name. Empty by default: the gate runs on
     * whatever branch the work is on, the default branch included. List a branch here to keep the
     * pipeline off it - the one thing to know is that on the default branch the pipeline opens no
     * PR (there is nothing to open it against) and its push lands straight on that branch, so a
     * repository where the default branch must only ever be reached through review belongs here.
     * Merged nearest-wins like every other key, so a repo's own .enigma.json overrides the global list.
     */
    gateProtectedBranches: string[];
    /** Local savings dashboard: off | on-demand (default when enabled) | always (background daemon). */
    dashboard: DashboardMode;
    /** Dashboard money estimate: USD per 1M input tokens; 0 = use per-source defaults. */
    tokenPrice: number;
    /** Dashboard time estimate: model prefill speed in tokens/sec; 0 = use the default rate. */
    tokenSpeed: number;
    /** Percentage of the machine work an agent executes may occupy (cores, concurrency). */
    resourceCap: number;
    /** On a machine with 16 GB RAM or less, the memory-use percentage that blocks heavy work. */
    lowMemoryCap: number;
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
     * Which interface the dashboard binds (default "loopback" = this machine only). Anything
     * else needs a shared-secret token and refuses to start without one. Changing it needs a
     * dashboard restart to rebind.
     */
    dashboardBind: DashboardBind;
    /** Interface address for `dashboardBind: "custom"` (e.g. a Tailscale IP). Ignored otherwise. */
    dashboardBindAddress: string;
    /**
     * Preferred port for the local OpenAI-compatible API server (`enigma api`), which exposes
     * the local Claude Code over an HTTP API. Default 8000; overridable per run with --port.
     */
    apiPort: number;
    /**
     * Default context the local API server (`enigma api`) runs requests under, settable from
     * the dashboard or CLI. Empty = the active account. A `--account`/`--profile`/`--pack` flag
     * or a per-request account/profile/pack field overrides these. `apiPack` wins over the others.
     */
    apiAccount: string;
    apiProfile: string;
    apiPack: string;
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
    /**
     * Optional packs the user has added from the marketplace (e.g. "helio"). A pack is an
     * isolated harness bundle (skills/commands/agents/MCP) fetched on demand and deployed only
     * into its own dedicated agent context (see packs.ts), so it never loads into the normal
     * agent. This list is the durable record of which packs are added; the pack's npm bundle
     * presence under ~/.enigma/packs is the fetch state.
     */
    packs: string[];
    /**
     * Default account per pack+tool that seeds the pack's isolated context, keyed by
     * "<packId>:<tool>" -> account name. Lets a pack run under a different login than your
     * everyday active one (e.g. a dedicated pentest account for Helio). When unset, the pack
     * falls back to the active profile's mapping, then the tool's active account.
     */
    packAccounts: Record<string, string>;
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
 * verify is ON by default: a completion claim being checked against the work actually
 * produced is a baseline enigma behavior, not an extra. It costs nothing on a turn that
 * claims nothing, only fires on evidence the claim is false, and stands down after two
 * blocks on the same findings (and an absolute ceiling per session), so it cannot trap a
 * turn. verifyCommand stays empty by default - running a project command automatically is
 * the user's explicit choice.
 * gate is ON by default despite being experimental: work that never reaches the gate is
 * work nothing reviewed, so the pipeline has to be the default path rather than something
 * the user remembers to switch on. It costs nothing until a code task is committed, and it
 * opts out per project (a repo `.enigma.json` gate: false) as well as globally. Both effects
 * - the /gate command and the memory block - are re-asserted by syncDeployed, so `enigma
 * update` delivers them to an existing deployment instead of waiting for a fresh install.
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
    commitEmoji: true, updateNotifier: true, fullscreen: true, parallelSubagents: false, outputStyle: "off", minimalCode: "full", logoColorPolicy: "ask",
    autoSync: true, statusline: true, claudeTrust: true, remoteSkills: true, skillUpdatePolicy: "overwrite", permissionBypass: true, autoLint: false, guardrails: true, trim: true, verify: true, verifyCommand: "", compress: false, codeGraph: false, gate: true, dashboard: "off", tokenPrice: 0, tokenSpeed: 0, usageStats: false, recall: false, recallLlm: true, recallProvider: "claude-local", recallModel: "", recallApiBase: "", recallApiKey: "", proxy: false, usageApi: false, promptSecretGuard: false, promptSecretMode: "redact",
    resourceCap: 60, lowMemoryCap: 80,
    planSessionLimit: 0, planWeeklyLimit: 0, planWeeklySonnetLimit: 0, planWeeklyOpusLimit: 0, planWeeklyReset: "mon 00:00",
    dashboardLive: true, dashboardPort: 0, dashboardBind: "loopback", dashboardBindAddress: "", apiPort: 8000, apiAccount: "", apiProfile: "", apiPack: "", toolPaths: {}, bypassDisabled: [], discardedSkills: [], skillAgentsOff: {}, packs: [], packAccounts: {}, gateProtectedBranches: [],
};

export type EnigmaConfigKey = keyof EnigmaConfig;

function configPath(scope: "global" | "local"): string {
    // Global lives in the home dir (enigmaHome honors ENIGMA_CONFIG_HOME); local is the
    // nearest repo .enigma.json (current working directory).
    if (scope === "local") return join(process.cwd(), CONFIG_FILE);
    return join(enigmaHome(), CONFIG_FILE);
}

/** Merge the given .enigma.json files in order (nearest last), over the defaults. */
function mergeConfigFiles(paths: string[]): { config: EnigmaConfig; sources: string[]; } {
    const sources: string[] = [];
    let config: EnigmaConfig = { ...CONFIG_DEFAULTS };
    for (const path of paths) {
        const raw = existsSync(path) ? readJson<Partial<EnigmaConfig>>(path) : null;
        if (raw) { config = { ...config, ...raw }; sources.push(path); }
    }
    return { config, sources };
}

/** Effective config plus the files that contributed, nearest (local) last. */
export function readConfig(): { config: EnigmaConfig; sources: string[]; } {
    return mergeConfigFiles([configPath("global"), configPath("local")]);
}

/**
 * Config from the global ~/.enigma.json only, ignoring any repo-local one.
 *
 * For host-level decisions that repo content must never influence - notably which interface the
 * dashboard binds. A repo's .enigma.json is committable and travels with a clone, so honouring
 * it there would let a cloned repository open a port on the machine that runs enigma inside it.
 */
export function readGlobalConfig(): EnigmaConfig {
    return mergeConfigFiles([configPath("global")]).config;
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

/**
 * Persist a pack's default seeding account, keyed by "<packId>:<tool>". A null account clears
 * the entry (the pack falls back to the active profile / tool-active account). Merges into the
 * existing packAccounts map so other packs' defaults are preserved. Returns the written path.
 */
export function setPackAccount(key: string, account: string | null, scope: "global" | "local" = "global"): string {
    const path = configPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const existing = (current.packAccounts && typeof current.packAccounts === "object") ? { ...current.packAccounts as Record<string, string> } : {};
    if (account === null) delete existing[key]; else existing[key] = account;
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...current, packAccounts: existing }, null, 2)}\n`);
    return path;
}

/** Keys of EnigmaConfig holding a string list, maintained as a set in the config file. */
type ListConfigKey = { [K in EnigmaConfigKey]: EnigmaConfig[K] extends string[] ? K : never }[EnigmaConfigKey];

/**
 * Add (include=true) or remove (false) an entry in one of the .enigma.json string-list
 * keys. Operates on that scope's own list, not the merged view, so a deliberate opt-out
 * survives future installs and a project list never absorbs the global one.
 */
export function updateEnigmaList(key: ListConfigKey, name: string, include: boolean, scope: "global" | "local"): string {
    const set = new Set((readJson<Partial<EnigmaConfig>>(configPath(scope)) || {})[key] || []);
    if (include) set.add(name); else set.delete(name);
    return setEnigmaValue(key, [...set], scope);
}

/** Reads one scope's own string list, bypassing the merged view (for editing surfaces). */
export function readEnigmaList(key: ListConfigKey, scope: "global" | "local"): string[] {
    return (readJson<Partial<EnigmaConfig>>(configPath(scope)) || {})[key] || [];
}

function updateGlobalList(key: ListConfigKey, name: string, include: boolean): void {
    updateEnigmaList(key, name, include, "global");
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
