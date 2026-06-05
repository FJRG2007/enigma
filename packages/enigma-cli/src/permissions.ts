/**
 * Permission-bypass configuration across agents. Optionally disables each
 * coding agent's per-action approval prompts by writing its native config:
 * Claude Code (settings.json `permissions.defaultMode`), Codex (config.toml
 * `approval_policy`), opencode (opencode.json `permission`).
 *
 * Bypassing approvals is a deliberate least-privilege downgrade. It is ON by
 * default for every supported agent on install (the `permissionBypass` config
 * flag), so an agent installed later (e.g. Codex after enigma) gets it on the
 * next install. The user can opt out globally (`enigma config permission-bypass
 * off`) or per-agent (`enigma config bypass-<name> off`, recorded in
 * `bypassDisabled` so it is never re-enabled), or skip it for one run with
 * `--no-bypass`. Every enable is logged loudly since approval prompts go off.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { AGENTS } from "./agents";
import { isDir, readJson } from "./util";
import { readConfig, setBypassDisabled } from "./config";
import { enableClaudeBypass, getClaudeBypass, mirrorClaudeSettings, setClaudeBypass } from "./claude";
import type { Agent } from "./agents";

/** Agents that expose a permission-bypass switch. */
export const BYPASS_SUPPORTED = ["claude", "codex", "opencode"];

interface BypassWrite { path: string; changed: boolean; }

/**
 * Decide which agents get permission-bypass. Precedence: `--no-bypass` wins
 * (none); then an explicit `--bypass` list; then the default-on policy - every
 * supported agent except those the user opted out of (`permissionBypass` off
 * disables the whole default; `bypassDisabled` excludes specific agents). The
 * default applies in non-interactive (`--yes`) runs too; an interactive run still
 * shows a review prompt with the defaults preselected.
 */
export async function resolveBypassSelection(
    candidates: Agent[],
    opts: { bypass: string[] | null; noBypass: boolean },
    interactive: boolean,
): Promise<string[]> {
    const supported = candidates.filter((a) => BYPASS_SUPPORTED.includes(a.name));
    if (!supported.length || opts.noBypass) return [];
    const names = supported.map((a) => a.name);

    if (opts.bypass !== null) {
        const req = opts.bypass.map((s) => s.trim().toLowerCase());
        if (req.includes("none")) return [];
        if (req.includes("all")) return names;
        return names.filter((n) => req.includes(n));
    }

    const cfg = readConfig().config;
    if (!cfg.permissionBypass) return [];                       // global opt-out
    const defaults = names.filter((n) => !cfg.bypassDisabled.includes(n));
    if (!defaults.length) return [];
    if (!interactive) return defaults;                          // default-on applies in --yes runs too

    const r = await p.multiselect({
        message: "Bypass approval prompts for which agents? (security trade-off: the agent stops asking before acting)",
        options: supported.map((a) => ({
            value: a.name,
            label: a.label,
            hint: a.name === "opencode" ? "on by default - note: less reliable without the approval gate" : "on by default",
        })),
        initialValues: defaults,
        required: false,
    });
    if (p.isCancel(r)) return [];                               // cancel: do not apply this run
    return r as string[];
}

/**
 * Apply the bypass setting for each selected agent and report via clack. On
 * `dryRun`, logs the planned change without writing. Codex is always written
 * globally (see `enableCodexBypass`).
 */
export function applyBypass(agentNames: string[], scope: "global" | "local", dryRun: boolean): void {
    for (const name of agentNames) {
        const res = enableFor(name, scope, dryRun);
        if (!res) continue;
        const label = AGENTS[name]?.label || name;
        if (dryRun) p.log.info(`Bypass (dry run): would enable for ${label} -> ${res.path}.`);
        else if (res.changed) p.log.warn(`Bypass: enabled for ${label} (${res.path}) - approval prompts are now OFF.`);
        else p.log.info(`Bypass: already enabled for ${label}.`);
    }
}

function enableFor(name: string, scope: "global" | "local", dryRun: boolean): BypassWrite | null {
    switch (name) {
        case "claude": return enableClaudeBypass(scope, dryRun);
        case "codex": return enableCodexBypass(dryRun);
        case "opencode": return enableOpencodeBypass(scope, dryRun);
        default: return null;
    }
}

/** Read whether permission bypass is currently enabled for an agent + scope. */
export function getBypass(name: string, scope: "global" | "local"): boolean {
    switch (name) {
        case "claude": return getClaudeBypass(scope);
        case "codex": return getCodexBypass();
        case "opencode": return getOpencodeBypass(scope);
        default: return false;
    }
}

/**
 * Enable or disable permission bypass for a single agent + scope, the symmetric
 * counterpart used by the interactive config surface. Returns the target path and
 * whether it changed, or null for an unknown agent. Codex is always written
 * globally (it has no project-local config).
 */
