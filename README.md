<div align="center">
  <img src="assets/logos/enigma-logo.svg" width="120" />
  <h1>Enigma</h1>
  <h3>Ship better code with your coding agent.</h3>
  <img src="https://img.shields.io/badge/TypeScript-blue?style=for-the-badge&logo=typescript&logoColor=white"/> 
  <a href="https://github.com/FJRG2007"> <img alt="GitHub" src="https://img.shields.io/badge/GitHub-purple?style=for-the-badge&logo=github&logoColor=white"/></a>
  <a href="https://ko-fi.com/fjrg2007"> <img alt="Kofi" src="https://img.shields.io/badge/Ko--fi-purple?style=for-the-badge&logo=ko-fi&logoColor=white"></a>
  <br />
  <br />
  <a href="https://fjrg2007.github.io/enigma/">Website</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#install">Quickstart</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://fjrg2007.github.io/enigma/">Install</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://tpe.li/dsc">Discord</a>
  <br />
  <hr />
</div>

`enigma` gives your coding agent a senior engineer's standards, in one command. It
installs shared **Dynamic Skills** - security, testing, git, style, debugging - into
Claude Code, OpenAI Codex and opencode; each one adapts to the agent, re-renders from
your config, and loads only when a task needs it. Portable **git hooks** keep secrets
and `.env` files out of every commit, a local **dashboard** manages and measures the
whole setup, and optional **packs** add focused harnesses - like the Helio bug-bounty
toolkit - in their own isolated context. Fewer wrong turns, fewer re-prompts, cleaner
output.

