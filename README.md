<div align="center">
  <img src="assets/logos/enigma-logo.svg" width="120" />
  <h1>Enigma</h1>
  <h3>Everything you need to work with a coding agent, in one command.</h3>
  <img src="https://img.shields.io/badge/TypeScript-blue?style=for-the-badge&logo=typescript&logoColor=white"/> 
  <a href="https://github.com/FJRG2007"> <img alt="GitHub" src="https://img.shields.io/badge/GitHub-purple?style=for-the-badge&logo=github&logoColor=white"/></a>
  <a href="https://ko-fi.com/fjrg2007"> <img alt="Kofi" src="https://img.shields.io/badge/Ko--fi-purple?style=for-the-badge&logo=ko-fi&logoColor=white"></a>
  <br />
  <br />
  <a href="https://fjrg2007.github.io/enigma/">Website</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#">Quickstart</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://tpe.li/dsc">Discord</a>
  <br />
  <hr />
</div>

`enigma` installs a shared set of engineering **policy skills** into the agents you
actually use (Claude Code, OpenAI Codex, opencode) and sets up portable **git
security hooks** that block secrets, `.env` files, and dependency dirs from being
committed.

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

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Policy skills, everywhere

12 engineering policy skills (security, testing, git, style, debugging...) authored once and deployed to **Claude Code, OpenAI Codex and OpenCode**, sealed with content hashes so tampering is detected. Discard any skill you don't want (`enigma skills discard <name>` or the hub's SKILLS section): it is removed everywhere and skipped by installs/updates until restored.

```bash
npx enigma-cli@latest install --all --yes
```

</td>
<td width="50%">

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Git security hooks

A portable, dependency-free commit guard for **any** repo: blocks secrets, `.env` files and `node_modules` before they are committed. Set it up once and the whole team inherits it.

```bash
enigma security
```

</td>
</tr>
<tr>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Token-efficient output

Optional compression of the agent's chat prose (`off | lite | full | ultra`):

> Normal (69 tokens): "The reason your React component is re-rendering is likely because you're creating a new object reference on each render cycle..."

> Ultra (19 tokens): "New object ref each render. Inline object prop = new ref = re-render. Wrap in `useMemo`."

</td>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Multi-account + profiles

Several logins per tool without logging out, each in its own config dir, switched OS-agnostically. Every account inherits your skills, memory and managed settings (permission bypass, attribution) automatically. Profiles pin one account per tool ("work" = claude:acme + codex:acme) and drive every launch.

```bash
enigma claude work
enigma profile use work
```

</td>
</tr>
<tr>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Privacy & productivity defaults

Sensible privacy and security defaults applied at install: GitHub CLI telemetry **disabled**, Claude Code's feedback survey **off**, and the agent kept from attributing commits to itself. Tune any of it from the CLI or the interactive hub.

```bash
enigma config gh-telemetry disabled
enigma config claude-survey off
```

</td>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Built-in `/improve` command

A slash command deployed to every agent to improve your project: an **implement** mode that edits a focused area (`ui`, `security`, `performance`, `seo`, `refactor`) and a read-only **advisor** mode that audits the codebase and writes self-contained plans for another agent to execute.

```bash
/improve ui
/improve audit
```

</td>
</tr>
<tr>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Minimal code

On by default. Pushes the agent toward the laziest solution that works - standard library and native platform features before custom code, the shortest working diff. Tune `off | lite | full | ultra`; security and trust-boundary validation are never simplified away.

</td>
<td>

### <img src="assets/logos/enigma-logo.svg" width="20" height="20" alt="Enigma"/> Context compression

Opt-in. A native, dependency-free engine that shrinks large tool outputs, logs and text to far fewer tokens before they reach the model - reversibly. Use `enigma compress`, or register it as an MCP server for your agents.

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
[documentation](https://fjrg2007.github.io/enigma/docs/configuration/).

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
enigma dashboard|dash  Open the local dashboard (manage enigma; see savings) in your browser (http://enigma,
                       or http://localhost:24282 if :80/hosts is unavailable)
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

## Git security hooks

`enigma security` drops a portable, dependency-free commit guard into **any** repo
(not just this one): it copies the built guard into the repo's `.githooks/` (as
`guard.mjs`), writes a cross-platform `pre-commit` shim and a toggle config, and points `core.hooksPath`
at it. Commit `.githooks/` so the whole team inherits it. Because the hook runs on
`git commit`, it also covers commits made through the **GitHub CLI** (`gh`), which
shells out to `git`.

On every commit the guard, OS-agnostically:

- **Blocks** committed secrets (API keys, tokens, private keys).
- **Blocks** `.env` / `.env.local` and similar (allows `*.example` / `*.sample` /
  `*.template`).
- **Blocks** dependency/cache dirs (`node_modules`, `__pycache__`, virtualenvs).
- **Warns** on generated dirs (`dist`, `build`, `.next`, `coverage`), log/OS-junk
  files, and files over 5 MB.

Each protection is individually toggleable: the interactive setup uses a
multiselect, and the choices are saved to `.githooks/enigma-guard.json`. Bypass
once with `git commit --no-verify`.

## Contributing

Contributions are welcome. The development loop, build internals, release flow,
the mechanical quality gates (`verify`, `check`, `guard`, `seal`) and local
testing all live in the [developer guide](docs/developers/README.md) - start with
[`CONTRIBUTING`](./docs/developers/CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).

<p align="right"><a href="#top">Back to top 🔼</a></p>