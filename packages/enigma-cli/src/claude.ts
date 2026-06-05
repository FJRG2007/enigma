/**
 * Claude Code specific configuration. Deterministically disables the automatic
 * "Co-Authored-By: Claude" commit trailer / "Generated with Claude Code" PR
 * footer, and (opt-in) sets the permission bypass mode, by writing the real
 * settings.json knobs.
 *
 * A skill rule only persuades the model; this writes the real settings.json knob
 * so the behavior is enforced regardless of what the model does.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isDir, readJson } from "./util";

/** Settings file Claude Code reads for a given scope. */
function claudeSettingsPath(scope: "global" | "local"): string {
    return scope === "global"
        ? join(homedir(), ".claude", "settings.json")
        : join(process.cwd(), ".claude", "settings.json");
}

/**
 * Merge the attribution-disabling keys into Claude's settings.json without
 * clobbering other settings. Sets the current `attribution` object (commit/pr
 * empty) and the legacy `includeCoAuthoredBy: false` for older versions.
 * Returns true if the file was written (i.e. something changed).
 */
export function disableClaudeAttribution(scope: "global" | "local"): boolean {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};

    const attribution = (typeof current.attribution === "object" && current.attribution !== null)
        ? current.attribution as Record<string, unknown>
        : {};

    const alreadyOff =
        attribution.commit === "" && attribution.pr === "" && current.includeCoAuthoredBy === false;
    if (alreadyOff) return false;

    const next = {
        ...current,
        attribution: { ...attribution, commit: "", pr: "" },
        includeCoAuthoredBy: false,
    };

    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return true;
}

/**
 * Read whether Claude commit attribution is enabled for a scope. Returns true
 * when Claude would add its own attribution (the Claude default), false when
 * enigma's disabling overrides are in place. Used by the config surface to show
 * the current value.
 */
export function getClaudeAttribution(scope: "global" | "local"): boolean {
    const current = readJson<Record<string, unknown>>(claudeSettingsPath(scope)) || {};
    const attribution = current.attribution as Record<string, unknown> | undefined;
    const disabled = Boolean(attribution) && attribution!.commit === "" && attribution!.pr === ""
        && current.includeCoAuthoredBy === false;
    return !disabled;
}

/**
 * Enable or disable Claude commit attribution for a scope. Disabling delegates to
 * `disableClaudeAttribution`. Enabling restores Claude's defaults by removing the
 * overrides enigma wrote (empty `attribution.commit`/`pr` and
 * `includeCoAuthoredBy: false`), without touching unrelated settings. Returns
 * true if the file was written.
 */
export function setClaudeAttribution(scope: "global" | "local", enabled: boolean): boolean {
    if (!enabled) return disableClaudeAttribution(scope);

    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const attribution = (typeof current.attribution === "object" && current.attribution !== null)
        ? { ...current.attribution as Record<string, unknown> }
        : {};

    let changed = false;
    if (attribution.commit === "") { delete attribution.commit; changed = true; }
    if (attribution.pr === "") { delete attribution.pr; changed = true; }
    if (current.includeCoAuthoredBy === false) changed = true;
    if (!changed) return false;

    const next: Record<string, unknown> = { ...current };
    if (Object.keys(attribution).length) next.attribution = attribution;
    else delete next.attribution;
    delete next.includeCoAuthoredBy;

    writeClaudeSettings(path, next);
    return true;
}

/** Read whether Claude's permission bypass is enabled for a scope. */
export function getClaudeBypass(scope: "global" | "local"): boolean {
    const current = readJson<Record<string, unknown>>(claudeSettingsPath(scope)) || {};
    const permissions = current.permissions as Record<string, unknown> | undefined;
    return Boolean(permissions) && permissions!.defaultMode === "bypassPermissions";
}

/**
 * Enable or disable Claude Code's permission bypass for a scope. Enabling sets
 * `permissions.defaultMode` to "bypassPermissions"; disabling removes that key so
 * Claude returns to its default (ask before acting). Other settings and explicit
 * `permissions.deny` rules are preserved. On `dryRun`, reports the would-be
 * change without writing.
 */
export function setClaudeBypass(scope: "global" | "local", on: boolean, dryRun: boolean): { path: string; changed: boolean } {
    if (on) return enableClaudeBypass(scope, dryRun);

    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const permissions = (typeof current.permissions === "object" && current.permissions !== null)
        ? { ...current.permissions as Record<string, unknown> }
        : {};
    if (permissions.defaultMode !== "bypassPermissions") return { path, changed: false };
    if (dryRun) return { path, changed: true };

    delete permissions.defaultMode;
    const next: Record<string, unknown> = { ...current };
    if (Object.keys(permissions).length) next.permissions = permissions;
    else delete next.permissions;

    writeClaudeSettings(path, next);
    return { path, changed: true };
}

