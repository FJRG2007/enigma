/**
 * The single registry of user-configurable enigma options. Pure data layer: each
 * option is declared once with a `read`/`write` pair, so every surface (the Ink
 * settings TUI and the `enigma config` command) consumes the same definitions.
 *
 * Options span two storage layers - enigma's own .enigma.json runtime toggles
 * (config.ts) and each agent's native config files (claude.ts / permissions.ts) -
 * but the registry hides that behind a uniform boolean interface. No UI or I/O
 * framework is imported here, so it stays cheap to load from any surface.
 */

import { AGENTS } from "./agents";
import { applyMcpToggle } from "./mcp-deploy";
import { isAutoLintOn, setAutoLint } from "./lint";
import { readConfig, setEnigmaToggle, setEnigmaValue, setRecallApiKey, RECALL_PROVIDERS, OUTPUT_STYLES, MINIMAL_CODE_LEVELS, LOGO_COLOR_POLICIES, DASHBOARD_MODES, PROMPT_SECRET_MODES, SKILL_UPDATE_POLICIES } from "./config";
import { applyDashboardMode } from "./dashboard";
import { applyGateToggle } from "./command-deploy";
import type { DashboardMode } from "./config";
import { getGhTelemetryCached, ghTelemetryBlocker, hasGhCli, setGhTelemetry } from "./github";
import { getClaudeAttribution, setClaudeAttribution, getClaudeFeedbackSurvey, setClaudeFeedbackSurvey } from "./claude";
import { BYPASS_SUPPORTED, getBypass, setBypass } from "./permissions";
import { GUARD_PROTECTIONS, GUARD_LISTS, readGlobalGuard, setGuardProtection, setGuardList } from "./guard-config";
import type { GuardListMeta } from "./guard-config";
import type { EnigmaConfig, EnigmaConfigKey } from "./config";

export type Scope = "global" | "local";

/** Keys of EnigmaConfig whose value is a boolean (the on/off toggles). */
type BooleanConfigKey = { [K in EnigmaConfigKey]: EnigmaConfig[K] extends boolean ? K : never }[EnigmaConfigKey];

/**
 * `error` is set when the write could not be performed at all (as opposed to `changed:
 * false`, which means the value was already what was asked for). Without it every
 * surface re-read the setting and reported success for a write that never happened.
 */
export interface ApplyResult { path?: string; changed: boolean; error?: string; }

export interface Setting {
    /** Stable CLI key (kebab-case) used by `enigma config <key>`. */
    key: string;
    label: string;
    hint: string;
    /** True when the underlying config is user-global only (no project-local form). */
    globalOnly?: boolean;
    /**
     * True when changing this toggle alters the deployed agent memory file, so the
     * surface must re-render that file and prompt for an agent restart after writing.
     */
    affectsMemory?: boolean;
    /**
     * True when this setting is consumed by a skill (declared in its skill.json config), so
     * changing it re-renders that skill's deployed SKILL.md - config-in-skill instead of the
     * always-on memory file. The surface calls applySkillConfig and prompts for a restart.
     */
    affectsSkills?: boolean;
    /**
     * On/off face of the setting. A multi-value (choice) setting still implements this
     * as "is it enabled" (read) and "enable to the default value / disable" (write), so
     * the boolean TUI and `config <key> <on|off>` keep working unchanged.
     */
    read(scope: Scope): boolean;
    write(value: boolean, scope: Scope): ApplyResult;
    /**
     * Present only on choice (enum) settings. `choices` is the full value set including
     * the "off" value; `readChoice`/`writeChoice` get and set the exact value so the CLI
     * can accept e.g. `config output-style ultra` on top of the on/off face above.
     * `offChoice` names the choice that counts as "off" for display color/boolean face
     * (default "off") - e.g. gh-telemetry's off value is "disabled".
     */
    choices?: readonly string[];
    offChoice?: string;
    readChoice?(scope: Scope): string;
    writeChoice?(value: string, scope: Scope): ApplyResult;
    /**
     * Present only on list settings (a managed string list, e.g. guard block/allow
     * globs and custom secret patterns). `listValues` reads the current items;
     * `addItem`/`removeItem` mutate one entry. The boolean face (`read`) reports
     * whether the list is non-empty so the on/off surfaces still render a sensible
     * value, and `write` is a no-op (lists are edited through add/remove only).
     */
    /**
     * Present only on free-text "value" settings (a single string, e.g. a model id, API base
     * URL or API key). `readValue` returns the current string (a secret setting returns a
     * non-empty sentinel, never the real value); `writeValue` persists it (empty clears).
     * `secret: true` marks a credential so surfaces show "(set)" instead of the value and the
     * TUI never echoes it. The boolean face (`read`) reports whether the value is non-empty.
     */
    kind?: "list" | "value";
    secret?: boolean;
    /** Placeholder/help shown by the add-item input (list) or value input. */
    itemHint?: string;
    valueHint?: string;
    readValue?(scope: Scope): string;
    writeValue?(value: string, scope: Scope): ApplyResult;
    listValues?(scope: Scope): string[];
    addItem?(item: string, scope: Scope): ApplyResult;
    removeItem?(item: string, scope: Scope): ApplyResult;
}

