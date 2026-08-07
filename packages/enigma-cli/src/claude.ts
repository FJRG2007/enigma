/**
 * Claude Code specific configuration. Deterministically disables the automatic
 * "Co-Authored-By: Claude" commit trailer / "Generated with Claude Code" PR
 * footer, and (opt-in) sets the permission bypass mode, by writing the real
 * settings.json knobs. Workspace trust is the one knob that lives in Claude's
 * user-global `.claude.json` instead - see the trust section below.
 *
 * A skill rule only persuades the model; this writes the real settings.json knob
 * so the behavior is enforced regardless of what the model does.
 */

import { join, normalize, parse, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { enigmaHome, findGitRoot, isDir, readJson } from "./util";
import { CONFIG_DEFAULTS, readConfig, readGlobalConfig } from "./config";

/**
 * The command enigma points Claude Code's statusLine at. Also the marker that tells
 * an enigma-managed statusline apart from a user's own, so every read/write path
 * must compare against this one constant.
 */
const STATUSLINE_COMMAND = "enigma statusline";

/**
 * Ceiling for the refresh interval. Claude Code documents 1-60 seconds; a value above the
 * ceiling would be silently ignored by the client, which reads as "enigma wrote it wrong"
 * rather than "the harness capped it". Use 0 to drop the timer instead of a huge interval.
 */
const STATUSLINE_REFRESH_MAX = 60;

/**
 * Seconds between status-bar refreshes, from `statuslineRefresh`. See
 * `enableClaudeStatusline` for why the default is 10 rather than the documented minimum of
 * 1 - it is a process-spawn budget, not a taste call. 0 means no timer at all.
 *
 * `.enigma.json` is hand-edited and repo-local files travel with a clone, so the value is
 * treated as untrusted input: anything that is not a finite number in range collapses to
 * the default rather than reaching Claude's settings.json.
 */
function statuslineRefreshSeconds(scope: "global" | "local"): number {
    // The read is scoped to the file being WRITTEN. `readConfig()` merges the repo-local
    // .enigma.json over the global one, so using it for a global write would take a value
    // that belongs to one project and stamp it on the bar every other project sees - while
    // the CLI printed "(global)". A local write is the merged, nearest-wins value by
    // definition, which is exactly what that project's bar should carry.
    const raw = scope === "global" ? readGlobalConfig().statuslineRefresh : readConfig().config.statuslineRefresh;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return CONFIG_DEFAULTS.statuslineRefresh;
    const seconds = Math.round(raw);
    if (seconds < 0 || seconds > STATUSLINE_REFRESH_MAX) return CONFIG_DEFAULTS.statuslineRefresh;
    return seconds;
}

/**
 * The statusLine block enigma writes. `refreshInterval` is omitted entirely at 0: the key
 * is what creates the timer, so leaving it out is the difference between "refresh every N
 * seconds" and "refresh only when the conversation moves".
 */
function statuslineBlock(scope: "global" | "local"): Record<string, unknown> {
    const seconds = statuslineRefreshSeconds(scope);
    const block: Record<string, unknown> = { type: "command", command: STATUSLINE_COMMAND, padding: 0 };
    if (seconds > 0) block.refreshInterval = seconds;
    return block;
}

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
export function setClaudeBypass(scope: "global" | "local", on: boolean, dryRun: boolean): { path: string; changed: boolean; } {
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
export function enableClaudeBypass(scope: "global" | "local", dryRun: boolean): { path: string; changed: boolean; } {
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
 * Ten seconds by default, not the documented minimum of one. Every refresh spawns a
 * process, and on Windows each spawn creates console hosts: measured here, a one-second
 * interval added ~4 conhost.exe per refresh over the machine's baseline, making the status
 * bar the single busiest spawner on the box. That churn is what surfaced as the
 * console-window flash in anthropics/claude-code#54590 (closed as a duplicate of #51867,
 * neither ever fixed). Ten is also what the established statusline projects settle on -
 * ccstatusline defaults fresh installs to 10, claude-powerline documents 10 as "within
 * ~10s of reality" - and pipeline steps run for minutes, so it costs nothing that matters.
 *
 * Ten is a budget for a healthy box, though, not a floor that holds everywhere: a process
 * start is not free, and where it is expensive (real-time AV scanning the runtime, several
 * agent sessions refreshing their own bars at once) the timer is felt as input lag in the
 * agent itself. `statuslineRefresh` is the dial for that, and 0 removes the timer.
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
    writeClaudeSettings(path, { ...current, statusLine: statuslineBlock(scope) });
    return true;
}

/**
 * What a refresh reconcile did, which the caller reports to the user.
 *
 * Three outcomes and not a boolean: "there is no enigma bar here" and "the bar already had
 * this value" are both no-writes, and collapsing them makes the CLI tell someone who just
 * re-set the value that no status bar is installed.
 */
export type StatuslineRefreshSync = "not-installed" | "unchanged" | "updated";

/**
 * Re-write the refresh interval on an enigma-managed statusline, leaving a user's own bar
 * alone.
 *
 * Separate from `enableClaudeStatusline` on purpose. That one is install-only - it refuses
 * to touch an existing block - which is what keeps `syncDeployed` from clobbering a bar the
 * user hand-tuned in settings.json on every launch. But it also means a changed
 * `statuslineRefresh` would never reach an existing install, so the setter calls this: an
 * explicit `enigma config statusline-refresh N` is the one moment where overwriting the
 * value in settings.json is exactly what was asked for.
 */
export function syncClaudeStatuslineRefresh(scope: "global" | "local"): StatuslineRefreshSync {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path);
    const line = current?.statusLine as Record<string, unknown> | undefined;
    if (!current || line?.command !== STATUSLINE_COMMAND) return "not-installed";

    const seconds = statuslineRefreshSeconds(scope);
    const next = { ...line };
    if (seconds > 0) next.refreshInterval = seconds;
    else delete next.refreshInterval;
    if (next.refreshInterval === line.refreshInterval) return "unchanged";

    writeClaudeSettings(path, { ...current, statusLine: next });
    return "updated";
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
 * Claude Code asks "Is this a project you trust?" the first time it starts in a
 * workspace and records the answer as `projects[<workspace>].hasTrustDialogAccepted`
 * in its user-global `.claude.json` (not settings.json). Two details in the client
 * make that prompt recur instead of being a one-off:
 *
 *   - In the home directory the answer is kept for the SESSION only and never
 *     persisted, so every start there asks again.
 *   - Trust is inherited from parent directories, but the second form of the prompt
 *     (the backstop for settings that grant permissions) is skipped only when the
 *     workspace's OWN entry is trusted - and it fires for any repo whose local
 *     settings carry `permissions.allow` rules, which is most of them.
 *
 * So retiring the prompt takes both keys: the filesystem root, which the client's
 * parent walk turns into "every path on this drive" (the home directory included),
 * and the workspace itself.
 *
 * This is a deliberate security trade-off, which is why it is a toggle: the prompt
 * exists to make you look at code you did not write before an agent runs in it.
 */

/** Claude Code's user-global state file, where workspace trust is recorded. */
function claudeStatePath(): string {
    return join(enigmaHome(), ".claude.json");
}

const TRUST_KEY = "hasTrustDialogAccepted";

/**
 * The project entry Claude Code creates for a workspace it has not seen. Written
 * verbatim for a new entry so the file stays exactly what the client would produce.
 */
const CLAUDE_PROJECT_DEFAULTS: Record<string, unknown> = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: false,
    projectOnboardingSeenCount: 0,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
};

