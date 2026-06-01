/**
 * The `enigma config` command surface. On a TTY with no key it launches the
 * full-screen Ink settings TUI (loaded lazily so non-interactive commands never
 * pay for React/Ink); on a non-TTY it prints effective values. With `<key>
 * <on|off>` it sets one option via the shared registry (settings-registry.ts).
 */

import { readConfig } from "./config";
import { ALL_SETTINGS, CATEGORIES, parseBool, valueLabel } from "./settings-registry";
import type { Scope } from "./settings-registry";

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
 * `enigma config` command. With no key on a TTY, opens the interactive TUI; with
 * no key on a non-TTY, prints effective values. With `<key> <on|off>`, writes that
 * setting at the given scope (default global; global-only settings ignore scope).
 * Returns a process exit code.
 */
export async function runConfigCli(positionals: string[], scope: Scope | null, interactive: boolean): Promise<number> {
    const [rawKey, rawValue] = positionals;

    if (!rawKey) {
        if (interactive) {
            const { runSettingsTui } = await import("./tui/settings");
            await runSettingsTui();
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