![ENIGMA PREVIEW](https://raw.githubusercontent.com/FJRG2007/enigma/refs/heads/main/assets/images/dashboard.png)

## Install

Recommended - run the install script (clears the npm cache, installs the latest
version, then runs `enigma install` **interactively** so you choose what to set up -
handy where npm `postinstall` scripts are disabled):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.ps1 | iex
```

Or install the `enigma` command globally, then run the interactive hub:

```bash
npm install -g enigma-cli@latest   # provides the `enigma` command
enigma                             # interactive hub: pick what to set up
```

Or one-shot, no global install, no prompts - deploy the skills to every supported
agent at user level:

```bash
npx enigma-cli@latest install --all --yes
```

<table>
<tr>
<td width="50%">

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Dynamic Skills, everywhere

Senior-engineering policies (security, testing, git, style, debugging...) on **Claude Code, OpenAI Codex and opencode**. Unlike a static skill, each one adapts to the agent, re-renders from your config, loads only when the task needs it, and updates itself. Discard any you don't want - it's gone everywhere until you restore it.

```bash
npx enigma-cli@latest install --all --yes
```

</td>
<td width="50%">

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Git security hooks

A portable commit guard for **any** repo: blocks secrets, `.env` files and `node_modules` before they're committed. Set it up once; the whole team inherits it.

```bash
enigma security
```

</td>
</tr>
<tr>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Token-efficient output

Same answer, fewer tokens. Compress the agent's chat replies (`off | lite | full | ultra`):

> Normal (69 tokens): "The reason your React component is re-rendering is likely because you're creating a new object reference on each render cycle..."

> Ultra (19 tokens): "New object ref each render. Inline object prop = new ref = re-render. Wrap in `useMemo`."

</td>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Multi-account + profiles

Multiple logins per tool, each isolated, switched without logging out. Every account inherits your skills, memory and settings. Profiles pin one account per tool ("work" = claude:acme + codex:acme) and drive every launch.

```bash
enigma claude work
enigma profile use work
```

</td>
</tr>
<tr>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Auto-detect skills by stack

`enigma autoskills` reads your stack and installs the matching community skills - React, Next.js, Astro, Prisma, FastAPI, Rails and ~90 more - kept separate from the policy skills. `--dry-run` previews first.

```bash
enigma autoskills
enigma autoskills --dry-run
```

</td>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Built-in `/improve` command

A slash command on every agent. **Implement** mode edits a focused area (`ui`, `security`, `performance`, `seo`, `refactor`); **advisor** mode audits read-only and writes execution-ready plans for another agent to run.

```bash
/improve ui
/improve audit
```

</td>
</tr>
<tr>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Minimal code

On by default. Pushes the agent toward the simplest solution that works - stdlib and platform features before custom code, the shortest diff. Tune `off | lite | full | ultra`; security and validation are never cut.

</td>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Context compression

Opt-in. Shrinks large tool outputs, logs and text to far fewer tokens before they reach the model - reversibly. Use `enigma compress`, or register it as an MCP server.

</td>
</tr>
<tr>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Local agent API

`enigma api` serves your local coding agents over one **OpenAI-compatible HTTP API** - Claude Code (and Codex/OpenCode where installed), with all of their tools, skills, MCP and sessions. One server, many backends: pick per request via the `model` field. Loopback-only. Point your OpenAI SDK at `http://127.0.0.1:8000/v1`.

</td>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Local dashboard

A loopback browser control panel for all of enigma - accounts, skills, settings, system cleanup - that also shows real Claude usage and measured savings. Nothing leaves your machine.

</td>
</tr>
<tr>
<td colspan="2">

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> SSH connections

Save each server once - key or encrypted password, jump host, port forwards - then reach it with a short alias. Passwords are stored encrypted and auto-filled (sshpass/plink). Tunnel a remote port with a friendly `9090:db:5432` spec. Managed from the CLI, TUI and dashboard.

```bash
enigma ssh add server1 --host 203.0.113.10 --user root -i ~/.ssh/id_ed25519
enigma ssh server1
enigma ssh tunnel server1 9090:5432
```

</td>
</tr>
</table>

The first install is the only one you run by hand: launching a tool through enigma
(e.g. `enigma claude`) **auto-syncs** the deployed skills and memory to the
installed version, so updates apply without re-running `enigma install` (opt out
with `enigma config auto-sync off`). It never deploys to a new agent on its own,
never overwrites skills you edited, and never rewrites a memory file you authored.
Skills also update straight from this repo between npm releases, verified by content
hash (`enigma config remote-skills off` to disable).

## Configuration

Most features are opt-in or tunable. Configure them from the interactive hub
(`enigma`), the local **dashboard** (`enigma dashboard`), or the CLI
(`enigma config <key> <value>`) - whichever you prefer. For the full list of keys,
their defaults, and per-feature details, see the
[documentation](https://fjrg2007.github.io/enigma/docs/reference/configuration/).

## Requirements

**Minimum:** [Node.js](https://nodejs.org) `>= 18` (with `npm`), [Git](https://git-scm.com)
and at least one coding agent. **Recommended:** add [Claude Code](https://claude.com/claude-code),
the [GitHub CLI](https://cli.github.com), [Bun](https://bun.sh) and [Warp](https://www.warp.dev).

<details>
<summary><b>Details</b> - what each one is for</summary>

### Minimum

|  |  |
|--|--|
| <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js"/></a> | `>= 18`, ships with `npm` - installs and runs the `enigma` CLI |
| <a href="https://git-scm.com"><img src="https://img.shields.io/badge/Git-F05032?style=for-the-badge&logo=git&logoColor=white" alt="Git"/></a> | powers the security hooks and the commit guard |
| <img src="https://img.shields.io/badge/Coding%20agent-555555?style=for-the-badge&logo=claude&logoColor=white" alt="Coding agent"/> | at least one of [Claude Code](https://claude.com/claude-code), [OpenAI Codex](https://github.com/openai/codex) or [opencode](https://opencode.ai) - the skills need a home |

### Recommended

Everything in **Minimum**, plus:

|  |  |
|--|--|
| <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-D97757?style=for-the-badge&logo=claude&logoColor=white" alt="Claude Code"/></a> | the agent enigma is most battle-tested with |
| <a href="https://cli.github.com"><img src="https://img.shields.io/badge/GitHub%20CLI-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub CLI"/></a> | `gh` commits go through the same hooks, and `enigma issue` opens prefilled reports |
| <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Bun"/></a> | only needed to build or contribute from source |
| <a href="https://www.warp.dev"><img src="https://img.shields.io/badge/Warp-01A4FF?style=for-the-badge&logo=warp&logoColor=white" alt="Warp"/></a> | a modern terminal where the hub TUI shines |

</details>

## Commands

```
enigma                 Interactive menu: choose features to set up
enigma install         Install/update agent skills
enigma update          Fetch the latest skills from GitHub, sync deployments,
                       and self-update enigma-cli when a newer release exists
enigma security        Set up git security hooks in the current repo
enigma guard [--all]   Run the commit guard (staged files, or all tracked)
enigma config [k v]    Show or set runtime toggles (e.g. config commit-emoji off)
enigma <tool> [acct]   Launch claude | codex | opencode with an account's config
                       (explicit > active profile > tool active; auto-syncs first)
enigma account ...     Manage per-tool accounts   enigma profile ...  Group them
enigma skills ...      List skills, discard one (removed everywhere and skipped
                       by installs/updates) or restore it (list/discard/restore)
enigma issue [type]    Prefilled GitHub issue URL (OS, versions, terminal, agents)
enigma compress [file] Compress JSON/logs/text to fewer tokens (reversible);
                       --retrieve <hash> restores, --stats shows total savings,
                       --clear wipes all dashboard data (stats/history/cache)
enigma mcp             Run the context-compression MCP server over stdio
enigma api             Serve a local OpenAI-compatible API for your agents (Claude Code, and
                       Codex/OpenCode where installed); route per request by the model field.
                       --port, --api-key, --tool (default backend). Loopback-only
enigma dashboard|dash  Open the local dashboard (manage enigma; see savings) in your browser (http://enigma,
                       or http://localhost:24282 if :80/hosts is unavailable)
enigma ssh [alias]     SSH connection manager: connect by alias, or list | add | edit | remove |
                       info | tunnel <alias> <name|spec> | forward <add|remove|list> <alias>
                       (encrypted passwords, saved key/jump/port-forwards; e.g. 9090:db:5432)
enigma seal            Maintenance: (re)compute skill content hashes
enigma check           Integrity gate: verify skills are well-formed and sealed
enigma help | version
```

### Install options

```
-g, --global         User level    -l, --local   This project
-a, --agent <name>   Target agent(s) (default: auto-detect)
-s, --skill <name>   Skill(s) (default: all)
    --all            Every supported agent, ignoring detection
    --bypass <names> Force approval-prompt bypass (claude,codex,opencode | all | none)
    --no-bypass      Skip permission bypass for this run (it is on by default)
    --output-style <off|lite|full|ultra>  Token-efficient output level (asked if omitted)
    --skills-only / --memory-only / --no-prune / --keep-modified / --dry-run
```

## Contributing

Contributions are welcome. The development loop, build internals, release flow,
the mechanical quality gates (`verify`, `check`, `guard`, `seal`) and local
testing all live in the [developer guide](docs/developers/README.md) - start with
[`CONTRIBUTING`](./docs/developers/CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).

<p align="right"><a href="#top">Back to top 🔼</a></p>