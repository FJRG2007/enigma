/**
 * enigma CLI: argument parsing, the interactive top-level menu, and command
 * dispatch. Features are modular and opt-in - the menu lets the user enable or
 * disable each one. Subcommands run a single feature non-interactively.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { readJson } from "./util";
import { collectReporter } from "./reporter";
import { installSkills, sealSources, checkSources } from "./skills";
import type { InstallOptions } from "./skills";
import { setupGitHooks, GUARD_PROTECTIONS } from "./security";
import { discoverAgents } from "./agents";
import { runGuardCli } from "./guard";
import { runConfigCli } from "./settings";
import { readConfig } from "./config";
import { getAvailableUpdate, notifyUpdate, runUpdate } from "./update";
import {
    DEFAULT_NAME, DEFAULT_TOOL, TOOL_NAMES, addAccount, getActive, getTool,
    isToolName, launchTool, listAccounts, loginTool, removeAccount, setActive,
} from "./accounts";
import type { HubAccount, HubExitAction } from "./tui/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In the compiled binary __dirname lives in Bun's virtual fs (no package.json on
// disk); the launcher passes ENIGMA_VERSION. Reading package.json stays as the
// dev/tsx fallback.
const PKG = readJson<{ version?: string }>(join(__dirname, "..", "package.json")) || {};

// Fixed commands plus one launch command per supported tool (e.g. `enigma claude`).
const COMMANDS = new Set<string>([
    "install", "security", "guard", "seal", "check", "config", "account", "accounts", "statusline", "help", "version",
    ...TOOL_NAMES,
]);

interface CliOptions extends InstallOptions {
    command: string | null;
    positionals: string[];
    /** Args after a literal `--`, forwarded verbatim to the launched agent. */
    passthrough: string[];
    /** Target tool for account/launch commands (default: claude). */
    tool: string;
    all: boolean;
    yes: boolean;
    login: boolean;
    help: boolean;
    version: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        command: null, positionals: [], passthrough: [], tool: DEFAULT_TOOL,
        scope: null, agents: [], allAgents: false, skills: [],
        skillsOnly: false, memoryOnly: false, prune: true, keepModified: false,
        bypass: null, noBypass: false, outputStyle: null,
        force: false, all: false, yes: false, login: false, dryRun: false, help: false, version: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = (): string => argv[++i]!;
        if (i === 0 && COMMANDS.has(a)) { opts.command = a === "accounts" ? "account" : a; continue; }
        // Everything after a literal `--` is forwarded verbatim (e.g. to Claude Code).
        if (a === "--") { opts.passthrough.push(...argv.slice(i + 1)); break; }
        switch (a) {
            case "-t": case "--tool": opts.tool = next(); break;
            case "-g": case "--global": opts.scope = "global"; break;
            case "-l": case "--local": opts.scope = "local"; break;
            case "-a": case "--agent": opts.agents.push(...next().split(",")); break;
            case "-s": case "--skill": opts.skills.push(...next().split(",")); break;
            case "--all": opts.allAgents = true; opts.all = true; break;
            case "--skills-only": opts.skillsOnly = true; break;
            case "--memory-only": opts.memoryOnly = true; break;
            case "--no-prune": opts.prune = false; break;
            case "--keep-modified": opts.keepModified = true; break;
            case "--bypass": opts.bypass = (opts.bypass || []).concat(next().split(",")); break;
            case "--no-bypass": opts.noBypass = true; break;
            case "--output-style": opts.outputStyle = next(); break;
            case "--force": opts.force = true; break;
            case "--login": opts.login = true; break;
            case "-y": case "--yes": opts.yes = true; break;
            case "--dry-run": opts.dryRun = true; break;
            case "-h": case "--help": opts.help = true; break;
            case "-v": case "--version": opts.version = true; break;
            default:
                if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(1); }
                else if (opts.command) { opts.positionals.push(a); }
                else { console.error(`Unknown command: ${a}`); process.exit(1); }
        }
    }
    return opts;
}

