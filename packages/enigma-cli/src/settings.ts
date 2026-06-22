/**
 * The `enigma config` command surface. On a TTY with no key it launches the
 * full-screen Ink settings TUI (loaded lazily so non-interactive commands never
 * pay for React/Ink); on a non-TTY it prints effective values. With `<key>
 * <on|off>` it sets one option via the shared registry (settings-registry.ts).
 */

import { readConfig, setEnigmaValue } from "./config";
import { ALL_SETTINGS, CATEGORIES, parseBool, valueLabel } from "./settings-registry";
import type { ApplyResult, Scope } from "./settings-registry";

/** Print every setting's effective value, grouped by category, for non-TTY use. */
function printEffective(): void {
    console.log("Effective enigma settings:\n");
    for (const category of CATEGORIES) {
        console.log(`${category.title}:`);
        for (const s of category.settings) {
            const shown = s.choices && s.readChoice ? s.readChoice("global") : valueLabel(s.read("global"));
            console.log(`  ${s.key}: ${shown}`);
        }
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
            const { runSettingsTui } = await import("./tui/opentui");
            await runSettingsTui();
        } else {
            printEffective();
        }
        return 0;
    }

    // token-price is a numeric dashboard setting (USD per 1M input tokens), outside the
    // boolean/choice registry. 0 restores the per-source default prices.
    if (rawKey === "token-price") {
        const n = Number(rawValue);
        if (rawValue === undefined || !Number.isFinite(n) || n < 0) {
            console.error("Missing/invalid value for 'token-price'. Usage: enigma config token-price <usd-per-1M-input-tokens> (e.g. 3, or 0 for per-source defaults) [-g|-l]");
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue("tokenPrice", n, target);
        console.log(`Set token-price = ${n} USD/1M (${target})${path ? ` in ${path}` : ""}.`);
        return 0;
    }

    const setting = ALL_SETTINGS.find((s) => s.key === rawKey);
    if (!setting) {
        console.error(`Unknown config key: ${rawKey}. Known keys: ${ALL_SETTINGS.map((s) => s.key).join(", ")}, token-price.`);
        return 1;
    }
    const usage = setting.choices ? `<${setting.choices.join("|")}> (or on|off)` : "<on|off>";
    if (rawValue === undefined) {
        console.error(`Missing value for '${rawKey}'. Usage: enigma config ${rawKey} ${usage} [-g|-l]`);
        return 1;
    }

    const target: Scope = setting.globalOnly ? "global" : (scope || "global");
    const choice = rawValue.toLowerCase();

    // Choice settings accept an explicit value (e.g. "ultra") as well as the on/off face.
    let result: ApplyResult;
    let label: string;
    if (setting.choices && setting.writeChoice && setting.readChoice && setting.choices.includes(choice)) {
        result = setting.writeChoice(choice, target);
        label = choice;
    } else {
        const value = parseBool(rawValue);
        if (value === null) {
            const allowed = setting.choices ? `one of: ${setting.choices.join(", ")} (on/off also work)` : "on or off";
            console.error(`Invalid value '${rawValue}' for '${rawKey}'. Use ${allowed}.`);
            return 1;
        }
        result = setting.write(value, target);
        label = setting.readChoice ? setting.readChoice(target) : valueLabel(value);
    }
    const where = result.path ? ` in ${result.path}` : "";
    console.log(`Set ${rawKey} = ${label} (${target})${where}.`);

    // Memory-affecting toggles change the deployed agent memory file, so re-render it
    // now and tell the user to restart - agents only read memory at startup.
    if (setting.affectsMemory) await applyMemoryChange(target);
    return 0;
}

/**
 * Re-render the deployed memory file(s) for the given scope after a memory-affecting
 * toggle changed, and print a restart notice for the affected agents (loaded lazily so
 * the no-key/print paths never pull in the install machinery).
 */
async function applyMemoryChange(scope: Scope): Promise<void> {
    const { applyMemoryToggles } = await import("./skills");
    const changed = applyMemoryToggles(scope);
    if (!changed.length) {
        console.log("No deployed memory files to update yet - run 'enigma install' to deploy.");
        return;
    }
    const labels = changed.map((a) => a.label).join(", ");
    console.log(`Updated the memory file for ${labels} (${scope}).`);
    const { runningStatus } = await import("./agents");
    const { known, running } = runningStatus(changed);
    if (running.size) {
        const names = changed.filter((a) => running.has(a.name)).map((a) => a.label).join(", ");
        console.log(`Restart ${names} to apply the change (running now).`);
    } else if (!known) {
        console.log(`Restart ${labels} if running, to apply the change.`);
    }
}