/**
 * The key Claude Code files a workspace under: the git repository root when the
 * directory is inside one, else the directory itself, with forward slashes. It has to
 * match the client's own computation, since an entry under any other key is one it
 * never reads. A linked worktree is the one case where the client keys the MAIN
 * repository root instead; trust there comes from the inherited root entry.
 */
export function claudeWorkspaceKey(dir: string): string {
    return normalize(findGitRoot(dir) ?? resolve(dir)).replaceAll("\\", "/");
}

/** Filesystem roots to trust: the drive of the config home and of `dir` (usually one). */
function trustRoots(dir: string): string[] {
    const roots = [parse(enigmaHome()).root, parse(resolve(dir)).root]
        .map((r) => normalize(r).replaceAll("\\", "/"));
    return [...new Set(roots)];
}

/**
 * Whether enigma's blanket trust is in place in `file` (every filesystem root marked
 * trusted). Deliberately ignores per-workspace entries: those are also what accepting
 * the prompt by hand writes, so reading them would report a user's own answer as this
 * setting being on.
 */
function hasTrustRoots(file: string, dir: string): boolean {
    const projects = readJson<Record<string, unknown>>(file)?.projects as Record<string, Record<string, unknown>> | undefined;
    if (!projects) return false;
    return trustRoots(dir).every((root) => projects[root]?.[TRUST_KEY] === true);
}