function printHelp(): void {
    console.log(`
enigma - everything you need to work with a coding agent

Usage:
  enigma [command] [options]

Commands:
  (none)               Interactive hub: configure settings or set up features
  install              Install/update agent skills (Claude Code, Codex, OpenCode)
  security             Set up git security hooks in the current repo
  guard [--all]        Run the commit guard (staged files, or --all for every tracked file)
  config [key val]     Configure settings: no args opens the interactive menu;
                       'config <key> <on|off> [-g|-l]' sets one (e.g. config claude-attribution on)
  claude [account]     Launch Claude Code using an account's config (active if omitted);
                       pass args to Claude after '--' (e.g. claude work -- --version)
  account <subcommand> Manage tool accounts (multi-login without logging out).
                       Defaults to Claude Code; target another tool with --tool <name>:
                         list                 List accounts (active one marked)
                         add <name> [--login] Create an account (then optionally log in)
                         use <name>           Set the active account
                         login|run <name>     Launch the tool with that account
                         remove <name>        Delete an account (-y to skip confirm)
  seal                 Maintenance: (re)compute skill content hashes
  check                Integrity gate: verify skills are well-formed and sealed
  statusline           Print the [ENIGMA] badge for an agent status bar (shows the active level)
  help, version

Config keys: commit-emoji, update-notifier, fullscreen, parallel-subagents,
             output-style (off|lite|full|ultra), claude-attribution,
             permission-bypass, bypass-claude, bypass-codex, bypass-opencode

Install options:
  -g, --global         Install at user level
  -l, --local          Install into the current project
  -a, --agent <name>   Target agent(s) (default: auto-detect installed)
  -s, --skill <name>   Skill(s) to install (default: all)
      --all            Target every supported agent, ignoring detection
      --skills-only    Only skill folders   --memory-only  Only memory files
      --no-prune       Keep orphaned skills  --keep-modified  Don't overwrite local edits
      --bypass <names> Force approval-prompt bypass (claude,codex,opencode | all | none)
      --no-bypass      Skip permission bypass for this run (on by default)
      --output-style <off|lite|full|ultra>  Token-efficient output level (asked if omitted)
      --dry-run        Show the plan without writing

Security options:
      --force          Override an existing core.hooksPath

Account options:
  -t, --tool <name>    Target tool for account/launch commands (default: claude)

Global:
  -y, --yes            Non-interactive   -h, --help   -v, --version

Examples:
  enigma                              # interactive
  enigma install --global             # skills for detected agents, user level
  enigma install --all -y             # every supported agent, non-interactive
  enigma install -y --bypass claude,codex  # also disable approval prompts (unattended)
  enigma security                     # configure git hooks (choose protections)
  enigma config                       # show effective runtime config
  enigma config commit-emoji off      # opt out of commit-message emojis (global)
  enigma account add work --login     # create a 'work' account and log into it
  enigma claude work                  # run Claude Code as the 'work' account
  enigma account use personal         # make 'personal' the default account
`);
}

/**
 * `enigma account <subcommand>` surface. Wraps the accounts data layer with
 * prompting/printing (the data layer stays UI-free). Returns a process exit code.
 */
