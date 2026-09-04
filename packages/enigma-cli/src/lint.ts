/**
 * Auto-lint integration. When the `autoLint` toggle is on, enigma autonomously
 * installs @enigmax/linter into a managed dir and wires a post-write hook into each
 * agent so edits are auto-fixed (safe formatting) and only the unfixable findings
 * are surfaced back to the agent - with the least possible token cost (silence on a
 * clean file). Default OFF: this changes agent behavior and installs a package, so
 * it is an explicit opt-in.
 *
 * Wiring per agent:
 *  - Claude Code: no entry of its own. The lint step runs inside the one merged
 *    PostToolUse hook (post-edit-deploy.ts), so an edit costs one process instead of
 *    two; on unfixable findings that hook exits 2 with a compact stderr, which Claude
 *    feeds to the model exactly as the separate entry did.
 *  - opencode: an auto-loaded plugin in the plugins dir whose tool.execute.after
 *    runs the same runner and appends the findings to the tool output the model sees.
 *  - Kimi Code: a PostToolUse hook in config.toml (matcher Write|Edit). That event is
 *    observation-only there, so the auto-FIX lands (which is the point) but the leftover
 *    findings do not reach the model - unlike the other two, where they do.
 *
 * One runner (~/.enigma/hooks/lint-hook.mjs) serves opencode and Kimi: it fixes the file
 * in place and prints remaining findings to stderr, resolving the linter from the managed
 * install and no-opping cleanly until that install lands (self-healing). Claude's copy of
 * that logic is the lint step inside the merged post-edit hook, which does the same three
 * things with no second process to start.
 *
 * Node-builtins + config/util only (no agent-module imports) so it stays free of
 * cycles and cheap to load.
 */

import { kimiHome } from "./kimi";
import { isDir, isOffline, enigmaHome } from "./util";
import { applyKimiHook } from "./kimi-hooks";
import { join, dirname, basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readConfig, setEnigmaToggle } from "./config";
import { applyClaudePostEditHook } from "./post-edit-deploy";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * Managed dir where @enigmax/linter is installed on demand, and the runner beside it.
 *
 * Both hang off `enigmaHome()` rather than `homedir()`, which is what every other path in this
 * codebase reads: it honours ENIGMA_CONFIG_HOME, so a pack or an isolated account gets its own
 * copy instead of reaching into the operator's real home - and a test can point the whole
 * feature at a temp dir on any platform, which `homedir()` does not allow under every runtime.
 */
export const LINT_INSTALL_DIR = process.env.ENIGMA_LINT_DIR || join(enigmaHome(), ".enigma", "linter");
export const LINT_RUNNER_PATH = join(enigmaHome(), ".enigma", "hooks", "lint-hook.mjs");

/** True when the user has opted into auto-lint. */
export function isAutoLintOn(): boolean {
    return readConfig().config.autoLint;
}

/** Whether the managed linter install is present. */
export function isLinterInstalled(): boolean {
    return existsSync(join(LINT_INSTALL_DIR, "node_modules", "@enigmax", "linter", "package.json"));
}

/** The version of the installed linter bundle, or null when it is not installed/readable. */
export function installedLinterVersion(): string | null {
    try {
        const pkg = JSON.parse(readFileSync(join(LINT_INSTALL_DIR, "node_modules", "@enigmax", "linter", "package.json"), "utf8"));
        return typeof pkg.version === "string" ? pkg.version : null;
    } catch { return null; }
}

/**
 * Best-effort synchronous install of @enigmax/linter into the managed dir. Returns
 * true when the package is present afterwards. Never throws - a missing npm or no
 * network just leaves it uninstalled and the runner stays a no-op until next time.
 */
