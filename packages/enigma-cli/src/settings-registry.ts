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
import { readConfig, setEnigmaToggle, setEnigmaValue, OUTPUT_STYLES } from "./config";
import { getClaudeAttribution, setClaudeAttribution } from "./claude";
import { getGhTelemetryCached, setGhTelemetry } from "./github";
import { BYPASS_SUPPORTED, getBypass, setBypass } from "./permissions";
import type { EnigmaConfig, EnigmaConfigKey } from "./config";

export type Scope = "global" | "local";

/** Keys of EnigmaConfig whose value is a boolean (the on/off toggles). */
type BooleanConfigKey = { [K in EnigmaConfigKey]: EnigmaConfig[K] extends boolean ? K : never }[EnigmaConfigKey];

export interface ApplyResult { path?: string; changed: boolean; }

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
    choices: readonly string[], enabledDefault: string, affectsMemory = false, offValue = "off",
): Setting {
    return {
        key, label, hint, affectsMemory, choices, offChoice: offValue,
        read: () => readConfig().config[field] !== offValue,
        write: (value, scope) => ({ path: setEnigmaValue(field, value ? enabledDefault : offValue, scope), changed: true }),
        readChoice: () => String(readConfig().config[field]),
        writeChoice: (value, scope) => ({ path: setEnigmaValue(field, value, scope), changed: true }),
    };
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
    return wrapped;
}

const RAW_CATEGORIES: Category[] = [
    {
        title: "General",
        blurb: "enigma runtime toggles (.enigma.json)",
        settings: [
            enigmaToggle("update-notifier", "updateNotifier", "Update notifications", "notify when a newer enigma-cli is published"),
            enigmaToggle("auto-sync", "autoSync", "Auto-sync on launch", "refresh already-deployed skills/memory when launching a tool via enigma (e.g. enigma claude)"),
            enigmaToggle("fullscreen", "fullscreen", "Full-screen TUI", "clear the screen for a clean TUI view; off renders inline among existing output"),
            enigmaToggle("parallel-subagents", "parallelSubagents", "Parallel sub-agents", "let agents split long tasks across sub-agents running in parallel; edits the memory file - restart your agent to apply", true),
            enigmaChoice("output-style", "outputStyle", "Token-efficient output", "compress prose replies (off|lite|full|ultra); on = full; edits the memory file - restart your agent to apply", OUTPUT_STYLES, "full", true),
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
                write: (value) => ({ changed: setGhTelemetry(value) === true }),
                readChoice: () => {
                    const v = getGhTelemetryCached();
                    if (v === null) return "not installed";
                    return v ? "enabled" : "disabled";
                },
                writeChoice: (value) => ({ changed: setGhTelemetry(value === "enabled") === true }),
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
