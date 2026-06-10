/**
 * Auto-lint integration. When the `autoLint` toggle is on, enigma autonomously
 * installs @enigmax/linter into a managed dir and wires a post-write hook into each
 * agent so edits are auto-fixed (safe formatting) and only the unfixable findings
 * are surfaced back to the agent - with the least possible token cost (silence on a
 * clean file). Default OFF: this changes agent behavior and installs a package, so
 * it is an explicit opt-in.
 *
 * Wiring per agent:
 *  - Claude Code: a PostToolUse hook in settings.json (matcher Edit|Write|MultiEdit|
 *    NotebookEdit) that runs the shared runner; on unfixable findings the runner
 *    exits 2 with a compact stderr, which Claude feeds to the model.
 *  - opencode: an auto-loaded plugin in the plugins dir whose tool.execute.after
 *    runs the same runner and appends the findings to the tool output the model sees.
 *
 * One runner (~/.enigma/hooks/lint-hook.mjs) serves both: it fixes the file in place
 * and prints remaining findings to stderr. It resolves the linter from the managed
 * install and no-ops cleanly until that install lands (self-healing).
 *
 * Node-builtins + config/util only (no agent-module imports) so it stays free of
 * cycles and cheap to load.
 */

import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { isDir, readJson } from "./util";
import { readConfig, setEnigmaToggle } from "./config";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

/** Managed dir where @enigmax/linter is installed on demand. */
export const LINT_INSTALL_DIR = process.env.ENIGMA_LINT_DIR || join(homedir(), ".enigma", "linter");
/** The shared post-write runner both agents invoke. */
export const LINT_RUNNER_PATH = join(homedir(), ".enigma", "hooks", "lint-hook.mjs");

/** True when the user has opted into auto-lint. */
export function isAutoLintOn(): boolean {
    return readConfig().config.autoLint;
}

/** Whether the managed linter install is present. */
export function isLinterInstalled(): boolean {
    return existsSync(join(LINT_INSTALL_DIR, "node_modules", "@enigmax", "linter", "package.json"));
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
        if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "enigma-linter-host", private: true }, null, 2) + "\n");
        // shell:true so Windows resolves npm.cmd; output suppressed to keep installs quiet.
        spawnSync("npm", ["install", "@enigmax/linter@latest", "--no-audit", "--no-fund", "--silent"], {
            cwd: LINT_INSTALL_DIR, shell: true, stdio: "ignore", timeout: 120000,
        });
    } catch { /* best-effort */ }
    return isLinterInstalled();
}

/**
 * Kick off the install in a detached background process (the hidden `__lint-install`
 * command) so enabling the toggle never blocks. The runner self-heals: it no-ops
 * until the package lands. No-op when already installed.
 */
export function spawnLinterInstall(): void {
    if (isLinterInstalled()) return;
    try {
        // Same runtime dispatch as the update-check child: a compiled binary takes the
        // hidden command directly (every arg goes to the embedded CLI); node/bun on the
        // source entry need the entry path (argv[1]) before the command.
        const exe = basename(process.execPath).toLowerCase();
        const dev = exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe";
        const args = dev ? [process.argv[1]!, "__lint-install"] : ["__lint-install"];
        const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
    } catch { /* best-effort */ }
}

/** Write (idempotently) the shared runner script that both agents invoke. */
export function writeRunner(): void {
    mkdirSync(dirname(LINT_RUNNER_PATH), { recursive: true });
    writeFileSync(LINT_RUNNER_PATH, RUNNER_SOURCE);
}

// --- Claude Code: PostToolUse hook in settings.json --------------------------------

const HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
/** The hook command both identifies our entry and runs the runner. */
function hookCommand(): string {
    return `node "${LINT_RUNNER_PATH}"`;
}

interface HookGroup { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }>; }

/** Whether a PostToolUse group is the enigma lint hook (identified by the runner path). */
function isOurGroup(group: HookGroup): boolean {
    return Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === "string" && h.command.includes("lint-hook.mjs"));
}

/**
 * Add (on) or remove (off) the enigma PostToolUse lint hook in a Claude settings.json,
 * preserving every other hook and setting. Identified by the runner path so it is
 * idempotent and never clobbers the user's own hooks. Returns true when the file changed.
 */
export function applyClaudeLintHook(settingsPath: string, on: boolean): boolean {
    const current = readJson<Record<string, unknown>>(settingsPath) || {};
    const hooks = (typeof current.hooks === "object" && current.hooks !== null) ? { ...current.hooks as Record<string, unknown> } : {};
    const post: HookGroup[] = Array.isArray(hooks.PostToolUse) ? [...hooks.PostToolUse as HookGroup[]] : [];

    const rest = post.filter((g) => !isOurGroup(g));
    const next: HookGroup[] = on
        ? [...rest, { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: hookCommand(), timeout: 30 }] }]
        : rest;

    if (next.length) hooks.PostToolUse = next; else delete hooks.PostToolUse;
    const nextSettings: Record<string, unknown> = { ...current };
    if (Object.keys(hooks).length) nextSettings.hooks = hooks; else delete nextSettings.hooks;

    if (JSON.stringify(nextSettings) === JSON.stringify(current)) return false;
    if (!existsSync(settingsPath) && Object.keys(nextSettings).length === 0) return false;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + "\n");
    return true;
}

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
            const r = spawnSync("node", [RUNNER, file], { encoding: "utf8", timeout: 30000 });
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
    return join(homedir(), ".claude", "settings.json");
}

/** Global opencode config dir for the default account. */
function opencodeGlobalConfig(): string {
    return join(homedir(), ".config", "opencode");
}

/**
 * Re-assert the global wiring to match the current toggle: write the runner and add
 * or remove the Claude hook and opencode plugin. Called on install and on toggle.
 * On enable it also ensures the linter is installed (background, non-blocking).
 */
export function applyLintWiring(): void {
    const on = isAutoLintOn();
    if (on) { writeRunner(); spawnLinterInstall(); }
    applyClaudeLintHook(claudeGlobalSettings(), on);
    applyOpencodePlugin(opencodeGlobalConfig(), on);
}

/**
 * Mirror the lint wiring into a managed account's config dir, matching the global
 * toggle (presence AND absence), so `enigma <tool> <account>` behaves like default.
 * Mirrors only the tools that have a per-account config surface.
 */
export function mirrorLintWiring(toolName: string, accountDir: string): void {
    const on = isAutoLintOn();
    if (on) writeRunner();
    if (toolName === "claude") applyClaudeLintHook(join(accountDir, "settings.json"), on);
    else if (toolName === "opencode") applyOpencodePlugin(join(accountDir, "xdg-config", "opencode"), on);
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
