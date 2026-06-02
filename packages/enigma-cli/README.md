# enigma-cli

Everything you need to work with a coding agent, in one command. `enigma`
installs a shared set of engineering **policy skills** into the agents you
actually use (Claude Code, OpenAI Codex, opencode) and sets up portable **git
security hooks** that block secrets, `.env` files, and dependency dirs from being
committed.

## Install

```bash
npm install -g enigma-cli      # provides the `enigma` command
enigma                         # interactive: pick what to set up
```

Or run once without installing: `npx enigma-cli`.

## Commands

```
enigma                 Interactive menu: choose features to set up
enigma install         Install/update agent skills
enigma security        Set up git security hooks in the current repo
enigma guard [--all]   Run the commit guard (staged files, or all tracked)
enigma config [k v]    Show or set runtime toggles (e.g. config commit-emoji off)
enigma claude [acct]   Launch Claude Code using an account (active if omitted)
enigma account ...     Manage Claude Code accounts (list/add/use/login/remove)
enigma seal            Maintenance: (re)compute skill content hashes
enigma check           Integrity gate: verify skills are well-formed and sealed
enigma help | version
```

Everything is modular and opt-in via [`@clack/prompts`](https://github.com/bombshell-dev/clack):
the menu lets you enable or disable each feature, and `enigma security` lets you
toggle each protection. Nothing touches your git config unless you run
`enigma security` or accept its prompt.

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

## Multiple Claude Code accounts

If you use one Claude Code login for work and another for personal projects,
`enigma` lets you keep both side by side and switch without logging out. Claude
Code reads its credentials and session from the directory in `CLAUDE_CONFIG_DIR`
(default `~/.claude`), so each account just needs its own directory. Rather than
hand-editing per-shell aliases, `enigma` launches Claude for you with that
variable set - the same command on macOS, Linux and Windows.

```bash
enigma account add work --login   # create 'work' and run /login to authenticate
enigma account add personal       # create 'personal' (log in later)
enigma account list               # show all accounts (active one marked *)
enigma claude work                # run Claude Code as 'work'
enigma account use personal       # make 'personal' the active account
enigma claude                     # run the active account
enigma claude work -- --version   # forward args after -- to Claude
enigma account remove work        # delete an account and its config dir
```

Your existing `~/.claude` is always available as the built-in `default` account
(it is never deleted). New accounts live under `~/.enigma/<tool>/<name>/`. A bare
`claude` command keeps using `~/.claude` as before.

From the hub TUI (`enigma`), the **Accounts** panel lists accounts and lets you
set the active one, **connect** (log in) an account, or remove it. Connecting
closes the hub, runs the tool's own login flow (for Claude: it launches and you
run `/login`), then reopens the hub.

The mechanism is tool-agnostic by design: only Claude Code is wired up today, but
the same per-account-config-dir approach extends to other agents (e.g. Codex via
`CODEX_HOME`). Target another tool with `--tool <name>` on `account` commands.

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

## License

[Apache-2.0](LICENSE).