async function runAccountCli(opts: CliOptions, interactive: boolean): Promise<number> {
    const [sub, name] = opts.positionals;
    const tool = opts.tool;
    if (!isToolName(tool)) { console.error(`Unknown tool '${tool}'. Known tools: ${TOOL_NAMES.join(", ")}.`); return 1; }
    const spec = getTool(tool);

    switch (sub) {
        case undefined:
        case "list":
        case "ls": {
            const accounts = listAccounts(tool);
            console.log(`${spec.label} accounts:\n`);
            for (const a of accounts) {
                const marker = a.active ? "*" : " ";
                const email = a.email ?? "(not logged in)";
                const meta = a.name === DEFAULT_NAME ? "(existing config)" : a.lastUsed ? `last used ${a.lastUsed}` : "never used";
                console.log(` ${marker} ${a.name.padEnd(14)} ${email.padEnd(30)} ${meta}`);
                console.log(`     ${a.dir}`);
            }
            console.log(`\nActive: ${getActive(tool)}. Launch with: enigma ${tool} [account].`);
            return 0;
        }
        case "add": {
            if (!name) { console.error(`Usage: enigma account add <name> [--login] [--tool ${tool}]`); return 1; }
            try {
                const account = addAccount(tool, name);
                console.log(`Account '${account.name}' ready at ${account.dir}.`);
                if (opts.login) return loginTool(tool, account.name);
                console.log(`Log in with: enigma account login ${account.name}${tool === DEFAULT_TOOL ? "" : ` --tool ${tool}`}.`);
                return 0;
            } catch (err) { console.error((err as Error).message); return 1; }
        }
        case "use":
        case "switch": {
            if (!name) { console.error("Usage: enigma account use <name>"); return 1; }
            try { setActive(tool, name); console.log(`Active ${tool} account is now '${name}'.`); return 0; }
            catch (err) { console.error((err as Error).message); return 1; }
        }
        case "login": {
            if (!name) { console.error("Usage: enigma account login <name>"); return 1; }
            try { return await loginTool(tool, name); }
            catch (err) { console.error((err as Error).message); return 1; }
        }
        case "run": {
            if (!name) { console.error("Usage: enigma account run <name>"); return 1; }
            try { return await launchTool(tool, name, opts.passthrough); }
            catch (err) { console.error((err as Error).message); return 1; }
        }
        case "remove":
        case "rm": {
            if (!name) { console.error("Usage: enigma account remove <name>"); return 1; }
            if (!opts.yes) {
                if (!interactive) { console.error(`Refusing to remove '${name}' without confirmation. Re-run with -y.`); return 1; }
                const ok = await p.confirm({ message: `Remove ${tool} account '${name}' and delete its config directory?` });
                if (p.isCancel(ok) || !ok) { console.log("Aborted."); return 0; }
            }
            try { removeAccount(tool, name); console.log(`Removed ${tool} account '${name}'.`); return 0; }
            catch (err) { console.error((err as Error).message); return 1; }
        }
        default:
            console.error(`Unknown account subcommand: ${sub}. Try: list, add, use, login, run, remove.`);
            return 1;
    }
}

/**
 * Print the [ENIGMA] status badge for an agent status bar (e.g. Claude Code's
 * statusLine). Always shows `[ENIGMA]`; when token-efficient output is active it
 * appends the level, e.g. `[ENIGMA:FULL]` / `[ENIGMA:ULTRA]`. Cyan unless NO_COLOR.
 * Never throws or prints noise - a status bar must stay quiet.
 */
function printStatusline(): void {
    try {
        const style = readConfig().config.outputStyle;
        const label = (!style || style === "off") ? "ENIGMA" : `ENIGMA:${style.toUpperCase()}`;
        process.stdout.write(process.env.NO_COLOR ? `[${label}]` : `\x1b[36m[${label}]\x1b[0m`);
    } catch {
        // A status bar command must never error or emit noise.
    }
}

