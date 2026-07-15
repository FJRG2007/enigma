/**
 * The `enigma config` command surface. On a TTY with no key it launches the
 * full-screen Ink settings TUI (loaded lazily so non-interactive commands never
 * pay for React/Ink); on a non-TTY it prints effective values. With `<key>
 * <on|off>` it sets one option via the shared registry (settings-registry.ts).
 */

import { isIP } from "node:net";
import { DASHBOARD_BINDS, readConfig, setEnigmaValue, type DashboardBind } from "./config";
import { ALL_SETTINGS, CATEGORIES, parseBool, valueLabel } from "./settings-registry";
import type { ApplyResult, Scope } from "./settings-registry";

/** A DNS name: dot-separated labels of alphanumerics/hyphens, each 1-63 chars, no leading/trailing hyphen. */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Print every setting's effective value, grouped by category, for non-TTY use. */
function printEffective(): void {
    console.log("Effective enigma settings:\n");
    for (const category of CATEGORIES) {
        console.log(`${category.title}:`);
        for (const s of category.settings) {
            const shown = s.kind === "list"
                ? `[${(s.listValues ? s.listValues("global") : []).join(", ")}]`
                : s.kind === "value"
                ? (s.secret ? (s.readValue && s.readValue("global") ? "(set)" : "(not set)") : ((s.readValue ? s.readValue("global") : "") || "(default)"))
                : s.choices && s.readChoice ? s.readChoice("global") : valueLabel(s.read("global"));
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

    // token-speed is a numeric dashboard setting (model prefill speed in tokens/sec),
    // outside the boolean/choice registry. 0 restores the default rate. It drives the
    // "Time Saved" estimate (savedTokens / speed); enigma is not a proxy, so it cannot
    // know the real model and the figure is explicitly an estimate.
    if (rawKey === "token-speed") {
        const n = Number(rawValue);
        if (rawValue === undefined || !Number.isFinite(n) || n < 0) {
            console.error("Missing/invalid value for 'token-speed'. Usage: enigma config token-speed <tokens-per-second> (e.g. 3000, or 0 for the default rate) [-g|-l]");
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue("tokenSpeed", n, target);
        console.log(`Set token-speed = ${n} tok/s (${target})${path ? ` in ${path}` : ""}.`);
        return 0;
    }

    // dashboard-port is a numeric setting (the local dashboard's preferred port), outside the
    // boolean/choice registry. 0 = auto (80, then 24282, then ephemeral). Needs a restart.
    if (rawKey === "dashboard-port") {
        const n = Number(rawValue);
        if (rawValue === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
            console.error("Missing/invalid value for 'dashboard-port'. Usage: enigma config dashboard-port <0-65535> (0 = auto: 80, then 24282) [-g|-l]");
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue("dashboardPort", n, target);
        console.log(`Set dashboard-port = ${n === 0 ? "auto" : n} (${target})${path ? ` in ${path}` : ""}. Restart the dashboard to apply.`);
        return 0;
    }

    // dashboard-bind decides which interface the dashboard listens on. It is a 3-value choice
    // where none of the values is "off", so it does not fit the boolean/choice registry - and
    // it stays CLI-only on purpose: exposing an admin surface is a decision to make on the
    // host, not a switch to flip inside the very web UI it exposes. Needs a restart.
    if (rawKey === "dashboard-bind") {
        if (rawValue === undefined || !DASHBOARD_BINDS.includes(rawValue as DashboardBind)) {
            console.error(`Missing/invalid value for 'dashboard-bind'. Usage: enigma config dashboard-bind <${DASHBOARD_BINDS.join("|")}> [-g|-l]. Anything but loopback is reachable from the network and requires a token.`);
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue("dashboardBind", rawValue as DashboardBind, target);
        console.log(`Set dashboard-bind = ${rawValue} (${target})${path ? ` in ${path}` : ""}. Restart the dashboard to apply.`);
        if (rawValue !== "loopback") console.log("The dashboard can run agents with your credentials, so it will refuse to start until a token exists: `enigma dashboard token --new`.");
        return 0;
    }

    // dashboard-bind-address pins the interface for dashboard-bind "custom" (e.g. a Tailscale IP).
    // Validated on write so a typo is caught here, with the address in hand, rather than at bind
    // time as a failed listen. An address that parses can still be gone by then (a tailnet that
    // moved), which listenWithFallback reports on its own.
    if (rawKey === "dashboard-bind-address") {
        const value = rawValue === undefined || rawValue === "" || rawValue.toLowerCase() === "none" ? "" : rawValue.trim();
        if (value && !isIP(value) && !HOSTNAME_RE.test(value)) {
            console.error("Invalid value for 'dashboard-bind-address'. Usage: enigma config dashboard-bind-address <ip|hostname|none> [-g|-l]. It pins the interface `dashboard-bind custom` listens on.");
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue("dashboardBindAddress", value, target);
        console.log(`Set dashboard-bind-address = ${value || "(unset)"} (${target})${path ? ` in ${path}` : ""}. Restart the dashboard to apply.`);
        return 0;
    }

    // api-port is a numeric setting (the local Claude Code API server's preferred port),
    // outside the boolean/choice registry. Takes effect on the next `enigma api` run.
    if (rawKey === "api-port") {
        const n = Number(rawValue);
        if (rawValue === undefined || !Number.isInteger(n) || n < 1 || n > 65535) {
            console.error("Missing/invalid value for 'api-port'. Usage: enigma config api-port <1-65535> (default 8000) [-g|-l]");
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue("apiPort", n, target);
        console.log(`Set api-port = ${n} (${target})${path ? ` in ${path}` : ""}. Applies on the next 'enigma api' run.`);
        return 0;
    }

    // Plan window limits (numeric, USD-free token caps) + the weekly reset anchor. These
    // drive the Claude-style usage gauges and sit outside the boolean/choice registry, like
    // token-price/token-speed. 0 = unset (the gauge shows tokens instead of a %).
    const PLAN_NUMERIC: Record<string, "planSessionLimit" | "planWeeklyLimit" | "planWeeklySonnetLimit" | "planWeeklyOpusLimit"> = {
        "plan-session-limit": "planSessionLimit", "plan-weekly-limit": "planWeeklyLimit", "plan-weekly-sonnet-limit": "planWeeklySonnetLimit", "plan-weekly-opus-limit": "planWeeklyOpusLimit",
    };
    if (rawKey in PLAN_NUMERIC) {
        const n = Number(rawValue);
        if (rawValue === undefined || !Number.isFinite(n) || n < 0) {
            console.error(`Missing/invalid value for '${rawKey}'. Usage: enigma config ${rawKey} <tokens> (e.g. 1000000, or 0 to unset) [-g|-l]`);
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue(PLAN_NUMERIC[rawKey]!, n, target);
        console.log(`Set ${rawKey} = ${n} tokens (${target})${path ? ` in ${path}` : ""}.`);
        return 0;
    }
    // Default API context (account/profile/pack) - free-form string configs; "none"/empty clears.
    const API_CONTEXT: Record<string, "apiAccount" | "apiProfile" | "apiPack"> = {
        "api-account": "apiAccount", "api-profile": "apiProfile", "api-pack": "apiPack",
    };
    if (rawKey in API_CONTEXT) {
        const value = rawValue === undefined || rawValue === "" || rawValue.toLowerCase() === "none" ? "" : rawValue;
        const target: Scope = scope || "global";
        const path = setEnigmaValue(API_CONTEXT[rawKey]!, value, target);
        console.log(`Set ${rawKey} = ${value || "(unset)"} (${target})${path ? ` in ${path}` : ""}. Applies on the next 'enigma api' run.`);
        return 0;
    }
    if (rawKey === "plan-weekly-reset") {
        if (rawValue === undefined || !/^[a-z]{3}\s+\d{1,2}:\d{2}$/i.test(rawValue)) {
            console.error("Missing/invalid value for 'plan-weekly-reset'. Usage: enigma config plan-weekly-reset \"<weekday> HH:MM\" (e.g. \"mon 11:00\") [-g|-l]");
            return 1;
        }
        const target: Scope = scope || "global";
        const path = setEnigmaValue("planWeeklyReset", rawValue.toLowerCase(), target);
        console.log(`Set plan-weekly-reset = ${rawValue.toLowerCase()} (${target})${path ? ` in ${path}` : ""}.`);
        return 0;
    }

    const setting = ALL_SETTINGS.find((s) => s.key === rawKey);
    if (!setting) {
        console.error(`Unknown config key: ${rawKey}. Known keys: ${ALL_SETTINGS.map((s) => s.key).join(", ")}, token-price, token-speed, dashboard-port, dashboard-bind, dashboard-bind-address, api-port, api-account, api-profile, api-pack, plan-session-limit, plan-weekly-limit, plan-weekly-sonnet-limit, plan-weekly-opus-limit, plan-weekly-reset.`);
        return 1;
    }

    // Free-text value settings (recall model/base/key). `<key>` alone prints the current value
    // (a secret only as "(set)"/"(not set)"); `<key> <value>` sets it (blank value clears it).
    if (setting.kind === "value") {
        const target: Scope = setting.globalOnly ? "global" : (scope || "global");
        if (rawValue === undefined) {
            const cur = setting.readValue ? setting.readValue(target) : "";
            console.log(`${rawKey} (${target}): ${setting.secret ? (cur ? "(set)" : "(not set)") : (cur || "(default)")}`);
            return 0;
        }
        const res = setting.writeValue ? setting.writeValue(rawValue, target) : { changed: false };
        const shown = setting.secret ? (rawValue ? "(set, encrypted)" : "(cleared)") : (rawValue || "(cleared)");
        console.log(`Set ${rawKey} = ${shown} (${target})${res.path ? ` in ${res.path}` : ""}.`);
        return 0;
    }

    // List settings (guard block/allow globs, custom secret patterns): add/remove/list one
    // entry. `enigma config <key>` with no op prints the current items; `<key> add|remove <item>`.
    if (setting.kind === "list") {
        const target: Scope = setting.globalOnly ? "global" : (scope || "global");
        const op = rawValue?.toLowerCase();
        const item = positionals.slice(2).join(" ").trim();
        const current = setting.listValues ? setting.listValues(target) : [];
        if (!op || op === "list") {
            console.log(`${rawKey} (${target}): ${current.length ? current.join(", ") : "(none - using built-in defaults)"}`);
            return 0;
        }
        if ((op !== "add" && op !== "remove") || !item) {
            console.error(`Usage: enigma config ${rawKey} <add|remove> <entry>   (or '${rawKey}' alone to list)`);
            return 1;
        }
        if (op === "add" && setting.addItem) setting.addItem(item, target);
        else if (op === "remove" && setting.removeItem) setting.removeItem(item, target);
        const after = setting.listValues ? setting.listValues(target) : [];
        console.log(`${op === "add" ? "Added to" : "Removed from"} ${rawKey} (${target}). Now: ${after.length ? after.join(", ") : "(none)"}.`);
        return 0;
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
