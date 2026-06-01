/**
 * The single registry of user-configurable enigma options, plus the surfaces that
 * expose them: an interactive, category-organized menu (`runSettingsMenu`) and the
 * scriptable `enigma config <key> <value>` command (`runConfigCli`).
 *
 * Every option is declared once here with a `read`/`write` pair, so it appears in
 * both surfaces automatically. Options span two storage layers - enigma's own
 * .enigma.json runtime toggles (config.ts) and each agent's native config files
 * (claude.ts / permissions.ts) - but the registry hides that behind a uniform
 * boolean interface.
 */

import * as p from "@clack/prompts";
import { AGENTS } from "./agents";
import { readConfig, setEnigmaToggle } from "./config";
import { getClaudeAttribution, setClaudeAttribution } from "./claude";
import { BYPASS_SUPPORTED, getBypass, setBypass } from "./permissions";
import type { EnigmaConfigKey } from "./config";

type Scope = "global" | "local";

interface ApplyResult { path?: string; changed: boolean; }

interface Setting {
    /** Stable CLI key (kebab-case) used by `enigma config <key>`. */
    key: string;
    label: string;
    hint: string;
    /** True when the underlying config is user-global only (no project-local form). */
    globalOnly?: boolean;
    read(scope: Scope): boolean;
    write(value: boolean, scope: Scope): ApplyResult;
}

interface Category {
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

const CATEGORIES: Category[] = [
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

const ALL_SETTINGS = CATEGORIES.flatMap((c) => c.settings);

function valueLabel(on: boolean): string {
    return on ? "on" : "off";
}

function parseBool(value: string): boolean | null {
    const v = value.toLowerCase();
    if (["on", "true", "yes", "1", "enable", "enabled"].includes(v)) return true;
    if (["off", "false", "no", "0", "disable", "disabled"].includes(v)) return false;
    return null;
}

/**
 * Interactive, category-organized settings menu. Navigates category -> setting,
 * shows current values, and applies each change immediately to its config file.
 * Scope is asked per change (global default), except for global-only settings.
 * Caller owns the surrounding clack intro/outro.
 */
export async function runSettingsMenu(): Promise<void> {
    for (;;) {
        const choice = await p.select({
            message: "Settings - choose a category",
            options: [
                ...CATEGORIES.map((c) => ({ value: c.title, label: c.title, hint: c.blurb })),
                { value: "__back", label: "< Back" },
            ],
        });
        if (p.isCancel(choice) || choice === "__back") return;
        await runCategory(CATEGORIES.find((c) => c.title === choice)!);
    }
}

async function runCategory(category: Category): Promise<void> {
    for (;;) {
        const choice = await p.select({
            message: `${category.title} - ${category.blurb}`,
            options: [
                ...category.settings.map((s) => ({
                    value: s.key,
                    label: `${s.label}: ${valueLabel(s.read("global"))}`,
                    hint: s.hint,
                })),
                { value: "__back", label: "< Back" },
            ],
        });
        if (p.isCancel(choice) || choice === "__back") return;
        await editSetting(category.settings.find((s) => s.key === choice)!);
    }
}

async function editSetting(setting: Setting): Promise<void> {
    let scope: Scope = "global";
    if (!setting.globalOnly) {
        const picked = await p.select({
            message: `Apply "${setting.label}" to which scope?`,
            options: [
                { value: "global", label: "Global", hint: "all projects (~)" },
                { value: "local", label: "This project", hint: "current directory" },
            ],
            initialValue: "global",
        });
        if (p.isCancel(picked)) return;
        scope = picked as Scope;
    }

    const current = setting.read(scope);
    const picked = await p.select({
        message: `${setting.label} (${scope})`,
        options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }],
        initialValue: current ? "on" : "off",
    });
    if (p.isCancel(picked)) return;

    const value = picked === "on";
    if (value === current) { p.log.info(`${setting.label}: unchanged (${valueLabel(current)}).`); return; }

    const result = setting.write(value, scope);
    if (result.changed) {
        const where = result.path ? ` -> ${result.path}` : "";
        p.log.success(`${setting.label}: ${valueLabel(value)} (${scope})${where}.`);
    } else {
        p.log.info(`${setting.label}: already ${valueLabel(value)} (${scope}).`);
    }
}

/** Print every setting's effective value, grouped by category, for non-TTY use. */
function printEffective(): void {
    console.log("Effective enigma settings:\n");
    for (const category of CATEGORIES) {
        console.log(`${category.title}:`);
        for (const s of category.settings) console.log(`  ${s.key}: ${valueLabel(s.read("global"))}`);
        console.log("");
    }
    const { sources } = readConfig();
    console.log(sources.length
        ? `.enigma.json sources: ${sources.join(", ")}`
        : ".enigma.json: built-in defaults (no file found)");
    console.log("Agent settings (attribution, bypass) reflect each agent's own config at the global scope.");
}

/**
 * `enigma config` command. With no key on a TTY, opens the interactive menu; with
 * no key on a non-TTY, prints effective values. With `<key> <on|off>`, writes that
 * setting at the given scope (default global; global-only settings ignore scope).
 * Returns a process exit code.
 */
export async function runConfigCli(positionals: string[], scope: Scope | null, interactive: boolean): Promise<number> {
    const [rawKey, rawValue] = positionals;

    if (!rawKey) {
        if (interactive) {
            p.intro("enigma config");
            await runSettingsMenu();
            p.outro("Done.");
        } else {
            printEffective();
        }
        return 0;
    }

    const setting = ALL_SETTINGS.find((s) => s.key === rawKey);
    if (!setting) {
        console.error(`Unknown config key: ${rawKey}. Known keys: ${ALL_SETTINGS.map((s) => s.key).join(", ")}.`);
        return 1;
    }
    if (rawValue === undefined) {
        console.error(`Missing value for '${rawKey}'. Usage: enigma config ${rawKey} <on|off> [-g|-l]`);
        return 1;
    }
    const value = parseBool(rawValue);
    if (value === null) {
        console.error(`Invalid value '${rawValue}' for '${rawKey}'. Use on or off.`);
        return 1;
    }

    const target: Scope = setting.globalOnly ? "global" : (scope || "global");
    const result = setting.write(value, target);
    const where = result.path ? ` in ${result.path}` : "";
    console.log(`Set ${rawKey} = ${valueLabel(value)} (${target})${where}.`);
    return 0;
}
