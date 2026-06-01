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
import { readConfig, setEnigmaToggle } from "./config";
import { getClaudeAttribution, setClaudeAttribution } from "./claude";
import { BYPASS_SUPPORTED, getBypass, setBypass } from "./permissions";
import type { EnigmaConfigKey } from "./config";

export type Scope = "global" | "local";

export interface ApplyResult { path?: string; changed: boolean; }

export interface Setting {
    /** Stable CLI key (kebab-case) used by `enigma config <key>`. */
    key: string;
    label: string;
    hint: string;
    /** True when the underlying config is user-global only (no project-local form). */
    globalOnly?: boolean;
    read(scope: Scope): boolean;
    write(value: boolean, scope: Scope): ApplyResult;
}

export interface Category {
    title: string;
    blurb: string;
    settings: Setting[];
}

/** Declare an .enigma.json runtime toggle as a registry setting. */
function enigmaToggle(key: string, field: EnigmaConfigKey, label: string, hint: string): Setting {
    return {
        key, label, hint,
        read: () => readConfig().config[field],
        write: (value, scope) => ({ path: setEnigmaToggle(field, value, scope), changed: true }),
    };
}

export const CATEGORIES: Category[] = [
    {
        title: "General",
        blurb: "enigma runtime toggles (.enigma.json)",
        settings: [
            enigmaToggle("commit-emoji", "commitEmoji", "Commit subject emoji", "leading gitmoji on commit subjects"),
            enigmaToggle("update-notifier", "updateNotifier", "Update notifications", "notify when a newer enigma-cli is published"),
        ],
    },
    {
        title: "Git & attribution",
        blurb: "how the coding agent attributes its work in git",
        settings: [
            {
                key: "claude-attribution",
                label: "Claude commit attribution",
                hint: "let Claude Code commit as its own contributor (Co-Authored-By / PR footer); enigma default: off",
                read: (scope) => getClaudeAttribution(scope),
                write: (value, scope) => ({ changed: setClaudeAttribution(scope, value) }),
            },
        ],
    },
    {
        title: "Permissions",
        blurb: "approval-prompt bypass per agent (security trade-off)",
        settings: BYPASS_SUPPORTED.map((name) => ({
            key: `bypass-${name}`,
            label: `${AGENTS[name]?.label || name} approval bypass`,
            hint: name === "codex" ? "skip approval prompts (global ~/.codex only)" : "skip per-action approval prompts",
            globalOnly: name === "codex",
            read: (scope: Scope) => getBypass(name, scope),
            write: (value: boolean, scope: Scope) => setBypass(name, scope, value, false) || { changed: false },
        })),
    },
];

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
