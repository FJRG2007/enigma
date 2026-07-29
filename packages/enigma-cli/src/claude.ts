/**
 * Claude Code specific configuration. Deterministically disables the automatic
 * "Co-Authored-By: Claude" commit trailer / "Generated with Claude Code" PR
 * footer, and (opt-in) sets the permission bypass mode, by writing the real
 * settings.json knobs.
 *
 * A skill rule only persuades the model; this writes the real settings.json knob
 * so the behavior is enforced regardless of what the model does.
 */

import { join } from "node:path";
import { enigmaHome, isDir, readJson } from "./util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/**
 * The command enigma points Claude Code's statusLine at. Also the marker that tells
 * an enigma-managed statusline apart from a user's own, so every read/write path
 * must compare against this one constant.
 */
const STATUSLINE_COMMAND = "enigma statusline";

/**
 * Seconds between status-bar refreshes. See `enableClaudeStatusline` for why this is 10
 * rather than the documented minimum of 1 - it is a process-spawn budget, not a taste call.
 */
const STATUSLINE_REFRESH_SECONDS = 10;

/** Settings file Claude Code reads for a given scope. */
function claudeSettingsPath(scope: "global" | "local"): string {
    return scope === "global"
        ? join(enigmaHome(), ".claude", "settings.json")
        : join(process.cwd(), ".claude", "settings.json");
}

/**
 * Env var Claude Code reads to suppress the "How is Claude doing?" session-quality
 * survey. Set under settings.json `env` so it persists regardless of the shell, the
 * same deterministic mechanism Claude Code documents for the setting.
 */
const FEEDBACK_SURVEY_ENV = "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY";

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

/**
 * Disable Claude Code's session feedback survey by setting
 * env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY to "1" in settings.json, merging into any
 * existing env block without clobbering other variables. Returns true if written.
 */
export function disableClaudeFeedbackSurvey(scope: "global" | "local"): boolean {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const env = (typeof current.env === "object" && current.env !== null)
        ? current.env as Record<string, unknown>
        : {};
    if (env[FEEDBACK_SURVEY_ENV] === "1") return false;

    const next = { ...current, env: { ...env, [FEEDBACK_SURVEY_ENV]: "1" } };
    writeClaudeSettings(path, next);
    return true;
}

/**
 * Read whether the Claude feedback survey is enabled for a scope. Returns true when
 * Claude would show the survey (its default), false when enigma's disabling override
 * is in place. Used by the config surface to show the current value.
 */
export function getClaudeFeedbackSurvey(scope: "global" | "local"): boolean {
    const current = readJson<Record<string, unknown>>(claudeSettingsPath(scope)) || {};
    const env = current.env as Record<string, unknown> | undefined;
    return !(env && env[FEEDBACK_SURVEY_ENV] === "1");
}

/**
 * Enable or disable the Claude feedback survey for a scope. Disabling delegates to
 * `disableClaudeFeedbackSurvey`. Enabling removes the env override enigma wrote,
 * leaving other env variables intact. Returns true if the file was written.
 */
export function setClaudeFeedbackSurvey(scope: "global" | "local", enabled: boolean): boolean {
    if (!enabled) return disableClaudeFeedbackSurvey(scope);

    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    const env = (typeof current.env === "object" && current.env !== null)
        ? { ...current.env as Record<string, unknown> }
        : {};
    if (env[FEEDBACK_SURVEY_ENV] !== "1") return false;

    delete env[FEEDBACK_SURVEY_ENV];
    const next: Record<string, unknown> = { ...current };
    if (Object.keys(env).length) next.env = env;
    else delete next.env;

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
 * Point Claude Code's statusline at `enigma statusline`: the [ENIGMA] badge (carrying the
 * token-efficient level when active), session context and cost, plus live gate progress
 * while a run is in flight. Only writes when no statusline is configured yet - it never
 * clobbers a user's own. Returns true if written.
 *
 * `refreshInterval` is what makes the gate line move: the event-driven triggers all fire
 * at turn boundaries, so without a timer the bar would freeze for exactly as long as a
 * pipeline blocks, which is the case it exists to report on.
 *
 * Ten seconds, not the documented minimum of one. Every refresh spawns a process, and on
 * Windows each spawn creates console hosts: measured here, a one-second interval added
 * ~4 conhost.exe per refresh over the machine's baseline, making the status bar the single
 * busiest spawner on the box. That churn is what surfaced as the console-window flash in
 * anthropics/claude-code#54590 (closed as a duplicate of #51867, neither ever fixed). Ten
 * is also what the established statusline projects settle on - ccstatusline defaults fresh
 * installs to 10, claude-powerline documents 10 as "within ~10s of reality" - and pipeline
 * steps run for minutes, so it costs nothing that matters here.
 *
 * Windows used to be excluded outright. The shipped client now routes the statusline
 * through the same spawn helper as hooks, which does pass `windowsHide`, so the console it
 * creates stays hidden and the exclusion is gone. If windows ever become visible again,
 * `disableClaudeStatusline` (or `enigma config statusline off`) removes it.
 */
