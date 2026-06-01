/**
 * enigma CLI: argument parsing, the interactive top-level menu, and command
 * dispatch. Features are modular and opt-in - the menu lets the user enable or
 * disable each one. Subcommands run a single feature non-interactively.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { readJson } from "./util";
import { installSkills, sealSources, checkSources } from "./skills";
import type { InstallOptions } from "./skills";
import { setupGitHooks } from "./security";
import { runGuardCli } from "./guard";
import { runConfigCli } from "./settings";
import { notifyUpdate } from "./update";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = readJson<{ version?: string }>(join(__dirname, "..", "package.json")) || {};

type Command = "install" | "security" | "guard" | "seal" | "check" | "config" | "help" | "version";
const COMMANDS = new Set<string>(["install", "security", "guard", "seal", "check", "config", "help", "version"]);

interface CliOptions extends InstallOptions {
    command: Command | null;
    positionals: string[];
    all: boolean;
    yes: boolean;
    help: boolean;
    version: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        command: null, positionals: [],
        scope: null, agents: [], allAgents: false, skills: [],
        skillsOnly: false, memoryOnly: false, prune: true, keepModified: false,
        bypass: null, noBypass: false,
        force: false, all: false, yes: false, dryRun: false, help: false, version: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = (): string => argv[++i]!;
        if (i === 0 && COMMANDS.has(a)) { opts.command = a as Command; continue; }
        switch (a) {
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
            case "--force": opts.force = true; break;
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
  install              Install/update agent skills (Claude Code, Codex, opencode)
  security             Set up git security hooks in the current repo
  guard [--all]        Run the commit guard (staged files, or --all for every tracked file)
  config [key val]     Configure settings: no args opens the interactive menu;
                       'config <key> <on|off> [-g|-l]' sets one (e.g. config claude-attribution on)
  seal                 Maintenance: (re)compute skill content hashes
  check                Integrity gate: verify skills are well-formed and sealed
  help, version

Config keys: commit-emoji, update-notifier, claude-attribution,
             bypass-claude, bypass-codex, bypass-opencode

Install options:
  -g, --global         Install at user level
  -l, --local          Install into the current project
  -a, --agent <name>   Target agent(s) (default: auto-detect installed)
  -s, --skill <name>   Skill(s) to install (default: all)
      --all            Target every supported agent, ignoring detection
      --skills-only    Only skill folders   --memory-only  Only memory files
      --no-prune       Keep orphaned skills  --keep-modified  Don't overwrite local edits
      --bypass <names> Disable approval prompts for agents (claude,codex,opencode | all | none)
      --no-bypass      Never configure permission bypass (skip the prompt)
      --dry-run        Show the plan without writing

Security options:
      --force          Override an existing core.hooksPath

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
`);
}

export async function run(argv: string[]): Promise<void> {
    const opts = parseArgs(argv);
    const interactive = Boolean(process.stdout.isTTY) && !opts.yes;
    const version = PKG.version || "0.0.0";
    if (opts.help || opts.command === "help") { printHelp(); await notifyUpdate(version, interactive); return; }
    if (opts.version || opts.command === "version") { console.log(version); await notifyUpdate(version, interactive); return; }

    // Direct (non-menu) maintenance and feature commands. Machine/CI commands
    // (seal, check, guard, config) skip the update notice to keep their output clean.
    if (opts.command === "seal") return sealSources();
    if (opts.command === "check") return checkSources();
    if (opts.command === "guard") { process.exit(runGuardCli(opts.all)); }
    if (opts.command === "config") { process.exit(await runConfigCli(opts.positionals, opts.scope, interactive)); }

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

    // Full-screen home TUI. Install/security drop to their clack wizards (run
    // outside the alt screen) and the menu reopens afterwards.
    const { runHomeTui } = await import("./tui/settings");
    await runHomeTui(async (action) => {
        if (action === "skills") {
            p.intro("enigma - install agent skills");
            await installSkills(opts, interactive);
            p.outro("Done.");
        } else if (action === "security") {
            p.intro("enigma - git security hooks");
            const done = await setupGitHooks(opts, interactive);
            p.outro(done ? "Git hooks configured." : "No changes made.");
        }
    });
    await notifyUpdate(version, interactive);
}