export function ensureLinterInstalled(): boolean {
    if (isLinterInstalled()) return true;
    try {
        mkdirSync(LINT_INSTALL_DIR, { recursive: true });
        const manifest = join(LINT_INSTALL_DIR, "package.json");
        if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: "enigma-linter-host", private: true }, null, 2)}\n`);
        // shell:true so Windows resolves npm.cmd; windowsHide so the cmd.exe it spawns never
        // flashes a console window; output suppressed to keep installs quiet. --prefer-online
        // revalidates the registry so a stale npm cache never pins an old @latest.
        spawnSync("npm", ["install", "@enigmax/linter@latest", "--no-audit", "--no-fund", "--silent", "--prefer-online"], {
            cwd: LINT_INSTALL_DIR, shell: true, stdio: "ignore", timeout: 120000, windowsHide: true,
        });
    } catch { /* best-effort */ }
    return isLinterInstalled();
}

/** Force-refresh @enigmax/linter to the latest published version (used by `enigma update`). */
export function refreshLinterPkg(): void {
    if (!isLinterInstalled()) return;
    try {
        spawnSync("npm", ["install", "@enigmax/linter@latest", "--no-audit", "--no-fund", "--silent", "--prefer-online"], {
            cwd: LINT_INSTALL_DIR, shell: true, stdio: "ignore", timeout: 120000, windowsHide: true,
        });
    } catch { /* best-effort */ }
}

/**
 * Kick off the install in a detached background process (the hidden `__lint-install`
 * command) so enabling the toggle never blocks. The runner self-heals: it no-ops
 * until the package lands. No-op when already installed.
 */
export function spawnLinterInstall(): void {
    if (isLinterInstalled() || isOffline()) return;
    try {
        // Same runtime dispatch as the update-check child: a compiled binary takes the
        // hidden command directly (every arg goes to the embedded CLI); node/bun on the
        // source entry need the entry path (argv[1]) before the command.
        const exe = basename(process.execPath).toLowerCase();
        const dev = exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe";
        const args = dev ? [process.argv[1]!, "__lint-install"] : ["__lint-install"];
        const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
        // A spawn failure surfaces as an async `error` event; with no listener the child
        // rethrows it as an uncaught exception, which this try/catch cannot intercept.
        child.on("error", () => { /* the linter install just did not start */ });
        child.unref();
    } catch { /* best-effort */ }
}

/** Write (idempotently) the shared runner script that both agents invoke. */
export function writeRunner(): void {
    mkdirSync(dirname(LINT_RUNNER_PATH), { recursive: true });
    writeFileSync(LINT_RUNNER_PATH, RUNNER_SOURCE);
}

// --- Claude Code: no entry of its own ----------------------------------------------
//
// Claude runs the lint step inside the ONE merged PostToolUse hook (post-edit-deploy.ts),
// which is why there is no applyClaudeLintHook here any more. A second entry meant a second
// process per edit - a Node start for work whose own runtime is about 160 ms - and the merged
// hook is itself answered by the npm launcher under Node, which is the only runtime that can
// resolve the managed linter at all. Toggling auto-lint therefore reconciles that group, and
// the group's legacy-marker sweep removes the old entry from an install that predates this.
//
// opencode and Kimi keep invoking the runner directly: neither has a merged hook to fold into,
// and the runner is what they were always given.

// --- opencode: auto-loaded plugin --------------------------------------------------

/** The plugin file path inside an opencode config dir (`<configDir>/plugins/enigma-lint.js`). */
function opencodePluginPath(opencodeConfigDir: string): string {
    return join(opencodeConfigDir, "plugins", "enigma-lint.js");
}

/**
 * Write (on) or remove (off) the enigma opencode lint plugin in an opencode config
 * dir's `plugins/` (auto-loaded by opencode at startup). Returns true when changed.
 */
export function applyOpencodePlugin(opencodeConfigDir: string, on: boolean): boolean {
    const path = opencodePluginPath(opencodeConfigDir);
    if (on) {
        if (existsSync(path)) return false;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, opencodePluginSource());
        return true;
    }
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
}

/** opencode plugin source: runs the shared runner after a write/edit and surfaces findings. */
function opencodePluginSource(): string {
    const runner = LINT_RUNNER_PATH.replace(/\\/g, "\\\\");
    return `// Generated by enigma (auto-lint). Do not edit; toggle with 'enigma config auto-lint off'.
import { spawnSync } from "node:child_process";

const RUNNER = "${runner}";
const FILE_TOOLS = new Set(["write", "edit", "multiedit", "patch"]);

