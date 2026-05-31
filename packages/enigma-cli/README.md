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

## License

[Apache-2.0](LICENSE).
