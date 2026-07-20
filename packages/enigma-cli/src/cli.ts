/**
 * enigma CLI: argument parsing, the interactive top-level menu, and command
 * dispatch. Features are modular and opt-in - the menu lets the user enable or
 * disable each one. Subcommands run a single feature non-interactively.
 */

import { readJson } from "./util";
import * as p from "@clack/prompts";
import { runGuardCli } from "./guard";
import { DASHBOARD_BINDS, readConfig, setEnigmaValue, type DashboardBind } from "./config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IssueKind } from "./issue";
import { discoverAgents } from "./agents";
import { runConfigCli } from "./settings";
import { collectReporter } from "./reporter";
import { hostname, userInfo } from "node:os";
import type { ContentType } from "./compress";
import type { InstallOptions } from "./skills";
import { starRepoInBackground } from "./github";
import { buildIssueUrl, isHeadless, openUrl } from "./issue";
import { ensureDashboardToken, readDashboardToken } from "./dashboard-token";
import { dirname, join, resolve } from "node:path";
import { setupGitHooks, GUARD_PROTECTIONS } from "./security";
import { ensureLaunchable, toolPathStatuses } from "./tool-path";
import { compress, retrieve, readStats, clearCcr } from "./compress";
import type { HubAccount, HubExitAction, HubProfile, HubSkill } from "./tui/types";
import { ensureLinterInstalled, isLinterInstalled, refreshLinterPkg } from "./lint";
import { checkLatestNow, getAvailableUpdate, notifyUpdate, performUpdateCheck, runUpdate } from "./update";
import { isUsableSession, sessionEmail, sessionState, transferSession, type SessionState } from "./claude-oauth";
import { ensureDashboardCurrent, isDashboardPkgCurrent, isDashboardPkgInstalled, refreshDashboardPkg } from "./dashboard-pkg";
import { clearDaemon, daemonError, dashboardUrl, ensureHostsEntry, repoBindOverrideIgnored, resolveBind, restartDashboardDaemon, runningDaemon, serveDashboardDaemon, startDashboardServer, tokenizedUrl, writeDaemon } from "./dashboard";
import {
    PACKS, disablePack, enablePack, getPack, installedPackVersion, isPackInstalled,
    launchPack, listPacks, packSessionSources, refreshPack, setupPackMcp,
} from "./packs";
import {
    checkSources, discardSkill, hasAccountDeployment, hasDeployment, installSkills,
    listSkillsStatus, refreshSkillsFromGitHub, sealSources, setSkillAgent, shouldCheckRemote,
    syncAccount, syncDeployed,
} from "./skills";
import {
    DEFAULT_NAME, DEFAULT_TOOL, TOOL_NAMES, addAccount, addProfile, getActive, getTool,
    isToolName, launchTool, listAccounts, listProfiles, loginTool, removeAccount, spawnInherit,
    removeProfile, renameAccount, renameProfile, resolveConfigDir, resolveLaunchAccount,
    setActive, setActiveProfile, setProfileAccount, unsetProfileAccount,
    getAccountProvider, setAccountProvider, providerFromPreset, presetsForTool, PROVIDER_PRESETS,
    type ProviderInput,
} from "./accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In the compiled binary __dirname lives in Bun's virtual fs (no package.json on
// disk); the launcher passes ENIGMA_VERSION. Reading package.json stays as the
// dev/tsx fallback.
const PKG = readJson<{ version?: string }>(join(__dirname, "..", "package.json")) || {};