export const EnigmaLint = async () => ({
    "tool.execute.after": async (input, output) => {
        try {
            if (!FILE_TOOLS.has(input.tool)) return;
            const file = input.args && (input.args.filePath || input.args.path);
            if (!file) return;
            const r = spawnSync("node", [RUNNER, file], { encoding: "utf8", timeout: 30000, windowsHide: true });
            const findings = (r.stderr || "").trim();
            if (findings) output.output += "\\n\\n[enigmax-lint]\\n" + findings;
        } catch { /* never break the tool on a lint failure */ }
    },
});
`;
}

// --- global apply / per-account mirror / toggle ------------------------------------

/** Global Claude settings.json for the default account. */
function claudeGlobalSettings(): string {
    return join(enigmaHome(), ".claude", "settings.json");
}

/** Global opencode config dir for the default account. */
function opencodeGlobalConfig(): string {
    return join(enigmaHome(), ".config", "opencode");
}

/** Global Kimi config.toml for the default account (kimiHome honors ENIGMA_CONFIG_HOME). */
function kimiGlobalConfig(): string {
    return join(kimiHome(), "config.toml");
}

/**
 * Add (on) or remove (off) the enigma PostToolUse lint hook in a Kimi config.toml,
 * preserving every other hook and setting. Returns true when the file changed.
 */
export function applyKimiLintHook(configPath: string, on: boolean): boolean {
    const hook = { event: "PostToolUse", matcher: "Write|Edit", command: `node "${LINT_RUNNER_PATH}"`, timeout: 30 };
    return applyKimiHook(configPath, "lint-hook.mjs", hook, on) === "changed";
}

/**
 * Re-assert the global wiring to match the current toggle: write the runner and add
 * or remove the Claude hook and opencode plugin. Called on install and on toggle.
 * On enable it also ensures the linter is installed (background, non-blocking).
 */
export function applyLintWiring(): void {
    const on = isAutoLintOn();
    if (on) { writeRunner(); spawnLinterInstall(); }
    // Claude's lint step lives in the merged post-edit entry, so what a toggle changes there is
    // that group's presence - and turning auto-lint OFF must not delete an entry trim, guardrails
    // or the graph are still using, which is what reconciling it (rather than removing it) gets
    // right.
    applyClaudePostEditHook(claudeGlobalSettings());
    applyOpencodePlugin(opencodeGlobalConfig(), on);
    applyKimiLintHook(kimiGlobalConfig(), on);
}

/**
 * Mirror the lint wiring into a managed account's config dir, matching the global
 * toggle (presence AND absence), so `enigma <tool> <account>` behaves like default.
 * Mirrors only the tools that have a per-account config surface.
 */
export function mirrorLintWiring(toolName: string, accountDir: string): void {
    const on = isAutoLintOn();
    if (on) writeRunner();
    if (toolName === "claude") applyClaudePostEditHook(join(accountDir, "settings.json"));
    else if (toolName === "opencode") applyOpencodePlugin(join(accountDir, "xdg-config", "opencode"), on);
    else if (toolName === "kimi") applyKimiLintHook(join(accountDir, "config.toml"), on);
}

/**
 * Set the autoLint toggle and apply the global wiring. Enabling writes the runner,
 * adds the hooks, and starts the background install; disabling removes the hooks.
 * Returns the .enigma.json path written.
 */
export function setAutoLint(scope: "global" | "local", on: boolean): string {
    const path = setEnigmaToggle("autoLint", on, scope);
    applyLintWiring();
    return path;
}

/** Remove the runner and managed install entirely (used by an explicit cleanup, not the toggle). */
export function purgeLint(): void {
    if (isDir(LINT_INSTALL_DIR)) rmSync(LINT_INSTALL_DIR, { recursive: true, force: true });
    if (existsSync(LINT_RUNNER_PATH)) rmSync(LINT_RUNNER_PATH, { force: true });
}

// --- the shared runner source ------------------------------------------------------

const RUNNER_SOURCE = `#!/usr/bin/env node
// Generated by enigma (auto-lint). Fixes the edited file in place and prints any
// unfixable findings to stderr. Invoked two ways: a file path as argv[2] (opencode
// plugin) or a Claude PostToolUse JSON payload on stdin (tool_input.file_path).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const LINT_DIR = process.env.ENIGMA_LINT_DIR || join(homedir(), ".enigma", "linter");
const LINTABLE = /\\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rs|prisma|ipynb|astro|vue|svelte)$/i;
const MAX = 20;

let linter;
try { linter = createRequire(join(LINT_DIR, "noop.js"))("@enigmax/linter"); }
catch { process.exit(0); } // not installed yet -> no-op (self-heals once installed)

let file = process.argv[2];
if (!file) {
    try { file = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.file_path; } catch { /* no stdin */ }
}
if (!file || !LINTABLE.test(file)) process.exit(0);

let text;
try { text = readFileSync(file, "utf8"); } catch { process.exit(0); }

const fixed = linter.fixText(file, text);
if (fixed !== text) { try { writeFileSync(file, fixed); text = fixed; } catch { /* read-only */ } }

const violations = linter.lintText(file, text);
if (!violations.length) process.exit(0); // clean -> no output -> 0 tokens

const shown = violations.slice(0, MAX).map((v) =>
    v.line + ":" + v.column + " " + (v.severity === "error" ? "error" : "warn") + " " + v.rule + " - " + v.message);
if (violations.length > MAX) shown.push("...and " + (violations.length - MAX) + " more");
process.stderr.write("enigmax-lint " + file + "\\n" + shown.join("\\n") + "\\n");
process.exit(2);
`;
