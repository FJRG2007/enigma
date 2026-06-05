# enigma-cli

Everything you need to work with a coding agent, in one command. `enigma`
installs a shared set of engineering **policy skills** into the agents you
actually use (Claude Code, OpenAI Codex, opencode) and sets up portable **git
security hooks** that block secrets, `.env` files, and dependency dirs from being
committed.

## Install

One command, no global install, no prompts - deploy the skills to every supported
agent at user level:

```bash
npx enigma-cli@latest install --all --yes
```

Or install the command and pick interactively:

```bash
npm install -g enigma-cli      # provides the `enigma` command
enigma                         # interactive hub: pick what to set up
```

That first install is the only one you ever need to run by hand: afterwards,
launching a tool through enigma (e.g. `enigma claude`) auto-syncs the deployed
skills and memory with the installed package version (see
[Auto-sync](#auto-sync-on-launch)).

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
enigma security        Set up git security hooks in the current repo
enigma guard [--all]   Run the commit guard (staged files, or all tracked)
enigma config [k v]    Show or set runtime toggles (e.g. config commit-emoji off)
enigma <tool> [acct]   Launch claude | codex | opencode with an account
                       (resolution: explicit > active profile > tool active);
                       auto-syncs deployed skills first
enigma account ...     Manage per-tool accounts (list/add/use/login/remove)
enigma profile ...     Group one account per tool (list/add/use/set/unset/remove)
enigma skills ...      List skills and manage discards (list/discard/restore)
enigma seal            Maintenance: (re)compute skill content hashes
enigma check           Integrity gate: verify skills are well-formed and sealed
enigma help | version
```

## Agent skills

Skills are authored once and deployed to every selected agent (no per-agent
duplication). `enigma install` auto-detects which agents are installed (CLI on
`PATH` or a config dir like `~/.claude`, `~/.codex`, `~/.config/opencode`) and
preselects them; `--all` targets every supported agent.

| Agent       | Scope  | Skills                        | Memory file                    |
| ----------- | ------ | ----------------------------- | ------------------------------ |
| Claude Code | global | `~/.claude/skills/`           | `~/.claude/CLAUDE.md`          |
| OpenAI Codex| global | `~/.agents/skills/`           | `~/.codex/AGENTS.md`           |
| opencode    | global | `~/.config/opencode/skills/`  | `~/.config/opencode/AGENTS.md` |

(`--local` installs into the current project instead.)

Don't want one of the skills? Discard it from the hub's install panel (the
SKILLS section lists every skill; unchecking one discards it) or with
`enigma skills discard <name>`: it is removed from every agent and skipped by
future installs, updates and auto-syncs until you restore it with
`enigma skills restore <name>`.

## Auto-sync on launch

After the first `enigma install`, you never need to run it again: whenever you
launch a tool through enigma (`enigma claude`, `enigma account run work`), enigma
first compares the deployed skills/memory against the installed package version
and silently refreshes anything that changed (new skills, updated versions,
removed skills, memory-file edits). On by default; opt out with:

```bash
enigma config auto-sync off
```

Auto-sync is deliberately conservative:

- It only touches agents/scopes that **already have** a deployment - it never
  performs a first install (that stays your explicit `enigma install`).
- Skills you modified locally are **never overwritten** (same rule as
  `--keep-modified`).
- The memory file (`CLAUDE.md` / `AGENTS.md`) is only rewritten when it is
  byte-identical to what enigma last wrote (tracked in `~/.enigma/state.json`) -
  a file you authored or edited is never touched.
- A sync failure never blocks the launch; the tool starts anyway.

## Git security hooks

`enigma security` drops a portable, dependency-free commit guard into any repo:
it copies `guard.mjs` into the repo's `.githooks/`, writes a cross-platform
`pre-commit` shim and a toggle config, and points `core.hooksPath` at it. Commit
`.githooks/` so the team inherits it. Because it runs on `git commit`, it also
covers commits made through the GitHub CLI (`gh`).

On every commit the guard, OS-agnostically:

- **Blocks** committed secrets (API keys, tokens, private keys).
- **Blocks** `.env` / `.env.local` (allows `*.example` / `*.sample` / `*.template`).
- **Blocks** dependency/cache dirs (`node_modules`, `__pycache__`, virtualenvs).
- **Warns** on generated dirs (`dist`, `build`, `.next`, `coverage`), log/OS-junk
  files, and files over 5 MB.

Each protection is individually toggleable (saved to `.githooks/enigma-guard.json`).
Bypass once with `git commit --no-verify`.

## Multiple accounts and profiles

Work across separate workflows with different accounts per tool - for example
your **company** Claude Code account and your **personal** one - keeping each
fully isolated and switching between them without ever logging out. Each account
has its own credentials, session, and history, so client work never mixes with
personal projects. Supported tools: **Claude Code** (`CLAUDE_CONFIG_DIR`),
**OpenAI Codex** (`CODEX_HOME`) and **OpenCode** (a private `XDG_DATA_HOME` /
`XDG_CONFIG_HOME` pair per managed account; its default account keeps your real
environment untouched).

> This is for legitimate, professional account separation (one account per
> employer/context, as many organizations require). It is **not** a way to evade
> usage limits or Anthropic's terms - each account still authenticates as itself
> and is subject to its own limits. Use the account that each piece of work
> belongs to.

Claude Code reads its credentials and session from the directory in
`CLAUDE_CONFIG_DIR` (default `~/.claude`), so each profile just needs its own
directory. Rather than hand-editing per-shell aliases, `enigma` launches Claude
for you with that variable set - the same command on macOS, Linux and Windows.

```bash
enigma account add work --login   # create 'work' and run /login to authenticate
enigma account add personal       # create 'personal' (log in later)
enigma account add acme -t codex  # create a Codex account
enigma account list               # show all accounts (active one marked *)
enigma claude work                # run Claude Code as 'work'
enigma codex acme                 # run Codex as 'acme'
enigma account use personal       # make 'personal' the active account
enigma claude                     # run the resolved account (profile > active)
enigma claude work -- --version   # forward args after -- to the tool
enigma account rename work corp   # rename an account (its config dir moves)
enigma account remove work        # delete an account and its config dir
```

Your existing `~/.claude` / `~/.codex` / opencode setup is always available as
each tool's built-in `default` account (never deleted). New accounts live under
`~/.enigma/<tool>/<name>/`. Bare `claude` / `codex` / `opencode` commands keep
using your real environment as before.

Managed accounts inherit your enigma setup automatically: because the tool reads
everything from the account's config dir, enigma deploys the skills and memory
file into it (seeded on `account add` and on launch) and mirrors the
enigma-managed native settings from your default account on every launch -
Claude's permission bypass, attribution overrides and statusline, Codex's
`approval_policy`/`sandbox_mode`, opencode's `"*": "allow"` permission. Turning
a knob off on the default account propagates too; per-account manual edits to
those specific knobs are overwritten on the next launch, while every other
account setting (theme, custom statusline, extra permissions) is left untouched.

### Profiles (one account per tool)

A profile pins one account per tool under a single name - e.g. profile `work` =
Claude Code `work` + Codex `acme`. While a profile is active, `enigma <tool>`
launches that profile's account for the tool (explicit account arguments still
win; unmapped tools fall back to their own active account):

```bash
enigma profile add work                 # create the profile
enigma profile set work claude work     # pin claude account 'work'
enigma profile set work codex acme      # pin codex account 'acme'
enigma profile use work                 # activate (enigma claude/codex now use it)
enigma profile list                     # profiles + mappings (* = active)
enigma profile rename work corp         # rename a profile (mappings stay)
enigma profile use none                 # deactivate
```

From the hub TUI (`enigma`), the **Accounts** panel lists every tool's accounts -
with the signed-in identity (email for Claude/Codex, connected providers for
OpenCode) - and lets you **add** (`a`), set active (`enter`), **connect**/log in
(`c`), rename (`r`), or remove (`d`). Adding first asks **which tool** with a
searchable selector (type to filter, like opencode's model picker), then the
account name, then offers to connect right away. The **Profiles** panel manages
profiles end-to-end: `enter` switches the active one (`(none)` deactivates), `a`
creates one, `e` edits its mappings (searchable tool selector, then a searchable
account selector including `(unpin)`), `r` renames it, and `d` removes it
(accounts are kept).

## GitHub CLI telemetry (default off)

If the GitHub CLI (`gh`) is installed, `enigma install` disables its usage
telemetry (`gh config set telemetry disabled`). This is pure privacy upside -
telemetry is usage analytics only (command, flags, OS/version, device ids) and
no gh feature depends on it - and it also avoids a known Windows bug where the
detached `gh send-telemetry` subprocess spawns `tzutil.exe` without hiding its
window, flashing a terminal on gh invocations
([cli/cli#13354](https://github.com/cli/cli/issues/13354)). Re-enable any time:

```bash
enigma config gh-telemetry on     # restore gh's default
enigma config gh-telemetry off    # disable again
```

## Commit emojis

By default the policy skills make commit subjects carry a leading type emoji
(one per subject, e.g. for `feat`/`fix`); code, prose, and PR text stay
emoji-free. The convention and its type-to-emoji map live in the `git-policy`
skill. Opt out per repo or globally:

```bash
enigma config commit-emoji off       # disable (writes .enigma.json)
enigma config commit-emoji on        # re-enable
enigma config commit-emoji off -g    # global (~/.enigma.json)
```

Precedence: built-in default (on) -> `~/.enigma.json` -> repo `.enigma.json`.

## Parallel sub-agents

The memory file always tells agents to break long or complex tasks into smaller
subtasks and complete them incrementally. The parallel part - delegating
independent subtasks to sub-agents that run at the same time to finish faster -
is opt-in, because spawning sub-agents multiplies token cost:

```bash
enigma config parallel-subagents on        # add the parallel section to the memory file
enigma config parallel-subagents off       # remove it (default)
enigma config parallel-subagents on -g      # global (~/.enigma.json)
```

This toggle edits the deployed agent memory file (adds or removes the section),
so **restart Claude Code / Codex / OpenCode** after changing it for the new
session to pick it up. Subtask decomposition itself is always on and is never
removed.

## Token-efficient output

Optionally compress the agent's chat prose to cut output tokens while keeping
full technical accuracy. Chosen at install or via config; off by default:

```bash
enigma config output-style lite     # professional terse (drop filler, keep grammar)
enigma config output-style full     # shorter, drops articles and uses fragments
enigma config output-style ultra    # telegraphic, maximum compression
enigma config output-style off      # back to full prose (default)
enigma install --output-style lite  # set it during install
```

`on`/`off` also work (`on` = `full`). Like the toggle above it edits the memory
file, so **restart your agent** after changing it. Code, comments, commits, and
PRs stay normal, the agent reverts to full prose for security warnings and other
safety-critical replies, and the level is switchable mid-session by asking
("be more terse", "ultra", "normal mode").

Claude Code's status bar shows an `[ENIGMA]` badge at all times; while the mode is
active it appends the level (`[ENIGMA:FULL]`, `[ENIGMA:LITE]`, `[ENIGMA:ULTRA]`).
enigma wires this into `settings.json` during `enigma install`, only when you have
no status line configured (it never replaces your own). If you upgraded the package,
re-run `enigma install` once to wire it.

## License

[Apache-2.0](LICENSE).