export async function run(argv: string[]): Promise<void> {
    const opts = parseArgs(argv);
    const interactive = Boolean(process.stdout.isTTY) && !opts.yes;
    const version = process.env.ENIGMA_VERSION || PKG.version || "0.0.0";
    // Statusline: fast, silent badge for an agent's status bar (e.g. Claude Code). No
    // update notice or other output. The Node launcher also short-circuits this before
    // spawning the binary, so it stays cheap on every status refresh.
    if (opts.command === "statusline") { printStatusline(); return; }
    if (opts.help || opts.command === "help") { printHelp(); await notifyUpdate(version, interactive); return; }
    if (opts.version || opts.command === "version") { console.log(version); await notifyUpdate(version, interactive); return; }

    // Direct (non-menu) maintenance and feature commands. Machine/CI commands
    // (seal, check, guard, config) skip the update notice to keep their output clean.
    if (opts.command === "seal") return sealSources();
    if (opts.command === "check") return checkSources();
    if (opts.command === "guard") { process.exit(runGuardCli(opts.all)); }
    if (opts.command === "config") { process.exit(await runConfigCli(opts.positionals, opts.scope, interactive)); }
    if (opts.command && isToolName(opts.command)) { process.exit(await launchTool(opts.command, opts.positionals[0] ?? null, opts.passthrough)); }
    if (opts.command === "account") { process.exit(await runAccountCli(opts, interactive)); }

    if (opts.command === "install") {
        p.intro("enigma - install agent skills");
        await installSkills(opts, interactive);
        p.outro("Done.");
        await notifyUpdate(version, interactive);
        return;
    }
    if (opts.command === "security") {
        p.intro("enigma - git security hooks");
        const done = await setupGitHooks(opts, interactive);
        p.outro(done ? "Git hooks configured." : "No changes made.");
        await notifyUpdate(version, interactive);
        return;
    }

    // No command: non-interactive default installs skills; a TTY gets the hub.
    if (!interactive) {
        await installSkills(opts, interactive);
        await notifyUpdate(version, interactive);
        return;
    }

    // Full-screen hub TUI. Install/security are chosen AND executed inline in the
    // TUI: the action writes through a buffering reporter (no stdout, which would
    // corrupt the live render) and the outcome is shown in a native result panel.
    // Direct `enigma install` / `enigma security` still use the clack wizards above.
    // Imported dynamically so non-TUI commands never load the native OpenTUI core.
    const { runHomeTui } = await import("./tui/opentui");
    // Account rows for every supported tool, mapped to the renderer-neutral shape;
    // each tool's "default" (its existing config dir) is not removable.
    const hubAccounts = (): HubAccount[] =>
        TOOL_NAMES.flatMap((tool) =>
            listAccounts(tool).map((a) => ({
                tool, toolLabel: a.toolLabel, name: a.name, dir: a.dir,
                email: a.email, active: a.active, removable: a.name !== DEFAULT_NAME,
            })));
    const buildCtx = () => ({
        agents: discoverAgents().map((a) => ({ name: a.name, label: a.label, installed: a.installed })),
        protections: GUARD_PROTECTIONS,
        update: getAvailableUpdate(version) ?? undefined,
        accounts: hubAccounts(),
        activateAccount: (tool: string, name: string) => { setActive(tool, name); return hubAccounts(); },
        removeAccount: (tool: string, name: string) => { removeAccount(tool, name); return hubAccounts(); },
        addAccount: (tool: string, name: string) => {
            try { addAccount(tool, name); return { ok: true, accounts: hubAccounts() }; }
            catch (err) { return { ok: false, error: (err as Error).message, accounts: hubAccounts() }; }
        },
        runAction: async (req: { action: "skills" | "security"; scope?: "global" | "local"; agents?: string[]; protections?: string[] }) => {
            const reporter = collectReporter();
            const title = req.action === "skills" ? "Install agent skills" : "Git security hooks";
            try {
                if (req.action === "skills") {
                    await installSkills({ ...opts, scope: req.scope ?? opts.scope, agents: req.agents ?? [], allAgents: !(req.agents && req.agents.length) }, false, reporter);
                    return { ok: true, title, lines: reporter.lines };
                }
                const done = await setupGitHooks({ ...opts, protections: req.protections, force: true }, false, reporter);
                return { ok: done, title, lines: reporter.lines };
            } catch (err) {
                reporter.error(`Error: ${(err as Error).message}`);
                return { ok: false, title, lines: reporter.lines };
            }
        },
    });

    // Connecting an account must run the tool's own login flow, which needs the
    // terminal the TUI owns; so the hub closes, we run the login here, then reopen.
    let action: HubExitAction | null = await runHomeTui(buildCtx());
    while (action?.type === "connect") {
        await loginTool(action.tool, action.account);
        action = await runHomeTui(buildCtx());
    }
    // "Update now" from the hub: run npm in the freed terminal (the running binary is
    // about to be replaced, so do not reopen the hub).
    if (action?.type === "update") { runUpdate(); return; }
    await notifyUpdate(version, interactive);
}