// Fixed commands plus one launch command per supported tool (e.g. `enigma claude`).
const COMMANDS = new Set<string>([
    "install", "update", "security", "guard", "seal", "check", "config", "account", "accounts",
    "profile", "profiles", "skill", "skills", "issue", "improve", "compress", "mcp", "api", "gate", "dashboard", "dash", "fix-path", "resources", "recall", "codegraph", "autoskills", "statusline", "help", "version",
    "pack", "packs", "ssh",
    ...TOOL_NAMES,
    ...PACKS.map((p) => p.id),
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
    /** `account provider`: built-in provider preset id (e.g. "minimax"). */
    preset: string | null;
    /** `account provider`: auth token (API key) for a provider override. */
    token: string | null;
    /** `account provider`: custom Anthropic-compatible base URL. */
    base: string | null;
    /** `account provider`: model id for a provider override. */
    providerModel: string | null;
    /** `api`: port override for the local Claude Code API server. */
    port: number | null;
    /** `api`: optional bearer key required by the local API server. */
    apiKey: string | null;
    /** `api`: default account / profile / pack context every request runs under. */
    apiAccount: string | null;
    apiProfile: string | null;
    apiPack: string | null;
    /** `dashboard`: bind every interface for this run (token required), without persisting it. */
    expose: boolean;
    /** `dashboard token`: mint a fresh token, killing every link handed out earlier. */
    newToken: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        command: null, positionals: [], passthrough: [], tool: DEFAULT_TOOL,
        scope: null, agents: [], allAgents: false, skills: [],
        skillsOnly: false, memoryOnly: false, prune: true, keepModified: false,
        bypass: null, noBypass: false, outputStyle: null, minimalCode: null, dashboard: null, promptSecretGuard: null,
        force: false, all: false, yes: false, login: false, dryRun: false, help: false, version: false,
        stats: false, retrieve: null, compressType: null, clear: false,
        preset: null, token: null, base: null, providerModel: null,
        port: null, apiKey: null, apiAccount: null, apiProfile: null, apiPack: null, expose: false, newToken: false,
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
            case "--prompt-secret-guard": opts.promptSecretGuard = true; break;
            case "--preset": opts.preset = next(); break;
            case "--token": opts.token = next(); break;
            case "--base": opts.base = next(); break;
            case "--model": opts.providerModel = next(); break;
            case "--port": opts.port = Number(next()); break;
            case "--api-key": opts.apiKey = next(); break;
            case "--account": opts.apiAccount = next(); break;
            case "--profile": opts.apiProfile = next(); break;
            case "--pack": opts.apiPack = next(); break;
            case "--expose": opts.expose = true; break;
            // Its own flag, not an alias of --force: --force is honoured by several commands,
            // so folding them together would silently arm those with an undocumented spelling.
            case "--new": opts.newToken = true; break;
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
                         provider <name>      Point Claude Code at another backend (e.g.
                                              MiniMax): --preset <id> | --base <url>
                                              [--model <id>] --token <key>, or --clear
                         sessions             List reusable Claude logins (Claude only)
                         transfer <name> [src] Reuse a live login in a signed-out account
                                              (no re-login; Claude only)
  profile <subcommand> Group one account per tool under a profile (e.g. 'work' =
                       claude:acme + codex:acme); the active profile drives launches:
                         list                       List profiles and their mappings
                         add <name>                 Create a profile
                         use <name|none>            Activate a profile (none = off)
                         set <name> <tool> <acct>   Pin a tool's account in the profile
                         unset <name> <tool>        Drop a tool from the profile
                         rename <old> <new>         Rename a profile (mappings stay)
                         remove <name>              Delete a profile (accounts stay)
  skills <subcommand>  List skills and choose where each deploys (also in the hub):
                         list                 List every skill with its state
                         disable <name>       Remove from every agent, skip in installs
                         disable <name> <agent>   Turn off for one agent only (e.g. opencode)
                         enable  <name> [agent]   Re-deploy globally, or to one agent
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
  api                  Serve a local OpenAI-compatible API backed by your local coding agents
                       (Claude Code, and Codex/OpenCode where installed) - all of their
                       tools/skills/MCP/sessions via the local CLI. One server, many backends:
                       pick per request via the model field (claude-sonnet-5 | codex | opencode).
                       Run requests under an account, profile or pack (e.g. Helio): --account,
                       --profile, --pack set the default; a request body can override with
                       account/profile/pack. Endpoints under /v1 (chat/completions, messages,
                       models, sessions). --port <n> (else config apiPort, default 8000),
                       --api-key <k> (or ENIGMA_API_KEY), --tool <t> = default backend. Loopback
  dashboard, dash      Open the local savings dashboard in your browser (http://enigma,
                       or http://localhost:24282 if :80/hosts is unavailable). Runs only
                       while open; 'config dashboard always' keeps a background daemon.
                       Loopback by default. With no browser (a server over SSH) it prints
                       the tunnel command and offers to expose it. --expose binds every
                       interface for this run; 'config dashboard-bind lan' makes it stick.
                       Exposing always requires a token: 'dashboard token [--new]' prints
                       or rotates it, and the link carries it as a #token= fragment
  fix-path [tool]      Detect a tool's install path (OS-agnostic, even off PATH) and
                       repair its launch command so 'enigma <tool>' works; no tool fixes all
  resources [action]   System cleanup: status, or wsl | docker | free-port PORT | kill PID
                       (shut down WSL/vmmemWSL, quit Docker, free a port, kill a process)
  ssh [alias|name]     SSH connection manager: connect by alias or name, or list | add | edit |
                       remove | info. Tunnels are standalone (bound to a server): tunnel add
                       <name> <server> <spec>, tunnel start|stop <name>, tunnels (list w/ status).
                       (encrypted passwords auto-filled with no extra tools; --name = 2nd key)
  recall [action]      Local session memory from transcripts: status, sync, search <q>,
                       list, show <id>, timeline <id>, sessions, context, prune, clear
                       (hybrid keyword+vector search; opt-in; reads your own logs)
  codegraph [action]   Native codebase memory / code graph: status, on, off,
                       index [path], projects, arch [project], search <name>
                       (opt-in; structural code intelligence over MCP, no external tool)
  autoskills [path]    Detect the project's tech stack and install matching agent skills
                       (separate from the policy skills; --dry-run to preview)
  pack <subcommand>    Marketplace of optional, isolated harness packs (e.g. Helio for bug
                       bounty). Each runs in its own agent context, so its skills/commands
                       never load into your normal agent:
                         list                 List packs and their install state
                         install <id>         Fetch and add a pack
                         remove <id>          Delete a pack and its context
                         update <id>          Refresh a pack to the latest version
                         setup <id>           Register the pack's MCP servers (needs Python)
                         use <id> <acct|->    Pin which account seeds the pack ('-' clears)
                         run <id> [account]   Launch the pack's isolated agent
  <pack> [account]     Launch a pack directly (e.g. 'enigma helio', 'enigma helio work') in its
                       isolated context, seeded with the chosen/pinned/active login (--tool to
                       target codex/opencode); pass tool args after '--'
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
      --prompt-secret-guard  Block secrets in Claude chat prompts (opt-in; off by default)
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
    // Capture session memory in the background (opt-in) so recall stays fresh without a manual
    // sync - the automatic-ingestion role. Deferred so it never delays the launch; silent and
    // best-effort. syncRecall is incremental, so repeat launches are cheap.
    if (readConfig().config.recall) {
        setTimeout(() => {
            import("./recall")
                .then(async (r) => { try { r.syncRecall(); await r.enrichRecall(); } catch { /* best-effort */ } })
                .catch(() => { /* recall unavailable */ });
        }, 0);
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
    // Keep every on-demand enigma package the user actually has current - they are enigma's
    // own dependencies to maintain. Only when installed (never fetch one the user doesn't use);
    // the refreshers force @latest with --prefer-online so a stale npm cache can't pin an old build.
    if (isDashboardPkgInstalled()) {
        const ds = p.spinner();
        ds.start("Updating the dashboard UI (@enigmax/dashboard)...");
        refreshDashboardPkg();
        ds.stop("Dashboard UI updated to latest.");
    }
    if (isLinterInstalled()) {
        const ls = p.spinner();
        ls.start("Updating the linter (@enigmax/linter)...");
        refreshLinterPkg();
        ls.stop("Linter updated to latest.");
    }
    // Marketplace packs the user has actually installed (never fetch one they don't use).
    for (const pack of listPacks().filter((pk) => isPackInstalled(pk.id))) {
        const ps = p.spinner();
        ps.start(`Updating the ${pack.label} pack (@enigmax/${pack.id})...`);
        const changed = refreshPack(pack.id);
        ps.stop(changed ? `${pack.label} pack updated to ${installedPackVersion(pack.id)}.` : `${pack.label} pack is up to date.`);
    }
    // Self-update: ALWAYS reinstall enigma-cli@latest on an explicit `enigma update`, rather
    // than gating on a cached "is newer" check that a stale registry cache could get wrong.
    // runUpdate() runs `npm cache clean --force` first, so the install ignores the npm cache.
    const s = p.spinner();
    s.start("Checking npm for the latest enigma-cli...");
    const latest = await checkLatestNow(version);
    s.stop(latest ? `Newer enigma-cli available: ${version} -> ${latest}. Installing...` : `enigma-cli ${version}: reinstalling the latest to be sure...`);
    starRepoInBackground();
    runUpdate();
    // An always-on dashboard daemon is still running the pre-update binary (version baked in at
    // spawn), so restart it on the new binary - otherwise the running dashboard keeps showing the
    // old version and a stale "update available" banner, which is what makes "Update now" look dead.
    try { if (restartDashboardDaemon()) p.log.info("Restarted the dashboard on the new version."); } catch { /* best-effort */ }
}

/**
 * `enigma fix-path [tool]` surface. Detects each tool's install path (OS-agnostic,
 * even when it is not on PATH) and persists a launch path so `enigma <tool>` works.
 * No argument fixes every supported tool. Returns 0 when every target is launchable.
 */
function runFixPathCli(tool: string | undefined, scope: "global" | "local" | null): number {
    const targets = tool ? [tool] : TOOL_NAMES;
    let allOk = true;
    for (const t of targets) {
        if (!isToolName(t)) {
            console.error(`Unknown tool '${t}'. Known tools: ${TOOL_NAMES.join(", ")}.`);
            allOk = false;
            continue;
        }
        const result = ensureLaunchable(t, scope ?? "global");
        console.log(`${result.ok ? "ok" : "--"}  ${result.message}`);
        if (!result.ok) allOk = false;
    }
    return allOk ? 0 : 1;
}

/**
 * `enigma resources [wsl|docker|free-port PORT|kill PID]` - system cleanup. With no
 * subcommand it prints a status snapshot; the subcommands run DESTRUCTIVE actions (typing
 * the command is the confirmation; the dashboard/TUI confirm interactively instead).
 */
async function runResourcesCli(args: string[]): Promise<number> {
    const { resourceStatus, freePort, killPid, shutdownWsl, quitDocker } = await import("./resources");
    const [sub, arg] = args;
    const mb = (bytes: number): number => Math.round(bytes / 1048576);
    if (!sub) {
        const s = resourceStatus();
        console.log(`Platform: ${s.platform}   Memory: ${mb(s.totalMem - s.freeMem)}/${mb(s.totalMem)} MB used`);
        console.log(`WSL: ${s.wslAvailable ? (s.vmmemRunning ? "running (vmmemWSL active - eating RAM)" : "available") : "n/a"}   Docker Desktop: ${s.dockerRunning ? "running" : "not running"}`);
        console.log("\nTop processes by memory:");
        for (const p of s.topProcesses.slice(0, 12)) console.log(`  ${String(p.pid).padStart(7)}  ${String(mb(p.memKB * 1024)).padStart(5)} MB  ${p.name}`);
        console.log("\nListening ports:");
        for (const p of s.ports.slice(0, 20)) console.log(`  :${String(p.port).padEnd(6)} pid ${String(p.pid).padEnd(7)} ${p.name}`);
        console.log("\nActions: enigma resources <wsl | docker | free-port PORT | kill PID>");
        return 0;
    }
    const r = sub === "wsl" ? shutdownWsl()
        : sub === "docker" ? quitDocker()
        : sub === "free-port" ? freePort(Number(arg))
        : sub === "kill" ? killPid(Number(arg))
        : null;
    if (!r) { console.error(`Unknown subcommand '${sub}'. Use: enigma resources <wsl | docker | free-port PORT | kill PID>`); return 1; }
    console.log(r.message);
    return r.ok ? 0 : 1;
}

/**
 * `enigma ssh [alias] | <list|add|edit|remove|info|tunnel|forward>`: the SSH connection
 * manager. Save a server once (host, user, key or password, jump host, forwards) and reach
 * it with `enigma ssh <alias>`. Passwords are encrypted at rest and auto-supplied via
 * sshpass/plink when present. Owns its own flag parsing (dispatched before parseArgs).
 */
async function runSshCli(args: string[], interactive: boolean): Promise<number> {
    const ssh = await import("./ssh");
    const [sub, ...rest] = args;

    // No arg / list: show saved connections.
    if (!sub || sub === "list" || sub === "ls") {
        const conns = ssh.listConnections();
        if (!conns.length) {
            console.log("No SSH connections yet. Add one:\n  enigma ssh add <alias> --host <host> [--user u] [-i key.pem | --password]");
            return 0;
        }
        console.log("SSH connections:\n");
        for (const c of conns) {
            const auth = c.identityFile ? `key ${c.identityFile}` : c.hasPassword ? "password" : "agent/prompt";
            const fwd = c.forwards?.length ? `  (${c.forwards.length} forward${c.forwards.length > 1 ? "s" : ""})` : "";
            const key = c.name && c.name !== c.alias ? `${c.alias} / ${c.name}` : c.alias;
            console.log(`  ${key.padEnd(20)} ${ssh.sshTarget(c as never).padEnd(26)} ${auth}${fwd}`);
        }
        console.log("\nConnect: enigma ssh <alias|name>    Tunnel: enigma ssh tunnel <alias> <name|spec...>");
        return 0;
    }

    if (sub === "add" || sub === "edit") {
        const alias = rest[0];
        if (!alias) { console.error(`Usage: enigma ssh ${sub} <alias> --host <host> [--name server-name] [--user u] [--port n] [-i key] [--password] [--jump host] [-o K=V] [-L spec]`); return 1; }
        const flags = rest.slice(1);
        const input: import("./ssh").SshInput = {};
        let promptPassword = false, badForward = false;
        const opts: string[] = [];
        const forwards: import("./ssh").PortForward[] = [];
        for (let i = 0; i < flags.length; i++) {
            const f = flags[i]!;
            const val = (): string => flags[++i] ?? "";
            switch (f) {
                case "--name": case "-n": input.name = val(); break;
                case "--no-name": input.name = ""; break;
                case "--host": case "-H": input.host = val(); break;
                case "--user": case "-u": input.user = val(); break;
                case "--port": case "-p": input.port = Number(val()) || undefined; break;
                case "--identity": case "-i": input.identityFile = val(); break;
                case "--jump": case "-j": input.proxyJump = val(); break;
                case "--forward-agent": case "-A": input.forwardAgent = true; break;
                case "--no-forward-agent": input.forwardAgent = false; break;
                case "--option": case "-o": opts.push(val()); break;
                case "--forward": case "-L": {
                    const pf = ssh.parseForward(val());
                    if (pf) forwards.push(pf); else badForward = true;
                    break;
                }
                case "--password": promptPassword = true; break;
                case "--password-value": input.password = val(); break; // scriptable; discouraged
                case "--no-password": input.password = ""; break;
                default: console.error(`Unknown flag: ${f}`); return 1;
            }
        }
        if (badForward) { console.error("Bad forward spec. Examples: 8080  9090:8080  9090:dbhost:5432  R:8080:localhost:80  D:1080"); return 1; }
        if (opts.length) input.options = opts;
        if (forwards.length) input.forwards = forwards;
        if (promptPassword) {
            if (!interactive) { console.error("--password needs an interactive terminal; use --password-value <pw> in scripts."); return 1; }
            const pw = await p.password({ message: `Password for ${alias}`, mask: "*" });
            if (p.isCancel(pw)) { p.cancel("Cancelled."); return 1; }
            input.password = pw;
        }
        const res = sub === "add" ? ssh.addConnection(alias, input) : ssh.updateConnection(alias, input);
        if (!res.ok) { console.error(res.error); return 1; }
        console.log(`${sub === "add" ? "Saved" : "Updated"} '${alias}'. Connect with: enigma ssh ${alias}`);
        return 0;
    }

    if (sub === "remove" || sub === "rm" || sub === "delete") {
        const alias = rest[0];
        if (!alias) { console.error("Usage: enigma ssh remove <alias>"); return 1; }
        if (!ssh.removeConnection(alias)) { console.error(`Unknown connection '${alias}'.`); return 1; }
        console.log(`Removed '${alias}'.`);
        return 0;
    }

    if (sub === "info" || sub === "show") {
        const conn = ssh.getConnection(rest[0] ?? "");
        if (!conn) { console.error(`Unknown connection '${rest[0]}'.`); return 1; }
        console.log(`${conn.alias}: ${ssh.sshTarget(conn)}${conn.port ? `:${conn.port}` : ""}`);
        if (conn.name) console.log(`  name: ${conn.name} (also connects: enigma ssh ${conn.name})`);
        if (conn.identityFile) console.log(`  identity: ${conn.identityFile}`);
        if (conn.password) console.log("  password: (stored, encrypted)");
        if (conn.proxyJump) console.log(`  jump: ${conn.proxyJump}`);
        if (conn.forwardAgent) console.log("  forward-agent: on");
        for (const o of conn.options ?? []) console.log(`  option: ${o}`);
        for (const fwd of conn.forwards ?? []) console.log(`  forward: ${ssh.describeForward(fwd)}`);
        return 0;
    }

    if (sub === "forward" || sub === "fwd") {
        const [op, alias, spec, name] = rest;
        if (!op || !alias) { console.error("Usage: enigma ssh forward <add <alias> SPEC [name] | remove <alias> INDEX | list <alias>>"); return 1; }
        if (op === "list") {
            const conn = ssh.getConnection(alias);
            if (!conn) { console.error(`Unknown connection '${alias}'.`); return 1; }
            (conn.forwards ?? []).forEach((fwd, idx) => console.log(`  [${idx}] ${ssh.describeForward(fwd)}`));
            if (!conn.forwards?.length) console.log("  (no saved forwards)");
            return 0;
        }
        if (op === "add") {
            const pf = spec ? ssh.parseForward(spec) : null;
            if (!pf) { console.error("Bad forward spec. Examples: 8080  9090:8080  9090:dbhost:5432  R:8080:localhost:80  D:1080"); return 1; }
            if (name) pf.name = name;
            const res = ssh.addForward(alias, pf);
            if (!res.ok) { console.error(res.error); return 1; }
            console.log(`Added forward to '${alias}': ${ssh.describeForward(pf)}${name ? ` (run it with: enigma ssh tunnel ${name})` : ""}`);
            return 0;
        }
        if (op === "remove" || op === "rm") {
            const res = ssh.removeForward(alias, Number(spec));
            if (!res.ok) { console.error(res.error); return 1; }
            console.log(`Removed forward [${spec}] from '${alias}'.`);
            return 0;
        }
        console.error("Usage: enigma ssh forward <add <alias> SPEC [name] | remove <alias> INDEX | list <alias>>");
        return 1;
    }

    // Standalone tunnels: named, server-bound, start/stop background port forwards.
    if (sub === "tunnels" || (sub === "tunnel" && ["add", "rm", "remove", "start", "up", "stop", "down", "edit", "list", "status"].includes(rest[0] ?? ""))) {
        const tun = await import("./ssh-tunnels");
        const op = sub === "tunnels" ? "list" : rest[0]!;
        const a = sub === "tunnels" ? rest : rest.slice(1);
        if (op === "list" || op === "status") {
            const list = tun.listTunnels();
            if (!list.length) { console.log("No tunnels yet. Add one:\n  enigma ssh tunnel add <name> <server> <spec>   (e.g. pg lirio-0 9090:5432)"); return 0; }
            console.log("Tunnels:\n");
            for (const t of list) {
                const state = t.active ? "active " : "stopped";
                const where = t.missing ? `${t.server} (missing!)` : `${t.server}`;
                console.log(`  ${(t.active ? "●" : "○")} ${t.name.padEnd(14)} ${state}  ${t.spec.padEnd(22)} -> ${where}`);
            }
            console.log("\nStart: enigma ssh tunnel start <name>    Stop: enigma ssh tunnel stop <name>");
            return 0;
        }
        if (op === "add") {
            const [name, server, spec] = a;
            if (!name || !server || !spec) { console.error("Usage: enigma ssh tunnel add <name> <server> <spec>   (e.g. pg lirio-0 9090:5432)"); return 1; }
            const res = tun.addTunnel(name, server, spec);
            if (!res.ok) { console.error(res.error); return 1; }
            console.log(`Added tunnel '${name}' -> ${server}. Start it: enigma ssh tunnel start ${name}`);
            return 0;
        }
        if (op === "rm" || op === "remove") {
            if (!a[0]) { console.error("Usage: enigma ssh tunnel rm <name>"); return 1; }
            if (!tun.removeTunnel(a[0])) { console.error(`Unknown tunnel '${a[0]}'.`); return 1; }
            console.log(`Removed tunnel '${a[0]}'.`);
            return 0;
        }
        if (op === "edit") {
            const name = a[0];
            if (!name) { console.error("Usage: enigma ssh tunnel edit <name> [--server s] [--spec 9090:5432] [--name newname]"); return 1; }
            const patch: { server?: string; spec?: string; newName?: string } = {};
            for (let i = 1; i < a.length; i++) {
                if (a[i] === "--server") patch.server = a[++i];
                else if (a[i] === "--spec") patch.spec = a[++i];
                else if (a[i] === "--name") patch.newName = a[++i];
            }
            const res = tun.updateTunnel(name, patch);
            if (!res.ok) { console.error(res.error); return 1; }
            console.log(`Updated tunnel '${name}'.`);
            return 0;
        }
        // start/up/stop/down
        if (!a[0]) { console.error(`Usage: enigma ssh tunnel ${op} <name>`); return 1; }
        const res = tun.runTunnelAction(op, a[0]);
        if (!res.ok) { console.error(res.error); return 1; }
        console.log(op === "start" || op === "up" ? `Tunnel '${a[0]}' started in the background.` : `Tunnel '${a[0]}' stopped.`);
        return 0;
    }

    if (sub === "tunnel") {
        const first = rest[0];
        if (!first) { console.error("Usage: enigma ssh tunnel <alias> [name|spec...]  or  enigma ssh tunnel <name>   (opens forwards only, no shell)"); return 1; }
        const conn = ssh.getConnection(first);
        // Shorthand: a first token that is NOT a connection is treated as a saved tunnel's
        // name, looked up across all servers - so `enigma ssh tunnel pg` just works.
        if (!conn) {
            const hit = ssh.findNamedForward(first);
            if (hit === "ambiguous") { console.error(`Several servers have a tunnel named '${first}'. Qualify it: enigma ssh tunnel <server> ${first}`); return 1; }
            if (!hit) { console.error(`No connection or saved tunnel named '${first}'. See: enigma ssh list`); return 1; }
            return connectSsh(ssh, hit.conn.alias, { forwards: [hit.forward], tunnelOnly: true });
        }
        // First token is a connection alias; the rest are its tunnel names or ad-hoc specs
        // (no rest uses all of its saved forwards).
        const forwards: import("./ssh").PortForward[] = [];
        for (const s of rest.slice(1)) {
            const pf = ssh.resolveForwardToken(conn, s);
            if (!pf) { console.error(`No saved tunnel named '${s}' and it is not a valid spec. See: enigma ssh forward list ${first}`); return 1; }
            forwards.push(pf);
        }
        return connectSsh(ssh, first, { forwards: forwards.length ? forwards : undefined, tunnelOnly: true });
    }

    // Anything else is treated as an alias to connect to; args after `--` pass through.
    const dashIdx = args.indexOf("--");
    const extra = dashIdx === -1 ? [] : args.slice(dashIdx + 1);
    return connectSsh(ssh, sub, { extra });
}

/** Resolve a launcher and spawn ssh/sshpass/plink interactively, returning its exit code. */
async function connectSsh(ssh: typeof import("./ssh"), alias: string, opts: import("./ssh").ConnectOpts): Promise<number> {
    const conn = ssh.getConnection(alias);
    if (!conn) { console.error(`Unknown connection '${alias}'. Add it: enigma ssh add ${alias} --host <host>`); return 1; }
    const launcher = ssh.resolveLauncher(conn, opts);
    for (const w of launcher.warnings) console.error(`warning: ${w}`);
    if (launcher.mode === "plain-prompt")
        console.error("note: auto-fill runs from the installed enigma binary, not this dev build - ssh will prompt for the password.");
    const where = opts.tunnelOnly ? "Opening tunnel to" : "Connecting to";
    console.error(`${where} ${alias} (${ssh.sshTarget(conn)})...`);
    return spawnInherit(launcher.command, launcher.args, launcher.env);
}

/**
 * `enigma pack <list|install|remove|update|setup|use|run> [id] [account]`: the marketplace of
 * optional, isolated harness packs. Installing fetches the pack's asset-only npm bundle; launching
 * it (`enigma <pack>` or `enigma pack run <id>`) spawns an agent in a dedicated context that holds
 * only the pack's skills/commands. `use <id> <account|->` pins which account seeds the context.
 */
async function runPackCli(args: string[], passthrough: string[], toolOpt?: string): Promise<number> {
    const [sub, id, value] = args;
    const tool = toolOpt && isToolName(toolOpt) ? toolOpt : DEFAULT_TOOL;
    if (!sub || sub === "list") {
        console.log("Packs (optional isolated harnesses):\n");
        for (const p of listPacks()) {
            const state = p.installed ? (p.version ? `installed ${p.version}` : "installed") : "not installed";
            const acct = p.defaultAccount ? `account ${p.defaultAccount}` : `account ${p.resolvedAccount} (follows active)`;
            console.log(`  ${p.id.padEnd(10)} ${p.label}  [${state}${p.enabled ? ", added" : ""}]`);
            console.log(`             ${p.description}`);
            console.log(`             ${p.tags.join(", ")}  -  ${p.homepage}`);
            console.log(`             seeds with: ${acct}`);
        }
        console.log("\nUse: enigma pack <install|remove|update|setup|use|run> <id>   (or just `enigma <id>` to launch)");
        return 0;
    }
    if (!id || !getPack(id)) { console.error(`Unknown pack '${id ?? ""}'. Known: ${PACKS.map((p) => p.id).join(", ")}.`); return 1; }
    const pack = getPack(id)!;
    switch (sub) {
        case "install": {
            process.stdout.write(`Fetching the ${pack.label} pack (${pack.pkg})...\n`);
            const { ensurePackInstalled } = await import("./packs");
            if (!ensurePackInstalled(id)) { console.error("Could not fetch the pack. Check your network and npm."); return 1; }
            enablePack(id);
            console.log(`${pack.label} added. Launch it with: enigma ${id}`);
            return 0;
        }
        case "remove":
            disablePack(id);
            console.log(`${pack.label} removed (managed files and context deleted).`);
            return 0;
        case "update": {
            if (!isPackInstalled(id)) { console.error(`${pack.label} is not installed. Run: enigma pack install ${id}.`); return 1; }
            const changed = refreshPack(id);
            console.log(changed ? `${pack.label} updated to ${installedPackVersion(id)}.` : `${pack.label} is already up to date.`);
            return 0;
        }
        case "setup": {
            const added = setupPackMcp(id, DEFAULT_TOOL);
            console.log(added.length
                ? `Registered MCP server(s) in the ${pack.label} context: ${added.join(", ")}. They need Python 3 and the pack's tooling on PATH.`
                : `No MCP servers were registered for ${pack.label} (none available, or not supported for ${DEFAULT_TOOL}).`);
            return 0;
        }
        case "use": {
            // `enigma pack use <id> <account>` pins the seeding account; `-`/`none`/`default-follow` clears.
            const { setPackDefaultAccount, getPackAccount } = await import("./packs");
            if (!value) {
                const cur = getPackAccount(id, tool);
                console.log(cur ? `${pack.label} (${tool}) seeds with account '${cur}'.` : `${pack.label} (${tool}) follows the active profile/account. Set one: enigma pack use ${id} <account>.`);
                return 0;
            }
            const clear = value === "-" || value === "none";
            try { setPackDefaultAccount(id, tool, clear ? null : value); }
            catch (e) { console.error((e as Error).message); return 1; }
            console.log(clear ? `${pack.label} (${tool}) now follows the active profile/account.` : `${pack.label} (${tool}) will seed with account '${value}'.`);
            return 0;
        }
        case "run":
            return launchPack(id, tool, passthrough, value);
        default:
            console.error(`Unknown subcommand '${sub}'. Use: enigma pack <list|install|remove|update|setup|use|run> <id>.`);
            return 1;
    }
}

/**
 * `enigma recall [status|sync|search|list|show|context|clear]`: the local session-memory
 * store built from coding-agent transcripts. `sync` reads transcripts into the store; the
 * other subcommands query it. Reading transcripts is the consent action, so `sync` reports
 * what it scanned and where data lives.
 */
async function runRecallCli(args: string[]): Promise<number> {
    const recall = await import("./recall");
    if (!recall.recallAvailable()) {
        console.error("recall needs the enigma binary (bun:sqlite is unavailable under Node).");
        return 1;
    }
    const useColor = !("NO_COLOR" in process.env) && (process.stdout.isTTY || "FORCE_COLOR" in process.env);
    const sgr = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
    const bold = (s: string): string => sgr("1", s), dim = (s: string): string => sgr("2", s), cyan = (s: string): string => sgr("36", s);
    const [sub, ...rest] = args;

    if (!sub || sub === "status") {
        const st = recall.recallStatus();
        const s = st.stats!;
        console.log(`\n  ${bold("recall")}  ${dim("local session memory")}`);
        console.log(`  observations ${cyan(String(s.observations))}   sessions ${cyan(String(s.sessions))}   projects ${cyan(String(s.projects))}   ${dim(`${Math.round(s.dbBytes / 1024)} KB`)}`);
        if (st.lastSync) console.log(`  last sync ${dim(new Date(st.lastSync).toLocaleString())}`);
        const types = Object.entries(s.byType).map(([t, n]) => `${t} ${n}`).join("   ");
        if (types) console.log(`  ${dim(types)}`);
        if (!s.observations) console.log(`\n  ${dim("Empty. Build it with:")} ${cyan("enigma recall sync")}`);
        console.log("");
        return 0;
    }
    if (sub === "sync") {
        console.log(dim("  Reading local session transcripts..."));
        const r = recall.syncRecall();
        console.log(`  scanned ${cyan(String(r.scanned))}   changed ${cyan(String(r.changed))}   +${cyan(String(r.observations))} observations from ${cyan(String(r.sessions))} sessions`);
        console.log(dim("  Stored locally; never leaves this machine."));
        const en = await recall.enrichRecall({ force: true });
        if (en.enabled && en.hasLogin) console.log(`  enriched ${cyan(String(en.observations))} observations in ${cyan(String(en.sessions))} sessions (LLM)`);
        else if (en.enabled) console.log(dim("  LLM enrichment is on but no local Claude login was found; kept deterministic."));
        return 0;
    }
    if (sub === "enrich") {
        const en = await recall.enrichRecall({ force: true, maxSessions: Number(rest[0]) || 8 });
        if (!en.enabled) { console.log(dim("  LLM enrichment is off. Turn it on: enigma config recall-llm on")); return 0; }
        if (!en.hasLogin) { console.error("  No local Claude login found (log in with `enigma claude` or Claude Code)."); return 1; }
        console.log(`  Enriched ${cyan(String(en.observations))} observations across ${cyan(String(en.sessions))} sessions.`);
        return 0;
    }
    if (sub === "search") {
        const query = rest.join(" ").trim();
        if (!query) { console.error("Usage: enigma recall search <query>"); return 1; }
        const hits = recall.searchRecall(query, { limit: 20 });
        if (!hits.length) { console.log(dim("  No matches.")); return 0; }
        for (const o of hits) {
            const files = o.filesModified.length ? dim(`  (${o.filesModified.slice(0, 3).join(", ")})`) : "";
            console.log(`  ${dim(`#${o.id}`)} ${cyan(o.type.padEnd(9))} ${o.title}${files}`);
        }
        return 0;
    }
    if (sub === "list") {
        const project = rest[0];
        const hits = recall.recentObservations({ project, limit: 25 });
        if (!hits.length) { console.log(dim("  Nothing recorded yet.")); return 0; }
        for (const o of hits) console.log(`  ${dim(`#${o.id}`)} ${dim(new Date(o.createdAt).toISOString().slice(0, 10))} ${cyan(o.type.padEnd(9))} ${o.title}  ${dim(o.project)}`);
        return 0;
    }
    if (sub === "show") {
        const ids = rest.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (!ids.length) { console.error("Usage: enigma recall show <id> [id...]"); return 1; }
        for (const o of recall.getObservations(ids)) {
            console.log(`\n  ${bold(`#${o.id}`)} ${cyan(o.type)}  ${o.title}`);
            if (o.subtitle) console.log(`  ${dim(o.subtitle)}`);
            if (o.narrative) console.log(`  ${o.narrative}`);
            if (o.facts.length) console.log(`  ${dim(`facts: ${o.facts.join("; ")}`)}`);
            if (o.filesModified.length) console.log(`  ${dim(`modified: ${o.filesModified.join(", ")}`)}`);
            console.log(`  ${dim(`${o.project} - ${new Date(o.createdAt).toLocaleString()}`)}`);
        }
        console.log("");
        return 0;
    }
    if (sub === "context") {
        const text = recall.recallContext({ project: rest[0], limit: 20 });
        console.log(text || dim("  No memory for this project yet."));
        return 0;
    }
    if (sub === "timeline") {
        const id = Number(rest[0]);
        if (!Number.isInteger(id) || id <= 0) { console.error("Usage: enigma recall timeline <id>"); return 1; }
        const rows = recall.recallTimeline({ id });
        if (!rows.length) { console.log(dim("  No timeline for that observation.")); return 0; }
        for (const o of rows) {
            const marker = o.id === id ? cyan(">") : " ";
            console.log(`  ${marker} ${dim(`#${o.id}`)} ${dim(new Date(o.createdAt).toISOString().slice(0, 16).replace("T", " "))} ${o.type.padEnd(9)} ${o.title}`);
        }
        return 0;
    }
    if (sub === "sessions") {
        const sessions = recall.recallSessions({ project: rest[0], limit: 30 });
        if (!sessions.length) { console.log(dim("  No sessions recorded yet.")); return 0; }
        for (const s of sessions) console.log(`  ${dim(new Date(s.endedAt).toISOString().slice(0, 10))} ${cyan(String(s.observations).padStart(3))} obs  ${s.title || dim("(session)")}  ${dim(s.project)}`);
        return 0;
    }
    if (sub === "prune") {
        const opts = rest[0] === "days" ? { maxAgeDays: Number(rest[1]) } : { maxRows: Number(rest[0]) };
        const target = "maxAgeDays" in opts ? opts.maxAgeDays : opts.maxRows;
        if (!Number.isFinite(target) || (target ?? 0) <= 0) { console.error("Usage: enigma recall prune <maxRows> | enigma recall prune days <n>"); return 1; }
        const deleted = recall.pruneRecall(opts);
        console.log(`  Pruned ${cyan(String(deleted))} observation${deleted === 1 ? "" : "s"}.`);
        return 0;
    }
    if (sub === "clear") {
        recall.resetRecall();
        console.log("  Recall store cleared.");
        return 0;
    }
    console.error(`Unknown subcommand '${sub}'. Use: enigma recall <status | sync | search <q> | list | show <id> | timeline <id> | sessions | context | enrich | prune <n> | clear>`);
    return 1;
}

/**
 * `enigma codegraph <status|on|off|index [path]|projects|arch [project]|search <name>>`: the native
 * code graph. `on`/`off` toggle the setting (and (de)register the enigma MCP server that exposes the
 * tools); `index` builds the graph for a project; `projects`/`arch`/`search` read it. No external tool.
 */
async function runCodeGraphCli(args: string[]): Promise<number> {
    const cg = await import("./codegraph");
    const { setEnigmaToggle } = await import("./config");
    const { applyMcpToggle } = await import("./mcp-deploy");
    const [sub, ...rest] = args;
    if (!sub || sub === "status") {
        const st = cg.codeGraphStatus();
        console.log("\n  codebase memory (code graph)  -  native, no external dependency");
        console.log(`  tools ${st.enabled ? "on" : "off"}   indexed projects ${st.projects}`);
        if (!st.enabled) console.log("  Enable: enigma codegraph on");
        else console.log("  Index this project: enigma codegraph index");
        console.log("");
        return 0;
    }
    if (sub === "on" || sub === "enable") {
        setEnigmaToggle("codeGraph", true, "global");
        applyMcpToggle("global");
        console.log("  Code graph enabled - tools exposed to your agents over MCP (restart them to load it).");
        return 0;
    }
    if (sub === "off" || sub === "disable") {
        setEnigmaToggle("codeGraph", false, "global");
        applyMcpToggle("global");
        console.log("  Code graph disabled.");
        return 0;
    }
    if (sub === "index") {
        const entry = cg.indexProject(rest[0]);
        console.log(`  Indexed ${entry.name}: ${entry.files} files, ${entry.symbols} symbols.`);
        return 0;
    }
    if (sub === "projects") {
        const ps = cg.listProjects();
        if (!ps.length) { console.log("  No projects indexed yet. Run: enigma codegraph index"); return 0; }
        for (const p of ps) console.log(`  ${p.name}  ${p.files} files, ${p.symbols} symbols  ${p.root}`);
        return 0;
    }
    if (sub === "arch" || sub === "architecture") {
        const a = cg.codeGraphArchitecture(rest[0]);
        if (!a) { console.error("  No project indexed yet. Run: enigma codegraph index"); return 1; }
        console.log(JSON.stringify(a, null, 2));
        return 0;
    }
    if (sub === "search") {
        const name = rest.join(" ").trim();
        if (!name) { console.error("Usage: enigma codegraph search <name>"); return 1; }
        const hits = cg.searchGraph(undefined, { name, limit: 40 });
        if (!hits.length) { console.log("  No matches (is the project indexed? run: enigma codegraph index)"); return 0; }
        for (const h of hits) console.log(`  ${h.kind.padEnd(10)} ${h.name}  ${h.file}:${h.line}`);
        return 0;
    }
    console.error(`Unknown subcommand '${sub}'. Use: enigma codegraph <status | on | off | index [path] | projects | arch [project] | search <name>>`);
    return 1;
}

/**
 * `enigma autoskills [path]`: detect the project's tech stack and install the matching
 * agent skills (separate from enigma's own policy skills). `--dry-run` only reports.
 */
async function runAutoskillsCli(opts: CliOptions, interactive: boolean): Promise<number> {
    const { detectTechnologies, collectSkills, detectAgents } = await import("./autoskills");
    const projectDir = resolve(opts.positionals[0] ?? process.cwd());

    // ANSI styling (NO_COLOR-aware; ASCII only, no emojis per the engineering policy).
    const useColor = !("NO_COLOR" in process.env) && (process.stdout.isTTY || "FORCE_COLOR" in process.env);
    const sgr = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
    const bold = (s: string): string => sgr("1", s), dim = (s: string): string => sgr("2", s);
    const cyan = (s: string): string => sgr("36", s), green = (s: string): string => sgr("32", s);
    const red = (s: string): string => sgr("31", s), amber = (s: string): string => sgr("38;5;172", s);
    const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));

    const result = detectTechnologies(projectDir);
    console.log(`\n  ${amber(bold("autoskills"))}${dim(`  ${projectDir}`)}`);

    if (result.detected.length === 0 && !result.isFrontend) {
        console.log(`\n  ${dim("No supported technologies detected. Run this inside a project directory.")}\n`);
        return 0;
    }

    // Detected technologies in 3 columns; those with skills brighter than those without.
    const techs = [...result.detected].sort((a, b) => Number(b.skills.length > 0) - Number(a.skills.length > 0));
    console.log(`\n  ${bold("Detected technologies")}`);
    const colW = Math.max(0, ...techs.map((t) => t.name.length)) + 4;
    for (let i = 0; i < techs.length; i += 3) {
        const row = techs.slice(i, i + 3).map((t) => (t.skills.length > 0 ? cyan(pad(t.name, colW)) : dim(pad(t.name, colW)))).join("");
        console.log(`    ${row.trimEnd()}`);
    }
    if (result.isFrontend) console.log(`  ${dim("Web frontend - adds design, accessibility and SEO skills")}`);
    if (result.combos.length) {
        console.log(`\n  ${bold("Combos")}`);
        for (const combo of result.combos) console.log(`    ${cyan(combo.name)}`);
    }

    const skills = collectSkills(result);
    if (skills.length === 0) { console.log(`\n  ${dim("No skills available for this stack yet.")}\n`); return 0; }

    console.log(`\n  ${bold("Skills to install")}${dim(` (${skills.length})`)}`);
    const refW = Math.max(...skills.map((s) => s.skill.length));
    skills.forEach((s, i) => {
        const parts = s.skill.split("/");
        const ref = parts.length === 3 ? dim(`${parts.slice(0, 2).join("/")}/`) + cyan(parts[2]) : cyan(s.skill);
        const gap = " ".repeat(refW - s.skill.length + 2);
        console.log(`    ${dim(`${String(i + 1).padStart(2)}.`)} ${ref}${gap}${dim(s.sources.join(", "))}`);
    });

    if (opts.dryRun) { console.log(`\n  ${dim("--dry-run: nothing was installed.")}\n`); return 0; }

    const agents = opts.agents.length ? opts.agents : detectAgents();
    console.log(`\n  ${dim(`Installing into: ${agents.join(", ")}`)}`);
    const { installStackSkills } = await import("./autoskills-install");
    const res = await installStackSkills(skills, projectDir, agents, { yes: opts.yes, interactive });
    const tail = res.failed ? red(`${res.failed} failed`) : dim("0 failed");
    console.log(`\n  ${green(`${res.installed} installed`)}${dim(`, ${res.skipped} skipped, `)}${tail}\n`);
    if (res.errors.length) for (const e of res.errors) console.error(`  ${red("!")} ${dim(e)}`);
    return res.failed > 0 ? 1 : 0;
}

/**
 * `enigma account <subcommand>` surface. Wraps the accounts data layer with
 * prompting/printing (the data layer stays UI-free). Returns a process exit code.
 */
/** A reusable Claude login (an account dir or a pack context), for `account sessions`/`transfer`. */
interface ClaudeSessionSource { id: string; label: string; dir: string; email?: string; state: SessionState; usable: boolean; }

/**
 * Every Claude session that can seed another account without a re-login: each Claude account dir
 * plus every pack context holding a credentials file. Ordered healthiest-first (usable before
 * unusable, `ok` before `refreshable`) so an auto-picked transfer source is the best available.
 */
function claudeSessionSources(): ClaudeSessionSource[] {
    const rows: ClaudeSessionSource[] = listAccounts("claude").map((a) => {
        const state = sessionState(a.dir);
        return { id: `account:${a.name}`, label: a.name, dir: a.dir, email: a.email ?? sessionEmail(a.dir), state, usable: isUsableSession(state) };
    });
    for (const s of packSessionSources("claude")) {
        const state = sessionState(s.dir);
        rows.push({ id: `pack:${s.id}`, label: `pack ${s.label}`, dir: s.dir, email: sessionEmail(s.dir), state, usable: isUsableSession(state) });
    }
    const rank = (s: ClaudeSessionSource): number => (s.usable ? (s.state === "ok" ? 0 : 1) : 2);
    return rows.sort((a, b) => rank(a) - rank(b));
}

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
                if (a.provider) {
                    const label = a.provider.preset && a.provider.preset !== "custom" ? a.provider.preset : a.provider.baseUrl;
                    console.log(`     provider: ${label}${a.provider.model ? ` (${a.provider.model})` : ""}`);
                }
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
        case "provider": {
            const presets = presetsForTool(tool);
            if (!presets.length && !getTool(tool).providerEnv) { console.error(`${spec.label} does not support a provider override.`); return 1; }
            if (!name) {
                console.error("Usage: enigma account provider <name> [--preset <id> | --base <url> [--model <id>]] [--token <key>] [--clear]");
                if (presets.length) console.error(`Presets for ${tool}: ${presets.map((pr) => pr.id).join(", ")}.`);
                return 1;
            }
            try {
                // No mutating flag -> show the current override.
                if (!opts.preset && !opts.base && opts.token === null && !opts.clear && !opts.providerModel) {
                    const prov = getAccountProvider(tool, name);
                    if (!prov) { console.log(`'${name}' uses ${spec.label}'s default backend (Anthropic).`); return 0; }
                    console.log(`'${name}' provider:`);
                    console.log(`  base   ${prov.baseUrl}`);
                    if (prov.model) console.log(`  model  ${prov.model}`);
                    if (prov.preset) console.log(`  preset ${prov.preset}`);
                    console.log(`  token  ${prov.hasToken ? "set (encrypted)" : "not set"}`);
                    return 0;
                }
                if (opts.clear) {
                    setAccountProvider(tool, name, null);
                    console.log(`Cleared the provider override for '${name}' (back to ${spec.label}'s default).`);
                    return 0;
                }
                let input: ProviderInput | null = null;
                if (opts.preset) {
                    input = providerFromPreset(opts.preset, opts.token ?? undefined);
                    if (!input) { console.error(`Unknown preset '${opts.preset}'. Available: ${presets.map((pr) => pr.id).join(", ") || "(none)"}.`); return 1; }
                    if (opts.base) input.baseUrl = opts.base;
                    if (opts.providerModel) input.model = opts.providerModel;
                } else if (opts.base) {
                    input = { baseUrl: opts.base, model: opts.providerModel ?? undefined, preset: "custom", token: opts.token ?? undefined };
                } else {
                    // Only a token/model given: update an existing override in place.
                    const cur = getAccountProvider(tool, name);
                    if (!cur) { console.error("Set a provider first with --preset <id> or --base <url>."); return 1; }
                    input = { baseUrl: cur.baseUrl, model: opts.providerModel ?? cur.model, env: cur.env, preset: cur.preset, token: opts.token ?? undefined };
                }
                setAccountProvider(tool, name, input);
                const label = input.preset && input.preset !== "custom" ? input.preset : input.baseUrl;
                console.log(`'${name}' now uses ${label}${opts.token ? " (token set)" : ""}. Launch it with: enigma ${tool} ${name}.`);
                return 0;
            } catch (err) { console.error((err as Error).message); return 1; }
        }
        case "sessions": {
            if (tool !== "claude") { console.error("Session reuse is Claude-only."); return 1; }
            const rows = claudeSessionSources();
            console.log("Claude sessions (reusable logins):\n");
            for (const s of rows) {
                console.log(` ${s.usable ? "*" : " "} ${s.id.padEnd(22)} ${(s.email ?? "(no identity)").padEnd(30)} ${s.state}`);
                console.log(`     ${s.dir}`);
            }
            console.log("\nReuse one with: enigma account transfer <target> [source-id].");
            return 0;
        }
        case "transfer": {
            // Reuse a live login: copy a session (another account or a pack context) into a
            // signed-out account so it works again without /login. Claude-only.
            if (tool !== "claude") { console.error("Session transfer is Claude-only."); return 1; }
            if (!name) { console.error("Usage: enigma account transfer <target-account> [source-id]"); return 1; }
            let targetDir: string;
            try { targetDir = resolveConfigDir(tool, name); } catch (err) { console.error((err as Error).message); return 1; }
            const sources = claudeSessionSources().filter((s) => s.dir !== targetDir);
            const explicit = opts.positionals[2];
            let src: ClaudeSessionSource | undefined;
            if (explicit) {
                src = sources.find((s) => s.id === explicit || s.id === `account:${explicit}` || s.id === `pack:${explicit}` || s.label === explicit);
                if (!src) { console.error(`Unknown session source '${explicit}'. List them with: enigma account sessions.`); return 1; }
                if (!src.usable) { console.error(`Source '${src.id}' has no usable session (${src.state}).`); return 1; }
            } else {
                src = sources.find((s) => s.usable);
                if (!src) { console.error("No other logged-in Claude session to reuse. Log in once (or run a pack), then retry."); return 1; }
            }
            const res = transferSession(src.dir, targetDir);
            if (!res.ok) { console.error(`Transfer failed: ${res.error}`); return 1; }
            console.log(`Moved the '${src.label}' session into '${name}' - signed in now (shared login, no re-login).`);
            console.log(`Launch it with: enigma ${tool} ${name}.`);
            return 0;
        }
        default:
            console.error(`Unknown account subcommand: ${sub}. Try: list, add, use, login, run, rename, remove, provider, sessions, transfer.`);
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
    const [sub, name, agent] = opts.positionals;
    switch (sub) {
        case undefined:
        case "list":
        case "ls": {
            console.log("Skills:\n");
            for (const s of listSkillsStatus()) {
                const ver = s.version ? `v${s.version}` : "";
                const state = s.discarded ? "discarded" : s.agentsOff.length ? `off for ${s.agentsOff.join(", ")}` : "active";
                console.log(` ${s.discarded ? "-" : s.agentsOff.length ? "~" : "*"} ${s.name.padEnd(26)} ${ver.padEnd(8)} ${state}`);
            }
            console.log("\nDiscard removes a skill from every agent; per-agent off keeps it elsewhere.");
            console.log("Manage with: enigma skills <disable|enable> <name> [agent].");
            return 0;
        }
        case "discard":
        case "restore":
        case "disable":
        case "enable": {
            if (!name) { console.error(`Usage: enigma skills ${sub} <name> [agent]`); return 1; }
            const skill = listSkillsStatus().find((s) => s.name === name);
            if (!skill) { console.error(`Unknown skill '${name}'. See: enigma skills list.`); return 1; }
            const off = sub === "discard" || sub === "disable";

            // With an agent argument: per-agent opt-out. Without: the global discard.
            if (agent) {
                if (!isToolName(agent)) { console.error(`Unknown agent '${agent}'. Use one of: ${TOOL_NAMES.join(", ")}.`); return 1; }
                if (skill.discarded) { console.log(`Skill '${name}' is globally discarded; restore it first (enigma skills enable ${name}).`); return 0; }
                const already = skill.agentsOff.includes(agent);
                if (already === off) { console.log(`Skill '${name}' is already ${off ? "off" : "on"} for ${agent}.`); return 0; }
                for (const notice of setSkillAgent(name, agent, off)) console.log(`Synced ${notice}.`);
                console.log(`Skill '${name}' is now ${off ? "off" : "on"} for ${agent} (${off ? "removed from" : "deployed to"} that agent).`);
                return 0;
            }

            if (skill.discarded === off) { console.log(`Skill '${name}' is already ${off ? "discarded" : "active"}.`); return 0; }
            for (const notice of discardSkill(name, off)) console.log(`Synced ${notice}.`);
            console.log(off
                ? `Skill '${name}' discarded: removed from every agent and skipped by future installs and updates.`
                : `Skill '${name}' restored: it deploys again on installs and syncs.`);
            return 0;
        }
        default:
            console.error(`Unknown skills subcommand: ${sub}. Try: list, disable, enable [agent].`);
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
 * The command to tunnel this dashboard to the operator's own machine. Preferred over exposing
 * it: the port stays on loopback, and SSH already authenticates whoever reaches it.
 */
function sshTunnelHint(port: number): string {
    const user = (() => { try { return userInfo().username; } catch { return "user"; } })();
    return `ssh -N -L ${port}:127.0.0.1:${port} ${user}@${hostname()}`;
}

/**
 * Decide how a headless host should serve the dashboard. Returns the bind to use for this run,
 * or null to let the configured bind stand.
 *
 * Only asked when there is no browser to open, someone is there to answer, and the config does
 * not already settle it: a scripted or daemonized run must never block on a prompt, and never
 * silently start exposing itself. "Always" persists the choice, which is what stops the asking.
 *
 * Every answer is returned as an explicit bind rather than null, because null falls through to
 * the configured bind - so answering "keep it local" once "always" had been persisted would
 * otherwise still expose the host, silently ignoring the choice just made.
 */
async function resolveHeadlessBind(expose: boolean): Promise<DashboardBind | null> {
    if (expose) return "lan";
    if (!isHeadless() || !process.stdin.isTTY) return null;
    // Already told how to bind: honour it instead of asking the same question every run.
    // Validated the way resolveBind validates it, so an unrecognized value still gets asked
    // about rather than being read as a decision the user never made.
    const configured = readConfig().config.dashboardBind;
    if (DASHBOARD_BINDS.includes(configured) && configured !== "loopback") return null;
    const choice = await p.select({
        message: "No browser on this host. How should the dashboard be reachable?",
        initialValue: "local",
        options: [
            { value: "local", label: "Keep it local", hint: "reach it over an SSH tunnel (recommended)" },
            { value: "once", label: "Expose it on the network - just this once", hint: "requires a token" },
            { value: "always", label: "Expose it on the network - always", hint: "requires a token; remembered" },
        ],
    });
    if (p.isCancel(choice) || choice === "local") return "loopback";
    if (choice === "always") setEnigmaValue("dashboardBind", "lan", "global");
    return "lan";
}

/**
 * `enigma dashboard` (alias `dash`): serve the local savings dashboard and open it in
 * the browser. On-demand by default - the server lives only while this command runs, so
 * it costs nothing when closed. In "always" mode it just opens the running daemon. Blocks
 * until Ctrl+C. The dashboard config setting governs the daemon, not this command, which
 * always works on request.
 *
 * With no browser (a server over SSH) it prints the tunnel command instead, and offers to
 * expose the dashboard on the network - which always requires a token, since it can run
 * agents with your credentials.
 */
async function runDashboardCli(version: string, opts: CliOptions): Promise<number> {
    const mode = readConfig().config.dashboard;
    if (opts.positionals[0] === "token") return runDashboardTokenCli(opts);
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
    // The bind comes from the global config only, so a repo asking for one is dropped. Say it
    // rather than leaving the user to wonder why their setting had no effect.
    if (repoBindOverrideIgnored()) console.error("Note: this project's .enigma.json sets dashboard-bind; it is ignored (the bind is a per-machine setting, so repo content cannot open a port here). Use 'enigma config dashboard-bind <mode> -g'.");
    // A background dashboard that failed to start leaves its reason behind; surface it here,
    // since the daemon itself is detached with nowhere to print.
    const failure = daemonError();
    if (failure && mode === "always") console.error(`Note: the background dashboard is not running: ${failure}`);
    // Only one dashboard at a time: if one is already serving (the "always" daemon OR
    // another foreground `enigma dashboard`), open its URL instead of starting a second
    // server on a different port. Stale records are cleaned by runningDaemon().
    const running = runningDaemon();
    if (running) {
        // A live server cannot move to another interface, so --expose cannot be honoured here.
        // Say so instead of printing a loopback URL and exiting 0: with `dashboard: always`
        // (the documented server setup) that silently did nothing at all, which is the exact
        // case --expose exists for.
        if (opts.expose) {
            console.error(`A dashboard is already running on ${running.url} and a running server cannot rebind.`);
            console.error("Stop it first (Ctrl+C, or 'enigma config dashboard off' for the background one), then run 'enigma dashboard --expose'.");
            console.error("To expose it permanently instead: 'enigma config dashboard-bind lan', then restart it.");
            return 1;
        }
        const tag = mode === "always" ? "(always) " : "";
        // A daemon on an exposed bind is only reachable with its token, so print that link.
        let token: string | null = null;
        try { token = resolveBind().token; } catch { /* misconfigured bind: it is not serving anyway */ }
        console.log(`enigma dashboard already running ${tag}-> ${tokenizedUrl(running.url, token)}`);
        // The tokenized URL, or a browser here lands on the "needs a token" banner. The
        // fragment never reaches the server, so this is the same link that was printed.
        openUrl(tokenizedUrl(running.url, token));
        return 0;
    }
    // Ask before binding, not after: the answer decides which interface we listen on.
    const bindOverride = await resolveHeadlessBind(opts.expose);
    // Exposing is only ever allowed with a token, so mint one now rather than letting the
    // server refuse to start on a choice the user just made.
    if (bindOverride && bindOverride !== "loopback") ensureDashboardToken();
    let server: Awaited<ReturnType<typeof startDashboardServer>>;
    try { server = await startDashboardServer(version, bindOverride ?? undefined); }
    catch (err) { console.error(`Could not start the dashboard: ${(err as Error).message}`); return 1; }
    // Publish a record of this foreground server so a second invocation finds it and
    // defers instead of spawning another. Cleared on exit (and self-healed if we crash).
    writeDaemon({ pid: process.pid, port: server.port, url: server.url, startedAt: Date.now() });
    if (server.bind.token) {
        // The tokenized URL is the only way in, and on a headless host the terminal is the
        // only channel we have to deliver it.
        console.log(`enigma dashboard -> ${tokenizedUrl(server.url, server.bind.token)}`);
        console.log(`Bound to ${server.bind.host}:${server.port}. That link grants full control of this machine - treat it as a password.`);
    } else {
        console.log(`enigma dashboard -> ${server.url}`);
        if (isHeadless()) console.log(`No browser here. Reach it from your machine with:\n  ${sshTunnelHint(server.port)}\nthen open http://localhost:${server.port}`);
    }
    console.log("Press Ctrl+C to stop.");
    openUrl(tokenizedUrl(server.url, server.bind.token));
    return await new Promise<number>((resolveExit) => {
        const stop = (): void => { clearDaemon(); server.close(); resolveExit(0); };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
}

/**
 * `enigma dashboard token [--new]`: print the token an exposed dashboard requires, so it can
 * be recovered without digging the file out by hand, or rotated to revoke every link already
 * handed out. Printing beats `cat`-ing the file: this is the only supported way to read it.
 */
function runDashboardTokenCli(opts: CliOptions): number {
    const rotate = opts.newToken;
    if (!rotate && !readDashboardToken()) {
        console.log("No dashboard token set. One is minted when you expose the dashboard (`enigma dashboard --expose`), or now with `enigma dashboard token --new`.");
        return 0;
    }
    const token = ensureDashboardToken(rotate);
    if (rotate) console.log("Rotated. Every link handed out earlier is now dead.");
    console.log(token);
    console.log(`\nAppend it as a URL fragment to log in:  http://${hostname()}:<port>/#token=<the token above>`);
    return 0;
}

/**
 * `enigma api`: serve the local OpenAI-compatible API for Claude Code. Every request
 * spawns the local `claude` CLI in headless mode, so all of its capabilities (tools,
 * skills, MCP, sessions, the user's auth) are reachable from any OpenAI client library.
 * Loopback-bound. Blocks until Ctrl+C. Port comes from --port, else the apiPort config
 * (default 8000); an optional key from --api-key or ENIGMA_API_KEY gates every /v1 route.
 */
async function runApiCli(opts: CliOptions): Promise<number> {
    const cfg = readConfig().config;
    const port = opts.port && opts.port > 0 ? opts.port : cfg.apiPort || 8000;
    const apiKey = opts.apiKey ?? process.env.ENIGMA_API_KEY ?? null;
    const tool = opts.tool || "claude";
    const { startApiServer } = await import("./api-server");
    const { availableAdapters } = await import("./api-agents");
    // Per-run flags win; otherwise fall back to the persisted defaults (settable from the dashboard).
    const account = opts.apiAccount ?? (cfg.apiAccount || null);
    const profile = opts.apiProfile ?? (cfg.apiProfile || null);
    const pack = opts.apiPack ?? (cfg.apiPack || null);
    let server: Awaited<ReturnType<typeof startApiServer>>;
    try { server = await startApiServer({ port, apiKey, tool, account, profile, pack }); }
    catch (err) { console.error(`Could not start the API server: ${(err as Error).message}`); return 1; }
    const agents = availableAdapters().map((a) => a.tool);
    console.log(`enigma api (default ${tool}) -> ${server.url}`);
    console.log(`OpenAI base URL: ${server.url}/v1${apiKey ? "  (Authorization: Bearer <key> required)" : "  (no auth - loopback only)"}`);
    console.log(`Backends available: ${agents.length ? agents.join(", ") : "(none installed)"} - pick one per request via the model field (e.g. "claude-sonnet-5", "codex", "opencode").`);
    const ctx = [pack && `pack ${pack}`, account && `account ${account}`, profile && `profile ${profile}`].filter(Boolean).join(", ");
    console.log(ctx ? `Default context: ${ctx} (override per request with account/profile/pack in the body).` : "Context: active account (override per request with account/profile/pack in the body).");
    console.log("Press Ctrl+C to stop.");
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
    // Hidden: invoked by OpenSSH as SSH_ASKPASS to auto-supply a saved connection's password
    // (enigma ssh <alias> with a stored password). Must be first and silent - stdout is the
    // password channel ssh reads. Reads the alias from ENIGMA_SSH_ASKPASS_ALIAS.
    if (process.env.ENIGMA_ASKPASS === "1") {
        const { emitAskpass } = await import("./ssh");
        emitAskpass();
        return;
    }
    // Hidden: the detached gate daemon. Its detached re-exec carries
    // ENIGMA_GATE_DAEMON=1 (the compiled binary runs with no argv, dev re-runs
    // the script), so detect the marker first and hand off to the daemon. Delete
    // the marker immediately so daemon-spawned children never re-enter daemon mode.
    if (process.env.ENIGMA_GATE_DAEMON === "1") {
        delete process.env.ENIGMA_GATE_DAEMON;
        const { run: runGateDaemon } = await import("./gate/daemon/daemon");
        await runGateDaemon();
        return;
    }
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
    // Hidden: the gate post-receive hook invokes this to notify the daemon of a
    // push. Non-blocking by the hook's contract; must not print to stdout noise.
    if (argv[0] === "__gate-notify") {
        const { runGateNotify } = await import("./gate/cli");
        await runGateNotify(argv.slice(1));
        return;
    }
    // The gate subsystem (init/status/runs/rerun/doctor/eject/daemon/axi). Dispatched
    // early by argv so the gate's own flags never reach enigma's argument parser.
    if (argv[0] === "gate") {
        const { runGateCli } = await import("./gate/cli");
        process.exit(await runGateCli(argv.slice(1)));
    }
    // SSH connection manager. Dispatched early by argv so its rich flags (--host, -i,
    // -L 9090:db:5432, ...) never reach enigma's own argument parser.
    if (argv[0] === "ssh") { process.exit(await runSshCli(argv.slice(1), Boolean(process.stdout.isTTY))); }
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
    // Pack shortcut: `enigma helio [account] [--tool <t>] [-- args]` launches the pack's
    // isolated agent, seeding the chosen account's login (default: the pack's pinned account,
    // else the active profile / tool-active account).
    if (opts.command && getPack(opts.command)) {
        const tool = opts.tool && isToolName(opts.tool) ? opts.tool : DEFAULT_TOOL;
        process.exit(await launchPack(opts.command, tool, opts.passthrough, opts.positionals[0]));
    }
    if (opts.command === "pack" || opts.command === "packs") { process.exit(await runPackCli(opts.positionals, opts.passthrough, opts.tool)); }
    if (opts.command === "account") { process.exit(await runAccountCli(opts, interactive)); }
    if (opts.command === "profile") { process.exit(await runProfileCli(opts, interactive)); }
    if (opts.command === "skills") { process.exit(runSkillsCli(opts)); }
    if (opts.command === "issue") { process.exit(await runIssueCli(opts.positionals[0], version, interactive)); }
    if (opts.command === "compress") { process.exit(runCompressCli(opts)); }
    if (opts.command === "dashboard") { process.exit(await runDashboardCli(version, opts)); }
    if (opts.command === "fix-path") { process.exit(runFixPathCli(opts.positionals[0], opts.scope)); }
    if (opts.command === "resources") { process.exit(await runResourcesCli(opts.positionals)); }
    if (opts.command === "recall") { process.exit(await runRecallCli(opts.positionals)); }
    if (opts.command === "codegraph") { process.exit(await runCodeGraphCli(opts.positionals)); }
    if (opts.command === "autoskills") { process.exit(await runAutoskillsCli(opts, interactive)); }
    if (opts.command === "api") { process.exit(await runApiCli(opts)); }

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
                supportsProvider: a.supportsProvider,
                provider: a.provider ? { baseUrl: a.provider.baseUrl, model: a.provider.model, preset: a.provider.preset, hasToken: a.provider.hasToken } : null,
            })));
    const hubProfiles = (): HubProfile[] =>
        listProfiles().map((p) => ({
            name: p.name, active: p.active,
            summary: Object.entries(p.accounts).map(([t, a]) => `${t}=${a}`).join("  ") || "(no accounts pinned)",
        }));
    const hubSkills = (): HubSkill[] =>
        listSkillsStatus().map((s) => ({ name: s.name, version: s.version, discarded: s.discarded, agentsOff: s.agentsOff }));
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
        setSkillAgent: (name: string, agent: string, off: boolean) => { setSkillAgent(name, agent, off); return hubSkills(); },
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
        providerPresets: PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, tool: p.tool, baseUrl: p.baseUrl, model: p.model, tokenUrl: p.tokenUrl })),
        setAccountProvider: (tool: string, name: string, input: { baseUrl: string; model?: string; preset?: string; token?: string } | null) => {
            try {
                let resolved: ProviderInput | null = input;
                // A real preset id fills baseUrl/model/env; "custom" (and null) pass through as-is.
                if (input && input.preset && input.preset !== "custom") {
                    const fromPreset = providerFromPreset(input.preset, input.token);
                    if (!fromPreset) throw new Error(`Unknown preset '${input.preset}'.`);
                    if (input.baseUrl) fromPreset.baseUrl = input.baseUrl;
                    if (input.model) fromPreset.model = input.model;
                    resolved = fromPreset;
                }
                setAccountProvider(tool, name, resolved);
                return { ok: true, accounts: hubAccounts() };
            } catch (err) { return { ok: false, error: (err as Error).message, accounts: hubAccounts() }; }
        },
        tools: TOOL_NAMES.map((t) => ({ name: t, label: getTool(t).label })),
        toolPaths: toolPathStatuses().map((t) => ({ name: t.name, label: t.label, status: t.status })),
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
        runAction: async (req: { action: "skills" | "security" | "fix-path"; scope?: "global" | "local"; agents?: string[]; protections?: string[] }) => {
            const reporter = collectReporter();
            const title = req.action === "skills" ? "Install agent skills" : req.action === "fix-path" ? "Fix tool paths" : "Git security hooks";
            try {
                if (req.action === "skills") {
                    await installSkills({ ...opts, scope: req.scope ?? opts.scope, agents: req.agents ?? [], allAgents: !(req.agents && req.agents.length) }, false, reporter);
                    return { ok: true, title, lines: reporter.lines };
                }
                if (req.action === "fix-path") {
                    // No selection means every supported tool; persist config + PATH globally.
                    const tools = req.agents && req.agents.length ? req.agents : TOOL_NAMES;
                    let ok = true;
                    for (const t of tools) {
                        const result = ensureLaunchable(t, req.scope ?? "global");
                        if (result.ok) reporter.success(result.message); else { reporter.warn(result.message); ok = false; }
                    }
                    return { ok, title, lines: reporter.lines };
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
    while (action?.type === "connect" || action?.type === "ssh-connect") {
        // Connecting an account runs its login flow; an SSH connect/tunnel spawns ssh. Both
        // need the terminal the TUI owns, so run here in the freed terminal, then reopen.
        if (action.type === "connect") await loginWithSync(action.tool, action.account);
        else { const ssh = await import("./ssh"); await connectSsh(ssh, action.alias, { tunnelOnly: action.tunnel }); }
        action = await runHomeTui(buildCtx());
    }
    // "Update now" from the hub: run the full update (skills + npm) in the freed
    // terminal (the running binary is about to be replaced, so do not reopen the hub).
    if (action?.type === "update") { await runUpdateCli(version); return; }
    await notifyUpdate(version, interactive);
}
