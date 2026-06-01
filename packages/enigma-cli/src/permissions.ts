/**
 * Permission-bypass configuration across agents. Optionally disables each
 * coding agent's per-action approval prompts by writing its native config:
 * Claude Code (settings.json `permissions.defaultMode`), Codex (config.toml
 * `approval_policy`), opencode (opencode.json `permission`).
 *
 * Bypassing approvals is a deliberate least-privilege downgrade, so it is
 * strictly opt-in: enabled only via the interactive prompt or an explicit
 * `--bypass` flag, never silently in non-interactive (`--yes`) runs.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { AGENTS } from "./agents";
import { isDir, readJson } from "./util";
import { enableClaudeBypass } from "./claude";
import type { Agent } from "./agents";

/** Agents that expose a permission-bypass switch. */
export const BYPASS_SUPPORTED = ["claude", "codex", "opencode"];

/**
 * Preselected in the interactive prompt. opencode is intentionally excluded:
 * its supported models are less reliable, so removing the approval gate there
 * is riskier and should be a conscious choice rather than a default.
 */
const BYPASS_DEFAULT_ON = new Set(["claude", "codex"]);

interface BypassWrite { path: string; changed: boolean; }

/**
 * Decide which agents get permission-bypass. Precedence: `--no-bypass` wins
 * (none); then an explicit `--bypass` list; then the interactive prompt
 * (claude+codex preselected). A non-interactive run without a flag returns []
 * so a security downgrade is never applied silently.
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
    if (!interactive) return [];

    const r = await p.multiselect({
        message: "Bypass approval prompts for which agents? (security trade-off: the agent stops asking before acting)",
        options: supported.map((a) => ({
            value: a.name,
            label: a.label,
            hint: BYPASS_DEFAULT_ON.has(a.name) ? "recommended" : "less reliable - off by default",
        })),
        initialValues: names.filter((n) => BYPASS_DEFAULT_ON.has(n)),
        required: false,
    });
    if (p.isCancel(r)) return [];
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
    const path = scope === "global"
        ? join(homedir(), ".config", "opencode", "opencode.json")
        : join(process.cwd(), "opencode.json");
    const current = readJson<Record<string, unknown>>(path) || {};
    const perm = current.permission;

    const alreadyAllowAll = perm === "allow"
        || (typeof perm === "object" && perm !== null && (perm as Record<string, unknown>)["*"] === "allow");
    if (alreadyAllowAll) return { path, changed: false };
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

/** Trim trailing whitespace/blank lines and end with exactly one newline. */
function normalizeTrailingNewline(s: string): string {
    return `${s.replace(/\s+$/, "")}\n`;
}