export function setBypass(name: string, scope: "global" | "local", on: boolean, dryRun: boolean): BypassWrite | null {
    if (!BYPASS_SUPPORTED.includes(name)) return null;
    // Persist the explicit choice so a deliberate "off" is never auto-re-enabled by a
    // later install, and turning it back "on" clears that opt-out.
    if (!dryRun) setBypassDisabled(name, !on);
    switch (name) {
        case "claude": return setClaudeBypass(scope, on, dryRun);
        case "codex": return on ? enableCodexBypass(dryRun) : disableCodexBypass(dryRun);
        case "opencode": return on ? enableOpencodeBypass(scope, dryRun) : disableOpencodeBypass(scope, dryRun);
        default: return null;
    }
}

/**
 * Mirror enigma-managed agent-native settings from the user's default/global
 * config into a managed account's config dir, so `enigma <tool> <account>`
 * behaves like the default account: Claude's settings.json knobs (attribution,
 * bypass, statusline), Codex's approval_policy/sandbox_mode in config.toml, and
 * opencode's "*" permission catch-all in opencode.json. Mirrors presence AND
 * absence (turning a knob off propagates); every other account setting is kept.
 */
export function mirrorAccountSettings(toolName: string, accountDir: string): void {
    switch (toolName) {
        case "claude":
            mirrorClaudeSettings(accountDir);
            return;
        case "codex":
            mirrorCodexConfig(accountDir);
            return;
        case "opencode": {
            const path = join(accountDir, "xdg-config", "opencode", "opencode.json");
            if (getOpencodeBypass("global")) enableOpencodeBypassAt(path, false);
            else disableOpencodeBypassAt(path, false);
            return;
        }
        default:
            return;
    }
}

/** Mirror the bypass keys of ~/.codex/config.toml into an account's config.toml. */
function mirrorCodexConfig(accountDir: string): void {
    const global = existsSync(join(homedir(), ".codex", "config.toml"))
        ? readFileSync(join(homedir(), ".codex", "config.toml"), "utf8")
        : "";
    const path = join(accountDir, "config.toml");
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    let after = before;
    for (const key of ["approval_policy", "sandbox_mode"]) {
        const value = getTomlTopLevelKey(global, key);
        after = value === null ? removeTomlTopLevelKey(after, key) : setTomlTopLevelKey(after, key, value);
    }
    if (after === before || (before === "" && after.trim() === "")) return;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, after);
}

/** True when Codex's global config has the full-bypass knobs set. */
function getCodexBypass(): boolean {
    const path = join(homedir(), ".codex", "config.toml");
    const content = existsSync(path) ? readFileSync(path, "utf8") : "";
    return getTomlTopLevelKey(content, "approval_policy") === "\"never\"";
}

/**
 * Disable Codex bypass by removing the `approval_policy` and `sandbox_mode`
 * top-level keys, returning Codex to its default approval behavior. Other config
 * is preserved.
 */
function disableCodexBypass(dryRun: boolean): BypassWrite {
    const path = join(homedir(), ".codex", "config.toml");
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    let after = removeTomlTopLevelKey(before, "approval_policy");
    after = removeTomlTopLevelKey(after, "sandbox_mode");
    const changed = after !== before;
    if (changed && !dryRun) writeFileSync(path, after);
    return { path, changed };
}

/** True when opencode's config grants the `"*": "allow"` catch-all (or `"allow"`). */
function getOpencodeBypass(scope: "global" | "local"): boolean {
    return opencodeBypassAt(opencodeConfigPath(scope));
}

/** Path-based variant of `getOpencodeBypass`, for managed account config files. */
function opencodeBypassAt(path: string): boolean {
    const perm = (readJson<Record<string, unknown>>(path) || {}).permission;
    return perm === "allow"
        || (typeof perm === "object" && perm !== null && (perm as Record<string, unknown>)["*"] === "allow");
}

/**
 * Disable opencode bypass by removing the `"*": "allow"` catch-all (or a bare
 * `"allow"`) while preserving any explicit per-pattern rules. Removes the
 * `permission` key entirely if nothing else remains.
 */
function disableOpencodeBypass(scope: "global" | "local", dryRun: boolean): BypassWrite {
    return disableOpencodeBypassAt(opencodeConfigPath(scope), dryRun);
}

function disableOpencodeBypassAt(path: string, dryRun: boolean): BypassWrite {
    const current = readJson<Record<string, unknown>>(path) || {};
    const perm = current.permission;

    if (!opencodeBypassAt(path)) return { path, changed: false };
    if (dryRun) return { path, changed: true };

    const next: Record<string, unknown> = { ...current };
    if (typeof perm === "object" && perm !== null) {
        const rest: Record<string, unknown> = {};
        for (const k of Object.keys(perm as Record<string, unknown>)) {
            if (k !== "*") rest[k] = (perm as Record<string, unknown>)[k];
        }
        if (Object.keys(rest).length) next.permission = rest;
        else delete next.permission;
    } else {
        delete next.permission;
    }

    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return { path, changed: true };
}

/** opencode config path for a scope (global user config, or the project root). */
function opencodeConfigPath(scope: "global" | "local"): string {
    return scope === "global"
        ? join(homedir(), ".config", "opencode", "opencode.json")
        : join(process.cwd(), "opencode.json");
}