export interface Category {
    title: string;
    blurb: string;
    settings: Setting[];
}

/** Declare an .enigma.json runtime toggle as a registry setting. */
function enigmaToggle(key: string, field: BooleanConfigKey, label: string, hint: string, affectsMemory = false): Setting {
    return {
        key, label, hint, affectsMemory,
        read: () => readConfig().config[field],
        write: (value, scope) => ({ path: setEnigmaToggle(field, value, scope), changed: true }),
    };
}

/**
 * Declare a string-valued .enigma.json setting. It exposes a boolean face (enabled =
 * value is not `offValue`; enabling sets `enabledDefault`) so the on/off TUI and CLI
 * still drive it, plus choice accessors so the CLI can set an exact value.
 */
function enigmaChoice(
    key: string, field: EnigmaConfigKey, label: string, hint: string,
    choices: readonly string[], enabledDefault: string, affectsMemory = false, offValue = "off", affectsSkills = false,
): Setting {
    return {
        key, label, hint, affectsMemory, affectsSkills, choices, offChoice: offValue,
        read: () => readConfig().config[field] !== offValue,
        write: (value, scope) => ({ path: setEnigmaValue(field, value ? enabledDefault : offValue, scope), changed: true }),
        readChoice: () => String(readConfig().config[field]),
        writeChoice: (value, scope) => ({ path: setEnigmaValue(field, value, scope), changed: true }),
    };
}

/** Persist the dashboard mode and apply its side effects (hosts entry, daemon). */
function setDashboard(value: string, scope: Scope): ApplyResult {
    const path = setEnigmaValue("dashboard", value, scope);
    applyDashboardMode(value as DashboardMode);
    return { path, changed: true };
}

/** Persist the compress toggle and deploy/remove the MCP server immediately. */
function setCompress(on: boolean, scope: Scope): ApplyResult {
    const path = setEnigmaToggle("compress", on, scope);
    applyMcpToggle(scope);
    return { path, changed: true };
}

/** Persist the codeGraph toggle and (de)register the enigma MCP server, which hosts its tools. */
function setCodeGraph(on: boolean, scope: Scope): ApplyResult {
    const path = setEnigmaToggle("codeGraph", on, scope);
    applyMcpToggle(scope);
    return { path, changed: true };
}

/**
 * Persist the recall toggle, deploy/remove the MCP server (so the agent can reach the
 * enigma_recall tools), and on enable kick a background sync so memory appears without a
 * manual `enigma recall sync`. Memory-affecting: the agent's instruction file gains a
 * "use recall" note when on (stripped when off), so a restart is needed to pick it up.
 */
