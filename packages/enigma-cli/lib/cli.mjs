/**
 * enigma CLI: argument parsing, the interactive top-level menu, and command
 * dispatch. Features are modular and opt-in - the menu lets the user enable or
 * disable each one. Subcommands run a single feature non-interactively.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { readJson } from "./util.mjs";
import { installSkills, sealSources, checkSources } from "./skills.mjs";
import { setupGitHooks } from "./security.mjs";
import { runGuardCli } from "./guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = readJson(join(__dirname, "..", "package.json")) || {};

const COMMANDS = new Set(["install", "security", "guard", "seal", "check", "help", "version"]);

function parseArgs(argv) {
  const opts = {
    command: null,
    scope: null, agents: [], allAgents: false, skills: [],
    skillsOnly: false, memoryOnly: false, prune: true, keepModified: false,
    force: false, all: false, yes: false, dryRun: false, help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (i === 0 && COMMANDS.has(a)) { opts.command = a; continue; }
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
      case "--force": opts.force = true; break;
      case "-y": case "--yes": opts.yes = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(1); }
        else { console.error(`Unknown command: ${a}`); process.exit(1); }
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
enigma - everything you need to work with a coding agent

Usage:
  enigma [command] [options]

Commands:
  (none)               Interactive menu: pick which features to set up
  install              Install/update agent skills (Claude Code, Codex, opencode)
  security             Set up git security hooks in the current repo
  guard [--all]        Run the commit guard (staged files, or --all for every tracked file)
  seal                 Maintenance: (re)compute skill content hashes
  check                Integrity gate: verify skills are well-formed and sealed
  help, version

Install options:
  -g, --global         Install at user level
  -l, --local          Install into the current project
  -a, --agent <name>   Target agent(s) (default: auto-detect installed)
  -s, --skill <name>   Skill(s) to install (default: all)
      --all            Target every supported agent, ignoring detection
      --skills-only    Only skill folders   --memory-only  Only memory files
      --no-prune       Keep orphaned skills  --keep-modified  Don't overwrite local edits
      --dry-run        Show the plan without writing

Security options:
      --force          Override an existing core.hooksPath

Global:
  -y, --yes            Non-interactive   -h, --help   -v, --version

Examples:
  enigma                              # interactive
  enigma install --global             # skills for detected agents, user level
  enigma install --all -y            # every supported agent, non-interactive
  enigma security                    # configure git hooks (choose protections)
`);
}

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts.command === "help") { printHelp(); return; }
  if (opts.version || opts.command === "version") { console.log(PKG.version || "0.0.0"); return; }

  // Direct (non-menu) maintenance and feature commands.
  if (opts.command === "seal") return sealSources();
  if (opts.command === "check") return checkSources();
  if (opts.command === "guard") { process.exit(runGuardCli(opts.all)); }

  const interactive = process.stdout.isTTY && !opts.yes;

  if (opts.command === "install") {
    p.intro("enigma - install agent skills");
    await installSkills(opts, interactive);
    p.outro("Done.");
    return;
  }
  if (opts.command === "security") {
    p.intro("enigma - git security hooks");
    const done = await setupGitHooks(opts, interactive);
    p.outro(done ? "Git hooks configured." : "No changes made.");
    return;
  }

  // No command: interactive feature menu (or sensible default with --yes).
  p.intro("enigma");
  let features;
  if (interactive) {
    const r = await p.multiselect({
      message: "What do you want to set up?",
      options: [
        { value: "skills", label: "Agent skills", hint: "Claude Code, Codex, opencode" },
        { value: "security", label: "Git security hooks", hint: "block secrets, .env, node_modules on commit" },
      ],
      initialValues: ["skills"],
      required: true,
    });
    if (p.isCancel(r)) { p.cancel("Aborted."); return; }
    features = r;
  } else {
    features = ["skills"]; // non-interactive default
  }

  if (features.includes("skills")) await installSkills(opts, interactive);
  if (features.includes("security")) await setupGitHooks(opts, interactive);
  p.outro("Done.");
}