/**
 * Enable Claude Code's permission bypass by setting `permissions.defaultMode`
 * to "bypassPermissions" so the agent stops asking for per-action approval.
 * Merges into any existing settings; explicit `permissions.deny` rules still
 * take precedence (deny wins). Returns the target path and whether it changed.
 * On `dryRun`, reports the would-be change without writing.
 */
export function enableClaudeBypass(scope: "global" | "local", dryRun: boolean): { path: string; changed: boolean } {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};

    const permissions = (typeof current.permissions === "object" && current.permissions !== null)
        ? current.permissions as Record<string, unknown>
        : {};
    if (permissions.defaultMode === "bypassPermissions") return { path, changed: false };
    if (dryRun) return { path, changed: true };

    const next = { ...current, permissions: { ...permissions, defaultMode: "bypassPermissions" } };
    writeClaudeSettings(path, next);
    return { path, changed: true };
}

/**
 * Point Claude Code's statusline at `enigma statusline`, which shows an [ENIGMA] badge
 * (with the token-efficient level when active, e.g. [ENIGMA:FULL]). Only writes when no
 * statusline is configured yet - it never clobbers a user's own. Returns true if written.
 */
export function enableClaudeStatusline(scope: "global" | "local"): boolean {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    if (current.statusLine !== undefined) return false;
    const next = { ...current, statusLine: { type: "command", command: "enigma statusline", padding: 0 } };
    writeClaudeSettings(path, next);
    return true;
}

/**
 * Mirror the enigma-managed settings.json knobs from the user's global Claude
 * settings into a managed account's config dir, so an account launched via
 * `enigma claude <account>` behaves like the default one. Mirrored knobs:
 * attribution overrides (commit/pr + includeCoAuthoredBy), permission bypass
 * (permissions.defaultMode) and the enigma statusline (added only when the
 * account has none - never clobbers a custom one). Every other account setting
 * is preserved, and absence in the global file removes the matching override so
 * turning a knob off propagates too. Returns true when the account file changed.
 */
export function mirrorClaudeSettings(accountDir: string): boolean {
    const global = readJson<Record<string, unknown>>(claudeSettingsPath("global")) || {};
    const path = join(accountDir, "settings.json");
    const current = readJson<Record<string, unknown>>(path) || {};
    const next: Record<string, unknown> = { ...current };

    // Attribution: mirror exactly the disabling overrides enigma manages.
    const globalAttr = (typeof global.attribution === "object" && global.attribution !== null)
        ? global.attribution as Record<string, unknown>
        : {};
    const attr = (typeof next.attribution === "object" && next.attribution !== null)
        ? { ...next.attribution as Record<string, unknown> }
        : {};
    for (const key of ["commit", "pr"] as const) {
        if (globalAttr[key] === "") attr[key] = "";
        else if (attr[key] === "") delete attr[key];
    }
    if (Object.keys(attr).length) next.attribution = attr;
    else delete next.attribution;
    if (global.includeCoAuthoredBy === false) next.includeCoAuthoredBy = false;
    else if (next.includeCoAuthoredBy === false) delete next.includeCoAuthoredBy;

    // Permission bypass: mirror only the bypass mode enigma manages; any other
    // defaultMode the user set on the account is left alone.
    const globalPerm = (typeof global.permissions === "object" && global.permissions !== null)
        ? global.permissions as Record<string, unknown>
        : {};
    const perm = (typeof next.permissions === "object" && next.permissions !== null)
        ? { ...next.permissions as Record<string, unknown> }
        : {};
    if (globalPerm.defaultMode === "bypassPermissions") perm.defaultMode = "bypassPermissions";
    else if (perm.defaultMode === "bypassPermissions") delete perm.defaultMode;
    if (Object.keys(perm).length) next.permissions = perm;
    else delete next.permissions;

    // Statusline: propagate enigma's statusline when the account has none.
    const globalLine = global.statusLine as Record<string, unknown> | undefined;
    if (next.statusLine === undefined && globalLine?.command === "enigma statusline") {
        next.statusLine = { ...globalLine };
    }

    if (JSON.stringify(next) === JSON.stringify(current)) return false;
    // Nothing to mirror into a file that does not exist yet: avoid creating an
    // empty settings.json in a fresh account dir.
    if (!existsSync(path) && Object.keys(next).length === 0) return false;
    writeClaudeSettings(path, next);
    return true;
}

/** Write Claude settings.json, creating the parent directory if needed. */
function writeClaudeSettings(path: string, data: Record<string, unknown>): void {
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