/** Reports whether Claude Code's workspace trust prompt is currently pre-answered. */
export function getClaudeTrust(): boolean {
    return hasTrustRoots(claudeStatePath(), process.cwd());
}

/**
 * Mark the filesystem roots and `dir` as trusted in a Claude state file, leaving every
 * other project entry untouched. Returns true when the file changed - so a caller that
 * runs on every launch (the sync path) stays a no-op once the trust is recorded.
 * Refuses to write a file it cannot parse: overwriting it would discard the user's
 * login and per-project state.
 */
export function trustClaudeWorkspaces(file: string, dir: string): boolean {
    const current = existsSync(file) ? readJson<Record<string, unknown>>(file) : {};
    if (current === null) return false;
    const projects = (typeof current.projects === "object" && current.projects !== null)
        ? { ...current.projects as Record<string, Record<string, unknown>> }
        : {};

    let changed = false;
    for (const key of [...trustRoots(dir), claudeWorkspaceKey(dir)]) {
        const entry = projects[key];
        if (entry?.[TRUST_KEY] === true) continue;
        projects[key] = { ...CLAUDE_PROJECT_DEFAULTS, ...entry, [TRUST_KEY]: true };
        changed = true;
    }
    if (!changed) return false;

    writeClaudeSettings(file, { ...current, projects });
    return true;
}

/**
 * Drop the blanket root trust from a Claude state file. Individual workspaces keep
 * theirs: those entries are indistinguishable from the ones the user accepted by hand,
 * and clearing them would re-ask for every project they already trusted. Returns true
 * when the file changed.
 */
export function untrustClaudeWorkspaces(file: string): boolean {
    const current = readJson<Record<string, unknown>>(file);
    if (!current) return false;
    const projects = (typeof current.projects === "object" && current.projects !== null)
        ? { ...current.projects as Record<string, Record<string, unknown>> }
        : {};

    let changed = false;
    for (const root of trustRoots(process.cwd())) {
        const entry = projects[root];
        if (!entry || entry[TRUST_KEY] !== true) continue;
        projects[root] = { ...entry, [TRUST_KEY]: false };
        changed = true;
    }
    if (!changed) return false;

    writeClaudeSettings(file, { ...current, projects });
    return true;
}

/** Applies or revokes the trust pre-answer in Claude's global state. Returns true when written. */
export function setClaudeTrust(on: boolean): boolean {
    const file = claudeStatePath();
    return on ? trustClaudeWorkspaces(file, process.cwd()) : untrustClaudeWorkspaces(file);
}

/**
 * Propagate the trust pre-answer into a managed account's config dir, which has its own
 * `.claude.json` and therefore its own trust state - without this, `enigma claude
 * <account>` would meet the prompt the default account no longer shows. Mirrors absence
 * too, so turning the setting off reaches the accounts.
 */
export function mirrorClaudeTrust(accountDir: string): boolean {
    const file = join(accountDir, ".claude.json");
    return getClaudeTrust() ? trustClaudeWorkspaces(file, process.cwd()) : untrustClaudeWorkspaces(file);
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

/** Write a Claude Code JSON config (settings.json or `.claude.json`), creating its directory. */
function writeClaudeSettings(path: string, data: Record<string, unknown>): void {
    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