/**
 * Codex reads its config only from ~/.codex/config.toml (there is no
 * project-local equivalent), so bypass is always written there regardless of
 * the chosen install scope. Sets the top-level `approval_policy = "never"`
 * (no approval prompts) plus `sandbox_mode = "danger-full-access"` (no sandbox
 * restrictions) - together the equivalent of Codex's full bypass mode.
 */
function enableCodexBypass(dryRun: boolean): BypassWrite {
    const path = join(homedir(), ".codex", "config.toml");
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    let after = setTomlTopLevelKey(before, "approval_policy", "\"never\"");
    after = setTomlTopLevelKey(after, "sandbox_mode", "\"danger-full-access\"");
    const changed = after !== before;
    if (changed && !dryRun) {
        const dir = join(path, "..");
        if (!isDir(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(path, after);
    }
    return { path, changed };
}

/**
 * opencode reads `permission` from opencode.json (global ~/.config/opencode,
 * or the project root for a local install). Sets a `"*": "allow"` catch-all as
 * the base while preserving any existing specific rules after it, so explicit
 * per-pattern rules (e.g. "rm *": "deny") still take precedence (last match
 * wins in opencode).
 */
function enableOpencodeBypass(scope: "global" | "local", dryRun: boolean): BypassWrite {
    return enableOpencodeBypassAt(opencodeConfigPath(scope), dryRun);
}

function enableOpencodeBypassAt(path: string, dryRun: boolean): BypassWrite {
    const current = readJson<Record<string, unknown>>(path) || {};
    const perm = current.permission;

    if (opencodeBypassAt(path)) return { path, changed: false };
    if (dryRun) return { path, changed: true };

    const existing = (typeof perm === "object" && perm !== null) ? perm as Record<string, unknown> : {};
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(existing)) if (k !== "*") rest[k] = existing[k];

    const next = { ...current, permission: { "*": "allow", ...rest } };
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return { path, changed: true };
}

/**
 * Set a single top-level scalar key in a TOML document without a TOML library
 * (kept dependency-free to match the project's no-dependency config writers).
 * A top-level key must precede the first `[table]` header: an existing one in
 * that region is replaced in place; otherwise the assignment is inserted just
 * before the first table (or appended). Returns the original string unchanged
 * when the key already holds the value. Output ends with exactly one newline.
 */
function setTomlTopLevelKey(content: string, key: string, tomlValue: string): string {
    const assign = `${key} = ${tomlValue}`;
    if (content.trim() === "") return `${assign}\n`;

    const lines = content.split("\n");
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    const scanEnd = firstTable === -1 ? lines.length : firstTable;
    const keyRe = new RegExp(`^\\s*${key}\\s*=`);

    for (let i = 0; i < scanEnd; i++) {
        if (!keyRe.test(lines[i]!)) continue;
        if (lines[i]!.trim() === assign) return content;
        lines[i] = assign;
        return normalizeTrailingNewline(lines.join("\n"));
    }

    // Insert after the last existing top-level key so top-level keys stay
    // grouped above the first table; add a blank separator if a table follows.
    let insertAt = scanEnd;
    while (insertAt > 0 && lines[insertAt - 1]!.trim() === "") insertAt--;
    const followsTable = insertAt < lines.length && /^\s*\[/.test(lines[insertAt]!);
    lines.splice(insertAt, 0, ...(followsTable ? [assign, ""] : [assign]));
    return normalizeTrailingNewline(lines.join("\n"));
}

/**
 * Read a top-level scalar key's raw value from a TOML document (the region before
 * the first `[table]`), or null if absent. The value is returned verbatim
 * including quotes, so a string compares against e.g. `"\"never\""`.
 */
function getTomlTopLevelKey(content: string, key: string): string | null {
    const lines = content.split("\n");
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    const scanEnd = firstTable === -1 ? lines.length : firstTable;
    const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
    for (let i = 0; i < scanEnd; i++) {
        const m = keyRe.exec(lines[i]!);
        if (m) return m[1]!;
    }
    return null;
}

/**
 * Remove a top-level key assignment from a TOML document (only in the region
 * before the first `[table]`). Returns the content unchanged when the key is
 * absent; otherwise drops the line and normalizes trailing whitespace.
 */
function removeTomlTopLevelKey(content: string, key: string): string {
    if (content.trim() === "") return content;
    const lines = content.split("\n");
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    const scanEnd = firstTable === -1 ? lines.length : firstTable;
    const keyRe = new RegExp(`^\\s*${key}\\s*=`);
    const kept = lines.filter((l, i) => !(i < scanEnd && keyRe.test(l)));
    if (kept.length === lines.length) return content;
    return normalizeTrailingNewline(kept.join("\n"));
}

/** Trim trailing whitespace/blank lines and end with exactly one newline. */
function normalizeTrailingNewline(s: string): string {
    return `${s.replace(/\s+$/, "")}\n`;
}