export function enableClaudeStatusline(scope: "global" | "local"): boolean {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};
    if (current.statusLine !== undefined) return false;
    const statusLine = { type: "command", command: STATUSLINE_COMMAND, padding: 0, refreshInterval: STATUSLINE_REFRESH_SECONDS };
    writeClaudeSettings(path, { ...current, statusLine });
    return true;
}

/** Reads the statusLine block Claude Code has configured for a scope, if any. */
function claudeStatusline(scope: "global" | "local"): Record<string, unknown> | undefined {
    return readJson<Record<string, unknown>>(claudeSettingsPath(scope))?.statusLine as Record<string, unknown> | undefined;
}

/** Reports whether the configured statusline is enigma's own. */
export function getClaudeStatusline(scope: "global" | "local"): boolean {
    return claudeStatusline(scope)?.command === STATUSLINE_COMMAND;
}

/**
 * Reports whether a statusline is configured that enigma did not write. Neither
 * enable nor disable will touch it, so the surfaces use this to explain why the
 * toggle refused rather than reporting a silent no-op as success.
 */
export function hasCustomClaudeStatusline(scope: "global" | "local"): boolean {
    const line = claudeStatusline(scope);
    return line !== undefined && line.command !== STATUSLINE_COMMAND;
}

/** Installs or removes enigma's statusline. Returns true when the file changed. */
export function setClaudeStatusline(scope: "global" | "local", enabled: boolean): boolean {
    return enabled ? enableClaudeStatusline(scope) : disableClaudeStatusline(scope);
}

/**
 * Remove enigma's own statusline from a settings.json, leaving a user's custom one
 * untouched. The escape hatch for anyone who does not want it - and the revert if a
 * client regression brings back the Windows console flash described above. Returns
 * true when the file changed.
 */
export function disableClaudeStatusline(scope: "global" | "local"): boolean {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path);
    if (!current) return false;
    const line = current.statusLine as Record<string, unknown> | undefined;
    if (line?.command !== STATUSLINE_COMMAND) return false;
    const next = { ...current };
    delete next.statusLine;
    writeClaudeSettings(path, next);
    return true;
}

/**
 * Mirror the enigma-managed settings.json knobs from the user's global Claude
 * settings into a managed account's config dir, so an account launched via
 * `enigma claude <account>` behaves like the default one. Mirrored knobs:
 * attribution overrides (commit/pr + includeCoAuthoredBy), permission bypass
 * (permissions.defaultMode), the feedback-survey env override
 * (env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY) and the enigma statusline (added only
 * when the account has none - never clobbers a custom one). Every other account setting
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

    // Feedback survey: mirror only the disable override enigma manages; any other
    // env vars the user set on the account are left alone.
    const globalEnv = (typeof global.env === "object" && global.env !== null)
        ? global.env as Record<string, unknown>
        : {};
    const env = (typeof next.env === "object" && next.env !== null)
        ? { ...next.env as Record<string, unknown> }
        : {};
    if (globalEnv[FEEDBACK_SURVEY_ENV] === "1") env[FEEDBACK_SURVEY_ENV] = "1";
    else if (env[FEEDBACK_SURVEY_ENV] === "1") delete env[FEEDBACK_SURVEY_ENV];
    if (Object.keys(env).length) next.env = env;
    else delete next.env;

    // Statusline: propagate enigma's statusline when the account has none, so an account
    // launched via `enigma claude <account>` gets the same bar. A custom one is left alone.
    const globalLine = global.statusLine as Record<string, unknown> | undefined;
    if (next.statusLine === undefined && globalLine?.command === STATUSLINE_COMMAND) {
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