function setRecall(on: boolean, scope: Scope): ApplyResult {
    const path = setEnigmaToggle("recall", on, scope);
    applyMcpToggle(scope);
    if (on) {
        // Deferred, best-effort: build the store from existing transcripts right away.
        // Dynamic import keeps this light module free of the bun:sqlite-heavy recall code.
        setTimeout(() => {
            import("./recall").then(async (r) => { try { r.syncRecall(); await r.enrichRecall(); } catch { /* best-effort */ } }).catch(() => { /* recall unavailable */ });
        }, 0);
    }
    return { path, changed: true };
}

/**
 * Hand gh's telemetry setting to gh, reporting why when gh cannot take it. The setting
 * lives in gh's own config, not enigma's, so this is the one write that can fail for a
 * reason entirely outside enigma - and the reason has to reach the user.
 */
function writeGhTelemetry(enabled: boolean): ApplyResult {
    const changed = setGhTelemetry(enabled);
    if (changed === null) return { changed: false, error: ghTelemetryBlocker() ?? "gh refused the change" };
    return { changed };
}

/** Persist the gate toggle and deploy/remove the /gate command immediately. */
function setGate(on: boolean, scope: Scope): ApplyResult {
    const path = setEnigmaToggle("gate", on, scope);
    applyGateToggle(scope);
    return { path, changed: true };
}

// --- render-speed read cache (SWR) ----------------------------------------------
// The TUI re-reads every visible setting on every render (display value, dirty
// diffing, save comparison), and each underlying read hits disk (or spawns gh).
// Web-style fix: serve reads from a short-TTL memo and invalidate on every write
// through the registry, so renders cost microseconds while external edits still
// surface within the TTL. Writes are never cached.

const READ_TTL_MS = 2500;
const readCache = new Map<string, { value: boolean | string; at: number }>();

/** Drop every cached read (called after writes and external-change signals). */
export function invalidateSettingReads(): void {
    readCache.clear();
}

function swrRead<T extends boolean | string>(cacheKey: string, fn: () => T): T {
    const hit = readCache.get(cacheKey);
    if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.value as T;
    const value = fn();
    readCache.set(cacheKey, { value, at: Date.now() });
    return value;
}

/** Wrap a setting so reads are memoized and writes bust the cache. */
function withReadCache(s: Setting): Setting {
    const wrapped: Setting = {
        ...s,
        read: (scope) => swrRead(`${s.key}/${scope}/bool`, () => s.read(scope)),
        write: (value, scope) => { const r = s.write(value, scope); invalidateSettingReads(); return r; },
    };
    if (s.readChoice) wrapped.readChoice = (scope) => swrRead(`${s.key}/${scope}/choice`, () => s.readChoice!(scope));
    if (s.writeChoice) wrapped.writeChoice = (value, scope) => { const r = s.writeChoice!(value, scope); invalidateSettingReads(); return r; };
    if (s.kind === "list" && s.listValues) {
        wrapped.listValues = (scope) => JSON.parse(swrRead(`${s.key}/${scope}/list`, () => JSON.stringify(s.listValues!(scope)))) as string[];
        if (s.addItem) wrapped.addItem = (item, scope) => { const r = s.addItem!(item, scope); invalidateSettingReads(); return r; };
        if (s.removeItem) wrapped.removeItem = (item, scope) => { const r = s.removeItem!(item, scope); invalidateSettingReads(); return r; };
    }
    return wrapped;
}

/** Declare a guard user-list (block/allow globs, custom secret patterns) as a list setting. */
function guardListSetting(meta: GuardListMeta): Setting {
    return {
        key: `guard-${meta.value}`, label: meta.label, hint: meta.hint, globalOnly: true, kind: "list", itemHint: meta.placeholder,
        read: () => readGlobalGuard()[meta.field].length > 0,
        // Lists are edited via add/remove; a boolean write is a no-op so on/off surfaces stay inert.
        write: () => ({ changed: false }),
        listValues: () => readGlobalGuard()[meta.field],
        addItem: (item) => { setGuardList(meta.field, [...readGlobalGuard()[meta.field], item]); return { changed: true }; },
        removeItem: (item) => { setGuardList(meta.field, readGlobalGuard()[meta.field].filter((x) => x !== item)); return { changed: true }; },
    };
}

