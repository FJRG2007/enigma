/**
 * enigma CLI: argument parsing, the interactive top-level menu, and command
 * dispatch. Features are modular and opt-in - the menu lets the user enable or
 * disable each one. Subcommands run a single feature non-interactively.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { readJson } from "./util";
import { compress, retrieve, readStats, clearCcr } from "./compress";
import type { ContentType } from "./compress";
import { collectReporter } from "./reporter";
import {
    checkSources, discardSkill, hasAccountDeployment, hasDeployment, installSkills,
    listSkillsStatus, refreshSkillsFromGitHub, sealSources, shouldCheckRemote,
    syncAccount, syncDeployed,
} from "./skills";
import type { InstallOptions } from "./skills";
import { setupGitHooks, GUARD_PROTECTIONS } from "./security";
import { discoverAgents } from "./agents";
import { runGuardCli } from "./guard";
import { runConfigCli } from "./settings";
import { ensureLinterInstalled } from "./lint";
import { ensureDashboardCurrent, isDashboardPkgCurrent, isDashboardPkgInstalled, refreshDashboardPkg } from "./dashboard-pkg";
import { readConfig } from "./config";
import { checkLatestNow, getAvailableUpdate, notifyUpdate, performUpdateCheck, runUpdate } from "./update";
import { buildIssueUrl, openUrl } from "./issue";
import type { IssueKind } from "./issue";
import { dashboardUrl, ensureHostsEntry, runningDaemon, serveDashboardDaemon, startDashboardServer } from "./dashboard";
import {
    DEFAULT_NAME, DEFAULT_TOOL, TOOL_NAMES, addAccount, addProfile, getActive, getTool,
    isToolName, launchTool, listAccounts, listProfiles, loginTool, removeAccount,
    removeProfile, renameAccount, renameProfile, resolveConfigDir, resolveLaunchAccount,
    setActive, setActiveProfile, setProfileAccount, unsetProfileAccount,
} from "./accounts";
import type { HubAccount, HubExitAction, HubProfile, HubSkill } from "./tui/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In the compiled binary __dirname lives in Bun's virtual fs (no package.json on
// disk); the launcher passes ENIGMA_VERSION. Reading package.json stays as the
// dev/tsx fallback.
const PKG = readJson<{ version?: string }>(join(__dirname, "..", "package.json")) || {};

// Fixed commands plus one launch command per supported tool (e.g. `enigma claude`).
const COMMANDS = new Set<string>([
    "install", "update", "security", "guard", "seal", "check", "config", "account", "accounts",
    "profile", "profiles", "skill", "skills", "issue", "improve", "compress", "mcp", "dashboard", "dash", "statusline", "help", "version",
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
    /** `compress`: print cumulative savings instead of compressing. */
    stats: boolean;
    /** `compress`: retrieve the original behind a CCR hash instead of compressing. */
    retrieve: string | null;
    /** `compress`: force a content type instead of auto-detecting. */
    compressType: string | null;
    /** `compress`: delete all CCR data (stats, history, cache) and reset the dashboard. */
    clear: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        command: null, positionals: [], passthrough: [], tool: DEFAULT_TOOL,
        scope: null, agents: [], allAgents: false, skills: [],
        skillsOnly: false, memoryOnly: false, prune: true, keepModified: false,
        bypass: null, noBypass: false, outputStyle: null, minimalCode: null, dashboard: null,
        force: false, all: false, yes: false, login: false, dryRun: false, help: false, version: false,
        stats: false, retrieve: null, compressType: null, clear: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = (): string => argv[++i]!;
        if (i === 0 && COMMANDS.has(a)) {
            opts.command = a === "accounts" ? "account" : a === "profiles" ? "profile" : a === "skill" ? "skills" : a === "dash" ? "dashboard" : a;
            continue;
        }
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
            case "--minimal-code": opts.minimalCode = next(); break;
            case "--dashboard": opts.dashboard = next(); break;
            case "--stats": opts.stats = true; break;
            case "--retrieve": opts.retrieve = next(); break;
            case "--type": opts.compressType = next(); break;
            case "--clear": opts.clear = true; break;
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
  update               Fetch the latest skills from GitHub (no package release
                       needed), sync deployments, and self-update enigma-cli
  security             Set up git security hooks in the current repo
  guard [--all]        Run the commit guard (staged files, or --all for every tracked file)
  config [key val]     Configure settings: no args opens the interactive menu;
                       'config <key> <on|off> [-g|-l]' sets one (e.g. config claude-attribution on)
  <tool> [account]     Launch a tool (claude | codex | opencode) with an account's
                       config (resolution: explicit > active profile > tool active);
                       auto-syncs deployed skills first (see auto-sync config key) and
                       keeps managed accounts stocked with skills, memory and the
                       mirrored settings (bypass, attribution) of the default account;
                       pass args to the tool after '--' (e.g. claude work -- --version)
  account <subcommand> Manage tool accounts (multi-login without logging out).
                       Defaults to Claude Code; target another tool with --tool <name>:
                         list                 List accounts (active one marked)
                         add <name> [--login] Create an account (then optionally log in)
                         use <name>           Set the active account
                         login|run <name>     Launch the tool with that account
                         rename <old> <new>   Rename an account (its config dir moves)
                         remove <name>        Delete an account (-y to skip confirm)
  profile <subcommand> Group one account per tool under a profile (e.g. 'work' =
                       claude:acme + codex:acme); the active profile drives launches:
                         list                       List profiles and their mappings
                         add <name>                 Create a profile
                         use <name|none>            Activate a profile (none = off)
                         set <name> <tool> <acct>   Pin a tool's account in the profile
                         unset <name> <tool>        Drop a tool from the profile
                         rename <old> <new>         Rename a profile (mappings stay)
                         remove <name>              Delete a profile (accounts stay)
  skills <subcommand>  List skills and manage discards (also in the hub's install panel):
                         list                 List every skill (discarded marked)
                         discard <name>       Remove a skill from every agent and skip
                                              it in future installs and updates
                         restore <name>       Re-enable a discarded skill (re-deploys
                                              to existing installs on the next sync)
  issue [bug|feature]  Open a prefilled GitHub issue (OS, versions, terminal,
                       detected agents autocompleted; default: bug)
  improve [--help]     Explain the /improve slash command (it runs inside your
                       agent - Claude Code, Codex, OpenCode - not in this CLI)
  compress [file]      Compress JSON/logs/text to fewer tokens (reversible via CCR);
                       reads a file or stdin. --retrieve <hash> restores an original,
                       --stats shows cumulative savings, --clear wipes all dashboard
                       data (stats/history/cache), --type forces the content type
  mcp                  Run the context-compression MCP server over stdio (tools:
                       enigma_compress, enigma_retrieve, enigma_stats). Usually launched
                       by an agent, not by hand; enable deployment with 'config compress on'
  dashboard, dash      Open the local savings dashboard in your browser (http://enigma,
                       or http://localhost:24282 if :80/hosts is unavailable). Runs only
                       while open; 'config dashboard always' keeps a background daemon
  seal                 Maintenance: (re)compute skill content hashes
  check                Integrity gate: verify skills are well-formed and sealed
  statusline           Print the [ENIGMA] badge for an agent status bar (shows the active level)
  help, version

Config keys: commit-emoji, update-notifier, auto-sync, remote-skills, fullscreen,
             parallel-subagents, output-style (off|lite|full|ultra),
             minimal-code (off|lite|full|ultra), compress, claude-attribution,
             claude-survey, gh-telemetry, permission-bypass, bypass-claude,
             bypass-codex, bypass-opencode

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
      --minimal-code <off|lite|full|ultra>  Anti-overengineering level (asked if omitted)
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
  enigma account add acme -t codex    # create a Codex account
  enigma profile add work             # profile grouping one account per tool
  enigma profile set work claude work # 'work' profile uses claude account 'work'
  enigma profile set work codex acme  # ...and codex account 'acme'
  enigma profile use work             # now 'enigma claude'/'enigma codex' use them
  enigma issue                        # report a bug with your environment prefilled
`);
}

/**
 * `enigma improve` / `enigma improve --help`: /improve is a slash command that
 * runs INSIDE the coding agent (Claude Code, Codex, OpenCode), not a CLI action -
 * enigma only deploys it. This explains it so users who reach for the CLI find it.
 */
function printImproveHelp(): void {
    console.log(`
/improve - a slash command, not a CLI command

  enigma deploys /improve into your coding agents (Claude Code, Codex, OpenCode);
  you run it INSIDE the agent (type "/improve ..." there), not from this CLI.
  There is nothing to run here - this is just the explanation.

It has two modes:

  Implement (edits code directly):
    /improve ui | frontend      Visual design, components, a11y, responsiveness
    /improve security           Secrets, authz, input validation, OWASP, dep audit
    /improve performance        Hot paths, queries/indexes, caching, bundle/render
    /improve seo                Metadata, semantic HTML, structured data, crawlability
    /improve refactor           Dedup/consistency: one source of truth, no behavior change

  Advisor (read-only; writes self-contained plans into plans/ for another agent):
    /improve audit [focus]      Full audit -> findings -> plans (focus: security|perf|tests|bugs)
    /improve quick | deep       Audit effort: hotspots only | whole repo
    /improve branch             Audit only what the current branch changes
    /improve next               Grounded feature/direction suggestions
    /improve plan <description> Skip the audit, spec one thing as a single plan
    /improve review-plan <file> Critique and tighten an existing plan
    /improve execute <plan>     Dispatch a cheaper executor in a worktree, review its diff
    /improve reconcile          Refresh the backlog: verify, unblock, retire
    /improve ... --issues       Also publish each plan as a GitHub issue

  A bare 'security' or 'performance' runs Implement mode (edits code); prefix an
  advisor keyword to audit instead (e.g. /improve audit security, /improve quick perf).

  Advisor mode never edits source, never mutates the working tree, and never prints
  secret values.

  Make sure it is deployed:  enigma install
`);
}

/**
 * Keep the launched tool's deployment fresh before handing it the terminal.
 * Default account: with autoSync on (default), re-deploys changed/new skills and
 * memory for the tool's agent; it never creates a first deployment there - that
 * stays an explicit `enigma install`. Managed account: the tool reads everything
 * from the account's enigma-created config dir, so a missing deployment is
 * seeded even when autoSync is off (otherwise the account would never get
 * skills/memory/bypass); refreshes respect the toggle. Never blocks the launch:
 * any sync error is reported and ignored.
 */
function syncForLaunch(tool: string, account: string): void {
    const auto = readConfig().config.autoSync;
    try {
        if (auto) for (const notice of syncDeployed([tool])) console.log(`enigma: synced ${notice}.`);
        if (account === DEFAULT_NAME) return;
        const dir = resolveConfigDir(tool, account);
        if (!auto && hasAccountDeployment(tool, dir)) return;
        for (const notice of syncAccount(tool, dir)) console.log(`enigma: synced ${notice}.`);
    } catch (err) {
        console.error(`enigma: skill auto-sync failed (${(err as Error).message}); launching anyway.`);
    }
}

/** Sync an account's deployment, then run the tool's login flow for it. */
async function loginWithSync(tool: string, name: string): Promise<number> {
    syncForLaunch(tool, name);
    return loginTool(tool, name);
}

/**
 * Best-effort first deployment into a freshly created account dir, so the account
 * starts with skills, memory and the mirrored settings before its first launch.
 * A failure is non-fatal: the next launch seeds it instead.
 */
function seedAccount(tool: string, dir: string): void {
    try { syncAccount(tool, dir); } catch { /* seeded on first launch instead */ }
}

/**
 * `enigma update` (also the hub's "update now" action): refresh the GitHub
 * skill cache, push new skills to existing deployments, then self-update
 * enigma-cli when a newer release is published. Each phase is independent and
 * failure-tolerant, so an unreachable GitHub or npm never blocks the others.
 */
async function runUpdateCli(version: string): Promise<void> {
    if (shouldCheckRemote(true)) {
        const s = p.spinner();
        s.start("Checking GitHub for skill updates...");
        const r = await refreshSkillsFromGitHub(true);
        if (r.error) s.stop(`Skill update check failed (${r.error}); keeping bundled/cached skills.`);
        else if (r.updated.length) s.stop(`Skill update(s) from GitHub: ${r.updated.join(", ")}.`);
        else s.stop("Skills are up to date with GitHub.");
    } else {
        p.log.info("Remote skill updates are off (enable with 'enigma config remote-skills on').");
    }
    try {
        for (const notice of syncDeployed()) p.log.info(`Synced ${notice}.`);
    } catch (err) {
        p.log.warn(`Skill sync failed: ${(err as Error).message}`);
    }
    // Keep the on-demand dashboard UI current - it is enigma's dependency to maintain.
    // Only when the user uses the dashboard (it is installed); never fetch it otherwise.
    if (isDashboardPkgInstalled()) {
        const ds = p.spinner();
        ds.start("Updating the dashboard UI (@enigmax/dashboard)...");
        refreshDashboardPkg();
        ds.stop("Dashboard UI is up to date.");
    }
    const s = p.spinner();
    s.start("Checking npm for a newer enigma-cli...");
    const latest = await checkLatestNow(version);
    s.stop(latest ? `Update available: ${version} -> ${latest}.` : `enigma-cli ${version} is up to date.`);
    if (latest) runUpdate();
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
                const identity = a.email ?? a.displayName ?? "(not logged in)";
                const meta = a.name === DEFAULT_NAME ? "(existing config)" : a.lastUsed ? `last used ${a.lastUsed}` : "never used";
                console.log(` ${marker} ${a.name.padEnd(14)} ${identity.padEnd(30)} ${meta}`);
                console.log(`     ${a.dir}`);
            }
            console.log(`\nActive: ${getActive(tool)}. Launch with: enigma ${tool} [account].`);
            return 0;
        }
        case "add": {
            if (!name) { console.error(`Usage: enigma account add <name> [--login] [--tool ${tool}]`); return 1; }
            try {
                const account = addAccount(tool, name);
                seedAccount(tool, account.dir);
                console.log(`Account '${account.name}' ready at ${account.dir} (skills, memory and settings deployed).`);
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
            try { return await loginWithSync(tool, name); }
            catch (err) { console.error((err as Error).message); return 1; }
        }
        case "run": {
            if (!name) { console.error("Usage: enigma account run <name>"); return 1; }
            try { syncForLaunch(tool, name); return await launchTool(tool, name, opts.passthrough); }
            catch (err) { console.error((err as Error).message); return 1; }
        }
        case "rename": {
            const to = opts.positionals[2];
            if (!name || !to) { console.error("Usage: enigma account rename <old> <new>"); return 1; }
            try { renameAccount(tool, name, to); console.log(`Renamed ${tool} account '${name}' to '${to}'.`); return 0; }
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
            console.error(`Unknown account subcommand: ${sub}. Try: list, add, use, login, run, rename, remove.`);
            return 1;
    }
}

/**
 * `enigma profile <subcommand>` surface: profiles group one account per tool and
 * the active profile drives account resolution on launches. Returns an exit code.
 */
async function runProfileCli(opts: CliOptions, interactive: boolean): Promise<number> {
    const [sub, name, tool, account] = opts.positionals;
    try {
        switch (sub) {
            case undefined:
            case "list":
            case "ls": {
                const profiles = listProfiles();
                if (!profiles.length) {
                    console.log("No profiles yet. Create one with: enigma profile add <name>.");
                    return 0;
                }
                console.log("Profiles:\n");
                for (const p of profiles) {
                    const marker = p.active ? "*" : " ";
                    const mappings = Object.entries(p.accounts).map(([t, a]) => `${t}=${a}`).join("  ") || "(no accounts pinned)";
                    console.log(` ${marker} ${p.name.padEnd(14)} ${mappings}`);
                }
                console.log("\nActive profile drives 'enigma <tool>' account resolution; 'enigma profile use none' disables.");
                return 0;
            }
            case "add": {
                if (!name) { console.error("Usage: enigma profile add <name>"); return 1; }
                addProfile(name);
                console.log(`Profile '${name}' ready. Pin accounts with: enigma profile set ${name} <tool> <account>.`);
                return 0;
            }
            case "use":
            case "switch": {
                if (!name) { console.error("Usage: enigma profile use <name|none>"); return 1; }
                setActiveProfile(name === "none" ? null : name);
                console.log(name === "none" ? "No active profile (tools use their own active accounts)." : `Active profile is now '${name}'.`);
                return 0;
            }
            case "set": {
                if (!name || !tool || !account) { console.error("Usage: enigma profile set <name> <tool> <account>"); return 1; }
                setProfileAccount(name, tool, account);
                console.log(`Profile '${name}': ${tool} -> '${account}'.`);
                return 0;
            }
            case "unset": {
                if (!name || !tool) { console.error("Usage: enigma profile unset <name> <tool>"); return 1; }
                unsetProfileAccount(name, tool);
                console.log(`Profile '${name}': ${tool} mapping removed.`);
                return 0;
            }
            case "rename": {
                const to = opts.positionals[2];
                if (!name || !to) { console.error("Usage: enigma profile rename <old> <new>"); return 1; }
                renameProfile(name, to);
                console.log(`Renamed profile '${name}' to '${to}'.`);
                return 0;
            }
            case "remove":
            case "rm": {
                if (!name) { console.error("Usage: enigma profile remove <name>"); return 1; }
                if (!opts.yes && interactive) {
                    const ok = await p.confirm({ message: `Remove profile '${name}'? (its accounts are kept)` });
                    if (p.isCancel(ok) || !ok) { console.log("Aborted."); return 0; }
                }
                removeProfile(name);
                console.log(`Removed profile '${name}'.`);
                return 0;
            }
            default:
                console.error(`Unknown profile subcommand: ${sub}. Try: list, add, use, set, unset, rename, remove.`);
                return 1;
        }
    } catch (err) {
        console.error((err as Error).message);
        return 1;
    }
}

/**
 * `enigma skills <list|discard|restore>` surface. Discarding removes the skill
 * from every existing deployment and skips it in future installs and updates;
 * restoring re-deploys it to existing installs immediately. Returns an exit code.
 */
function runSkillsCli(opts: CliOptions): number {
    const [sub, name] = opts.positionals;
    switch (sub) {
        case undefined:
        case "list":
        case "ls": {
            console.log("Skills:\n");
            for (const s of listSkillsStatus()) {
                const ver = s.version ? `v${s.version}` : "";
                console.log(` ${s.discarded ? "-" : "*"} ${s.name.padEnd(26)} ${ver.padEnd(8)} ${s.discarded ? "discarded" : "active"}`);
            }
            console.log("\nDiscarded skills are removed from agents and skipped by installs/updates.");
            console.log("Manage with: enigma skills <discard|restore> <name>.");
            return 0;
        }
        case "discard":
        case "restore": {
            if (!name) { console.error(`Usage: enigma skills ${sub} <name>`); return 1; }
            const skill = listSkillsStatus().find((s) => s.name === name);
            if (!skill) { console.error(`Unknown skill '${name}'. See: enigma skills list.`); return 1; }
            const discarded = sub === "discard";
            if (skill.discarded === discarded) { console.log(`Skill '${name}' is already ${discarded ? "discarded" : "active"}.`); return 0; }
            for (const notice of discardSkill(name, discarded)) console.log(`Synced ${notice}.`);
            console.log(discarded
                ? `Skill '${name}' discarded: removed from deployments and skipped by future installs and updates.`
                : `Skill '${name}' restored: it deploys again on installs and syncs.`);
            return 0;
        }
        default:
            console.error(`Unknown skills subcommand: ${sub}. Try: list, discard, restore.`);
            return 1;
    }
}

/**
 * `enigma issue [bug|feature]` surface: print a GitHub new-issue URL with the
 * environment fields prefilled (OS, OS version, terminal, detected agents,
 * enigma version, install method) and offer to open it in the browser. The URL
 * is always printed so it works in non-interactive shells too.
 */
async function runIssueCli(kindArg: string | undefined, version: string, interactive: boolean): Promise<number> {
    const kind = (kindArg ?? "bug") as IssueKind;
    if (kind !== "bug" && kind !== "feature") {
        console.error(`Unknown issue type: ${kindArg}. Try: bug, feature.`);
        return 1;
    }
    const url = buildIssueUrl(kind, version);
    console.log(`Prefilled ${kind} report (environment details autocompleted):\n\n${url}\n`);
    if (interactive) {
        const open = await p.confirm({ message: "Open it in your browser now?", initialValue: true });
        if (!p.isCancel(open) && open && !openUrl(url)) console.error("Could not open the browser; use the URL above.");
    }
    return 0;
}

/**
 * `enigma compress [file]` surface: compress content with the native engine and
 * print the result to stdout (savings to stderr, so the output stays pipeable).
 * Reads a file argument, or stdin when given `-` or nothing. `--retrieve <hash>`
 * restores a CCR original; `--stats` prints cumulative savings. Returns an exit code.
 */
function runCompressCli(opts: CliOptions): number {
    if (opts.retrieve) {
        const original = retrieve(opts.retrieve);
        if (original === null) { console.error(`No cached original for hash '${opts.retrieve}'.`); return 1; }
        process.stdout.write(original);
        return 0;
    }
    if (opts.stats) {
        const s = readStats();
        const pct = s.tokensBefore ? Math.round((s.tokensSaved / s.tokensBefore) * 100) : 0;
        console.log(`calls: ${s.calls}\ntokens before: ${s.tokensBefore}\ntokens after: ${s.tokensAfter}\ntokens saved: ${s.tokensSaved} (${pct}%)`);
        return 0;
    }
    if (opts.clear) {
        const { files, bytes } = clearCcr();
        console.log(`Cleared all compression data: ${files} file(s) removed, ${(bytes / 1024).toFixed(1)} KB freed. The dashboard is now reset.`);
        return 0;
    }
    const file = opts.positionals[0];
    let content: string;
    try { content = (!file || file === "-") ? readFileSync(0, "utf8") : readFileSync(file, "utf8"); }
    catch (err) { console.error(`Cannot read input: ${(err as Error).message}`); return 1; }

    const type = (opts.compressType as ContentType | null) ?? undefined;
    const r = compress(content, { type, source: "cli" });
    process.stdout.write(r.compressed);
    if (!r.compressed.endsWith("\n")) process.stdout.write("\n");
    const pct = r.tokensBefore ? Math.round((r.tokensSaved / r.tokensBefore) * 100) : 0;
    console.error(`enigma compress: ${r.contentType}, ${r.tokensBefore} -> ${r.tokensAfter} tokens (${pct}% saved${r.ccrHash ? `, retrieve with: enigma compress --retrieve ${r.ccrHash}` : ""}).`);
    return 0;
}

/**
 * `enigma dashboard` (alias `dash`): serve the local savings dashboard and open it in
 * the browser. On-demand by default - the server lives only while this command runs, so
 * it costs nothing when closed. In "always" mode it just opens the running daemon. Blocks
 * until Ctrl+C. The dashboard config setting governs the daemon, not this command, which
 * always works on request.
 */
async function runDashboardCli(version: string): Promise<number> {
    const mode = readConfig().config.dashboard;
    // The UI bundle (@enigmax/dashboard) ships separately and is fetched on demand. If it
    // is not present yet, install it now so the first open shows the real page, not the
    // fallback. Best-effort: offline just serves the fallback until a later run succeeds.
    if (!isDashboardPkgCurrent()) {
        console.log(isDashboardPkgInstalled() ? "Updating the dashboard UI (@enigmax/dashboard)..." : "Fetching the dashboard UI (@enigmax/dashboard)...");
        if (!ensureDashboardCurrent()) console.log("Could not fetch the UI bundle (offline?); serving what is available.");
    }
    // Best-effort: map http://enigma -> loopback so the URL is pretty (falls back to
    // localhost when hosts is unwritable). No-op when the entry already exists.
    ensureHostsEntry();
    if (mode === "always") {
        const daemon = runningDaemon();
        if (daemon) {
            console.log(`enigma dashboard (always) -> ${daemon.url}`);
            openUrl(daemon.url);
            return 0;
        }
    }
    let server: Awaited<ReturnType<typeof startDashboardServer>>;
    try { server = await startDashboardServer(version); }
    catch (err) { console.error(`Could not start the dashboard: ${(err as Error).message}`); return 1; }
    console.log(`enigma dashboard -> ${server.url}`);
    console.log("Press Ctrl+C to stop.");
    openUrl(server.url);
    return await new Promise<number>((resolveExit) => {
        const stop = (): void => { server.close(); resolveExit(0); };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
}

/**
 * Print the [ENIGMA] status badge for an agent status bar (e.g. Claude Code's
 * statusLine). Always shows `[ENIGMA]`; when token-efficient output is active it
 * appends the level, e.g. `[ENIGMA:FULL]` / `[ENIGMA:ULTRA]`. Amber unless NO_COLOR.
 * Never throws or prints noise - a status bar must stay quiet.
 */
function printStatusline(): void {
    try {
        const style = readConfig().config.outputStyle;
        const label = (!style || style === "off") ? "ENIGMA" : `ENIGMA:${style.toUpperCase()}`;
        process.stdout.write(process.env.NO_COLOR ? `[${label}]` : `\x1b[38;5;172m[${label}]\x1b[0m`);
    } catch {
        // A status bar command must never error or emit noise.
    }
}

export async function run(argv: string[]): Promise<void> {
    // Hidden internal command, handled before parsing: the detached background
    // update check re-invokes the compiled binary with this argv (a Bun-compiled
    // executable cannot run `node -e` scripts). Silent by contract.
    if (argv[0] === "__update-check") { await performUpdateCheck(); return; }
    // Hidden: the detached background linter install kicked off when auto-lint is
    // enabled (spawnLinterInstall). Silent, best-effort; the runner self-heals.
    if (argv[0] === "__lint-install") { ensureLinterInstalled(); return; }
    // Hidden: the detached background dashboard-UI install kicked off when the dashboard
    // is enabled (spawnDashboardPkgInstall). Silent, best-effort; server self-heals.
    if (argv[0] === "__dashboard-install") { ensureDashboardCurrent(); return; }
    // Hidden: the detached dashboard daemon (dashboard=always). Serves the savings
    // dashboard forever and publishes its pidfile. Silent by contract.
    if (argv[0] === "__dashboard-serve") { await serveDashboardDaemon(process.env.ENIGMA_VERSION || PKG.version || "0.0.0"); return; }
    // MCP stdio server: stdout is the JSON-RPC channel, so dispatch BEFORE any clack
    // intro/notice/parse noise and never print to stdout from here on.
    if (argv[0] === "mcp") {
        const { runMcpServer } = await import("./mcp");
        await runMcpServer(process.env.ENIGMA_VERSION || PKG.version || "0.0.0");
        return;
    }
    const opts = parseArgs(argv);
    const interactive = Boolean(process.stdout.isTTY) && !opts.yes;
    const version = process.env.ENIGMA_VERSION || PKG.version || "0.0.0";
    // Statusline: fast, silent badge for an agent's status bar (e.g. Claude Code). No
    // update notice or other output. The Node launcher also short-circuits this before
    // spawning the binary, so it stays cheap on every status refresh.
    if (opts.command === "statusline") { printStatusline(); return; }
    // /improve runs inside the agent, not the CLI; `enigma improve [--help]` only
    // explains it. Handled before the generic --help so `improve --help` shows this.
    if (opts.command === "improve") { printImproveHelp(); await notifyUpdate(version, interactive); return; }
    if (opts.help || opts.command === "help") { printHelp(); await notifyUpdate(version, interactive); return; }
    if (opts.version || opts.command === "version") { console.log(version); await notifyUpdate(version, interactive); return; }

    // Direct (non-menu) maintenance and feature commands. Machine/CI commands
    // (seal, check, guard, config) skip the update notice to keep their output clean.
    if (opts.command === "seal") return sealSources();
    if (opts.command === "check") return checkSources();
    if (opts.command === "guard") { process.exit(runGuardCli(opts.all)); }
    if (opts.command === "config") { process.exit(await runConfigCli(opts.positionals, opts.scope, interactive)); }
    if (opts.command && isToolName(opts.command)) {
        // Resolve the account up front (explicit > active profile > tool active) so
        // the pre-launch sync targets the same config dir the tool will read.
        const account = opts.positionals[0] ?? resolveLaunchAccount(opts.command);
        syncForLaunch(opts.command, account);
        process.exit(await launchTool(opts.command, account, opts.passthrough));
    }
    if (opts.command === "account") { process.exit(await runAccountCli(opts, interactive)); }
    if (opts.command === "profile") { process.exit(await runProfileCli(opts, interactive)); }
    if (opts.command === "skills") { process.exit(runSkillsCli(opts)); }
    if (opts.command === "issue") { process.exit(await runIssueCli(opts.positionals[0], version, interactive)); }
    if (opts.command === "compress") { process.exit(runCompressCli(opts)); }
    if (opts.command === "dashboard") { process.exit(await runDashboardCli(version)); }

    if (opts.command === "update") {
        p.intro("enigma - update");
        await runUpdateCli(version);
        p.outro("Done.");
        return;
    }
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
                email: a.email ?? a.displayName, active: a.active, removable: a.name !== DEFAULT_NAME,
            })));
    const hubProfiles = (): HubProfile[] =>
        listProfiles().map((p) => ({
            name: p.name, active: p.active,
            summary: Object.entries(p.accounts).map(([t, a]) => `${t}=${a}`).join("  ") || "(no accounts pinned)",
        }));
    const hubSkills = (): HubSkill[] =>
        listSkillsStatus().map((s) => ({ name: s.name, version: s.version, discarded: s.discarded }));
    const discovered = discoverAgents();
    const buildCtx = () => ({
        agents: discovered.map((a) => ({ name: a.name, label: a.label, installed: a.installed })),
        protections: GUARD_PROTECTIONS,
        // First run = nothing deployed anywhere: the hub preselects the install action
        // and shows a setup banner so the first install is a couple of keystrokes.
        firstRun: !discovered.some((a) => hasDeployment(a, "global") || hasDeployment(a, "local")),
        update: getAvailableUpdate(version) ?? undefined,
        skills: hubSkills(),
        setSkillDiscarded: (name: string, discarded: boolean) => { discardSkill(name, discarded); return hubSkills(); },
        accounts: hubAccounts(),
        activateAccount: (tool: string, name: string) => { setActive(tool, name); return hubAccounts(); },
        removeAccount: (tool: string, name: string) => { removeAccount(tool, name); return hubAccounts(); },
        addAccount: (tool: string, name: string) => {
            try {
                const account = addAccount(tool, name);
                seedAccount(tool, account.dir);
                return { ok: true, accounts: hubAccounts() };
            }
            catch (err) { return { ok: false, error: (err as Error).message, accounts: hubAccounts() }; }
        },
        renameAccount: (tool: string, oldName: string, newName: string) => {
            try { renameAccount(tool, oldName, newName); return { ok: true, accounts: hubAccounts() }; }
            catch (err) { return { ok: false, error: (err as Error).message, accounts: hubAccounts() }; }
        },
        tools: TOOL_NAMES.map((t) => ({ name: t, label: getTool(t).label })),
        profiles: hubProfiles(),
        activateProfile: (name: string) => { setActiveProfile(name || null); return hubProfiles(); },
        addProfile: (name: string) => {
            try { addProfile(name); return { ok: true, profiles: hubProfiles() }; }
            catch (err) { return { ok: false, error: (err as Error).message, profiles: hubProfiles() }; }
        },
        renameProfile: (oldName: string, newName: string) => {
            try { renameProfile(oldName, newName); return { ok: true, profiles: hubProfiles() }; }
            catch (err) { return { ok: false, error: (err as Error).message, profiles: hubProfiles() }; }
        },
        removeProfile: (name: string) => { removeProfile(name); return hubProfiles(); },
        setProfileAccount: (profile: string, tool: string, account: string | null) => {
            try {
                if (account === null) unsetProfileAccount(profile, tool);
                else setProfileAccount(profile, tool, account);
                return { ok: true, profiles: hubProfiles() };
            } catch (err) { return { ok: false, error: (err as Error).message, profiles: hubProfiles() }; }
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
        await loginWithSync(action.tool, action.account);
        action = await runHomeTui(buildCtx());
    }
    // "Update now" from the hub: run the full update (skills + npm) in the freed
    // terminal (the running binary is about to be replaced, so do not reopen the hub).
    if (action?.type === "update") { await runUpdateCli(version); return; }
    await notifyUpdate(version, interactive);
}