const RAW_CATEGORIES: Category[] = [
    {
        title: "General",
        blurb: "enigma runtime toggles (.enigma.json)",
        settings: [
            enigmaToggle("update-notifier", "updateNotifier", "Update notifications", "notify when a newer enigma-cli is published"),
            enigmaToggle("auto-sync", "autoSync", "Auto-sync on launch", "refresh already-deployed skills/memory when launching a tool via enigma (e.g. enigma claude)"),
            enigmaToggle("remote-skills", "remoteSkills", "Remote skill updates", "fetch newer skills from the GitHub repo on install/update, without waiting for a package release"),
            {
                key: "skill-update-policy",
                label: "Customized-skill updates",
                hint: "when a skill you edited is updated: overwrite (replace with the new version) or keep (preserve your local edits); enigma default: overwrite",
                globalOnly: true,
                // No offChoice in the choice list, so this renders as a select (overwrite/keep), not a switch.
                choices: SKILL_UPDATE_POLICIES,
                read: () => readConfig().config.skillUpdatePolicy === "overwrite",
                write: (value, scope) => ({ path: setEnigmaValue("skillUpdatePolicy", value ? "overwrite" : "keep", scope), changed: true }),
                readChoice: () => readConfig().config.skillUpdatePolicy,
                writeChoice: (value, scope) => ({ path: setEnigmaValue("skillUpdatePolicy", value, scope), changed: true }),
            },
            enigmaToggle("fullscreen", "fullscreen", "Full-screen TUI", "clear the screen for a clean TUI view; off renders inline among existing output"),
            enigmaToggle("parallel-subagents", "parallelSubagents", "Parallel sub-agents", "let agents split long tasks across sub-agents running in parallel; edits the memory file - restart your agent to apply", true),
            enigmaChoice("output-style", "outputStyle", "Token-efficient output", "compress prose replies (off|lite|full|ultra); on = full; edits the memory file - restart your agent to apply", OUTPUT_STYLES, "full", true),
            enigmaChoice("minimal-code", "minimalCode", "Minimal code (anti-overengineering)", "prefer the laziest solution that works (off|lite|full|ultra); on = full; edits the anti-overengineering skill - restart your agent to apply", MINIMAL_CODE_LEVELS, "full", false, "off", true),
            {
                key: "logo-color-policy",
                label: "Logo contrast resolution",
                hint: "the agent always sources real logos (never invents them); this only picks how a logo/background contrast clash is fixed: ask | adapt-background | adapt-logo; edits the logo skill - restart your agent to apply; enigma default: ask",
                affectsSkills: true,
                choices: LOGO_COLOR_POLICIES,
                // No off state - a mode is always set; the boolean face stays "on" so the row reads green.
                offChoice: "__none__",
                read: () => true,
                write: () => ({ changed: false }),
                readChoice: () => readConfig().config.logoColorPolicy,
                writeChoice: (value, scope) => ({ path: setEnigmaValue("logoColorPolicy", value, scope), changed: true }),
            },
            {
                key: "compress",
                label: "Context compression MCP",
                hint: "deploy enigma's token-compression MCP server (enigma_compress/retrieve/stats) into managed agents; toggling applies immediately to already-deployed agents; off removes it; enigma default: off",
                read: () => readConfig().config.compress,
                write: (value, scope) => setCompress(value, scope),
            },
            {
                key: "code-graph",
                label: "Codebase memory (code graph)",
                hint: "expose enigma's native code-graph tools (index a codebase into a knowledge graph of symbols, imports and references) to your agents over MCP; toggling applies immediately; off removes them; enigma default: off",
                read: () => readConfig().config.codeGraph,
                write: (value, scope) => setCodeGraph(value, scope),
            },
            {
                key: "gate",
                label: "AI quality gate (experimental)",
                hint: "EXPERIMENTAL, off by default: deploy the /gate command AND tell agents to auto-drive the gate (review/test/lint/PR/CI) after finishing work on a feature branch - no need to ask or run `enigma gate init`; per-project opt-out via `.enigma.json` gate:false; edits the memory file - restart your agent to apply",
                affectsMemory: true,
                read: () => readConfig().config.gate,
                write: (value, scope) => setGate(value, scope),
            },
            {
                key: "auto-lint",
                label: "Auto-lint on edit",
                hint: "auto-fix edited files and surface only unfixable findings; on enable installs @enigmax/linter and wires a post-write hook (Claude + opencode); enigma default: off",
                read: () => isAutoLintOn(),
                write: (value, scope) => ({ path: setAutoLint(scope, value), changed: true }),
            },
        ],
    },
    {
        title: "Local dashboard",
        blurb: "browser dashboard to manage enigma - accounts, skills, settings, system resources - and see its measured savings",
        settings: [
            {
                key: "dashboard",
                label: "Local dashboard",
                hint: "manage enigma (accounts, skills, settings, resources) and see savings; open with 'enigma dashboard' at http://enigma; off | on-demand (runs only while open, no idle cost; default when enabled) | always (lightweight background daemon)",
                choices: DASHBOARD_MODES,
                offChoice: "off",
                read: () => readConfig().config.dashboard !== "off",
                write: (value, scope) => setDashboard(value ? "on-demand" : "off", scope),
                readChoice: () => readConfig().config.dashboard,
                writeChoice: (value, scope) => setDashboard(value, scope),
            },
            {
                key: "usage-stats",
                label: "Real tool-usage stats",
                hint: "let the dashboard read the agent's own session transcripts (Claude Code) for real token usage + prompt-cache savings; reads your own session logs; enigma default: off",
                globalOnly: true,
                read: () => readConfig().config.usageStats,
                write: (value, scope) => ({ path: setEnigmaToggle("usageStats", value, scope), changed: true }),
            },
            enigmaToggle("dashboard-live", "dashboardLive", "Live auto-refresh", "the dashboard refreshes its data automatically while the tab is focused; off = refresh only with the button"),
            {
                key: "proxy",
                label: "Claude Code proxy (experimental)",
                hint: "route `enigma claude` through a local loopback proxy that forwards to Anthropic and measures real token usage; never stores auth or message content; Claude Code only; enigma default: off",
                globalOnly: true,
                read: () => readConfig().config.proxy,
                write: (value, scope) => ({ path: setEnigmaToggle("proxy", value, scope), changed: true }),
            },
            {
                key: "usage-api",
                label: "Live usage windows",
                hint: "show the real usage %/reset Claude's UI shows by probing Anthropic with your local Claude Code login (no proxy needed); reads your OAuth token, never stores it, and uses a tiny bit of quota; needs real tool-usage stats on; Claude Code only; enigma default: off",
                globalOnly: true,
                read: () => readConfig().config.usageApi,
                write: (value, scope) => ({ path: setEnigmaToggle("usageApi", value, scope), changed: true }),
            },
            {
                key: "recall",
                label: "Session memory (recall)",
                hint: "build a searchable local memory of your coding sessions from transcripts (Claude Code), exposed to agents via MCP; reads your own session logs and stays on this machine; enabling syncs it and tells the agent to use it; enigma default: off",
                globalOnly: true,
                affectsMemory: true,
                read: () => readConfig().config.recall,
                write: (value, scope) => setRecall(value, scope),
            },
            {
                key: "recall-llm",
                label: "Recall LLM curation",
                hint: "use an LLM (via your local Claude login) to curate recall: it keeps only the observations worth remembering and discards trivial ones, like claude-mem; runs in the background, needs recall on; with no login it falls back to the deterministic heuristic; enigma default: on",
                globalOnly: true,
                read: () => readConfig().config.recallLlm,
                write: (value, scope) => ({ path: setEnigmaToggle("recallLlm", value, scope), changed: true }),
            },
            {
                key: "recall-provider",
                label: "Recall LLM provider",
                hint: `which model curates recall memory: ${RECALL_PROVIDERS.join(" | ")} (claude-local reuses your Claude Code login, anthropic/openai need an API key); enigma default: claude-local`,
                globalOnly: true,
                choices: RECALL_PROVIDERS,
                // No off state - a provider is always set; the boolean face stays "on" so the row reads green.
                offChoice: "__none__",
                read: () => true,
                write: () => ({ changed: false }),
                readChoice: () => readConfig().config.recallProvider,
                writeChoice: (value, scope) => ({ path: setEnigmaValue("recallProvider", value, scope), changed: true }),
            },
            {
                key: "recall-model",
                label: "Recall model",
                hint: "model id for recall curation; blank = the provider's default",
                globalOnly: true,
                kind: "value",
                valueHint: "model id (blank = provider default)",
                read: () => !!readConfig().config.recallModel,
                write: () => ({ changed: false }),
                readValue: () => readConfig().config.recallModel,
                writeValue: (value, scope) => ({ path: setEnigmaValue("recallModel", value.trim(), scope), changed: true }),
            },
            {
                key: "recall-api-base",
                label: "Recall API base URL",
                hint: "base URL for the anthropic/openai-compatible provider; blank = the provider's default",
                globalOnly: true,
                kind: "value",
                valueHint: "https://... (blank = provider default)",
                read: () => !!readConfig().config.recallApiBase,
                write: () => ({ changed: false }),
                readValue: () => readConfig().config.recallApiBase,
                writeValue: (value, scope) => ({ path: setEnigmaValue("recallApiBase", value.trim(), scope), changed: true }),
            },
            {
                key: "recall-api-key",
                label: "Recall API key",
                hint: "API key for the anthropic/openai provider; stored encrypted at rest; ENIGMA_RECALL_API_KEY overrides it",
                globalOnly: true,
                kind: "value",
                secret: true,
                valueHint: "paste API key (blank to clear)",
                read: () => !!readConfig().config.recallApiKey,
                write: () => ({ changed: false }),
                // Never expose the stored key: report only whether one is set.
                readValue: () => readConfig().config.recallApiKey ? "set" : "",
                writeValue: (value, scope) => ({ path: setRecallApiKey(value.trim(), scope), changed: true }),
            },
        ],
    },
    {
        title: "Git & attribution",
        blurb: "how the coding agent commits and attributes its work in git",
        settings: [
            enigmaToggle("commit-emoji", "commitEmoji", "Commit subject emoji", "leading gitmoji on commit subjects"),
            {
                key: "claude-attribution",
                label: "Claude commit attribution",
                hint: "let Claude Code commit as its own contributor (Co-Authored-By / PR footer); enigma default: off",
                read: (scope) => getClaudeAttribution(scope),
                write: (value, scope) => ({ changed: setClaudeAttribution(scope, value) }),
            },
            {
                key: "claude-survey",
                label: "Claude feedback survey",
                hint: "let Claude Code show the 'How is Claude doing?' session quality survey; enigma default: off",
                read: (scope) => getClaudeFeedbackSurvey(scope),
                write: (value, scope) => ({ changed: setClaudeFeedbackSurvey(scope, value) }),
            },
            {
                key: "gh-telemetry",
                label: "GitHub CLI telemetry",
                hint: "let gh send usage analytics to GitHub; enigma default: disabled (privacy; avoids a Windows window-flash bug)",
                globalOnly: true,
                // Choice setting so every surface shows gh's REAL state (gh's own
                // vocabulary), including "not installed" when gh is absent. Reads use
                // the stale-while-revalidate cache (github.ts) so the TUI paints
                // instantly; onGhTelemetryChange re-renders it when reality differs.
                choices: ["enabled", "disabled"],
                offChoice: "disabled",
                read: () => getGhTelemetryCached() === true,
                write: (value) => writeGhTelemetry(value),
                readChoice: () => {
                    const v = getGhTelemetryCached();
                    // Distinguish the two ways we end up with no value: gh missing, or gh
                    // present but unable to answer. "not installed" for the latter sent
                    // people looking for a gh that was sitting right there.
                    if (v === null) return hasGhCli() ? "unavailable" : "not installed";
                    return v ? "enabled" : "disabled";
                },
                writeChoice: (value) => writeGhTelemetry(value === "enabled"),
            },
        ],
    },
    {
        title: "Commit guard",
        blurb: "what enigma's git commit guard blocks (user-wide default; per-repo .githooks/enigma-guard.json can override)",
        settings: [
            ...GUARD_PROTECTIONS.map((p): Setting => ({
                key: `guard-${p.value}`,
                label: p.label,
                hint: `${p.hint}; applies to every repo with enigma's guard unless overridden per-repo`,
                globalOnly: true,
                read: () => readGlobalGuard()[p.value],
                write: (value) => { setGuardProtection(p.value, value); return { changed: true }; },
            })),
            ...GUARD_LISTS.map(guardListSetting),
        ],
    },
    {
        title: "Prompt secret guard",
        blurb: "block credentials in chat prompts before they reach the agent (Claude Code, via the local proxy; opt-in)",
        settings: [
            {
                key: "prompt-secret-guard",
                label: "Prompt secret guard (experimental)",
                hint: "scan outgoing chat messages and block secrets (API keys, tokens) before they reach Claude; routes `enigma claude` through the local proxy; uses the same patterns as the commit guard, plus your custom secret patterns; Claude Code only; enigma default: off",
                globalOnly: true,
                read: () => readConfig().config.promptSecretGuard,
                write: (value, scope) => ({ path: setEnigmaToggle("promptSecretGuard", value, scope), changed: true }),
            },
            {
                key: "prompt-secret-mode",
                label: "Prompt guard action",
                hint: "what to do on a hit: redact (strip the secret, keep the turn working) or reject (block the whole request); only applies when the prompt secret guard is on; enigma default: redact",
                globalOnly: true,
                // No offChoice: redact/reject are two equal actions, not on/off, so this
                // renders as a select (not a switch). The boolean face is a fallback only.
                choices: PROMPT_SECRET_MODES,
                read: () => readConfig().config.promptSecretMode === "reject",
                write: (value, scope) => ({ path: setEnigmaValue("promptSecretMode", value ? "reject" : "redact", scope), changed: true }),
                readChoice: () => readConfig().config.promptSecretMode,
                writeChoice: (value, scope) => ({ path: setEnigmaValue("promptSecretMode", value, scope), changed: true }),
            },
        ],
    },
    {
        title: "Permissions",
        blurb: "approval-prompt bypass (security trade-off; on by default)",
        settings: [
            enigmaToggle("permission-bypass", "permissionBypass", "Permission bypass (default)", "on: every install bypasses each agent's approval prompts unless opted out per-agent; off: never bypass by default"),
            ...BYPASS_SUPPORTED.map((name): Setting => ({
                key: `bypass-${name}`,
                label: `${AGENTS[name]?.label || name} approval bypass`,
                hint: name === "codex" ? "skip approval prompts (global ~/.codex only)" : "skip per-action approval prompts",
                globalOnly: name === "codex",
                read: (scope: Scope) => getBypass(name, scope),
                write: (value: boolean, scope: Scope) => setBypass(name, scope, value, false) || { changed: false },
            })),
        ],
    },
];

/** The public registry: every setting read-cached, grouped by category. */
export const CATEGORIES: Category[] = RAW_CATEGORIES.map((c) => ({ ...c, settings: c.settings.map(withReadCache) }));

export const ALL_SETTINGS = CATEGORIES.flatMap((c) => c.settings);

/** Human label for a boolean setting value. */
export function valueLabel(on: boolean): string {
    return on ? "on" : "off";
}

/** Parse an on/off-style CLI value, or null if unrecognized. */
export function parseBool(value: string): boolean | null {
    const v = value.toLowerCase();
    if (["on", "true", "yes", "1", "enable", "enabled"].includes(v)) return true;
    if (["off", "false", "no", "0", "disable", "disabled"].includes(v)) return false;
    return null;
}
