# Local testing

How to exercise the CLI safely without disturbing your real agent setup.

## Preview an install without writing anything

`--dry-run` plans the install and prints what would change, but writes nothing:

```bash
npm run enigma -- install --local --all --yes --dry-run
```

- `--all` targets every supported agent (claude, codex, opencode) regardless of
  what is detected, so the preview always lists all three.
- `--local` scopes to the current directory instead of your home config.
- `--yes` runs non-interactively.

A correct dry run lists claude, codex, and opencode with their planned actions.

## Test a real install into a scratch directory

To see files actually written, install `--local` inside a throwaway directory so
your real `~/.claude`, `~/.codex`, and `~/.config/opencode` are untouched:

```bash
mkdir /tmp/enigma-scratch && cd /tmp/enigma-scratch
git init                              # optional: lets you test the security hooks too
# run the CLI by absolute path back to the repo:
node /path/to/repo/packages/enigma-cli/dist/enigma.js install --local --all --yes
```

`--local` writes into the current working directory:

| Agent       | Local skills path        | Local memory file |
| ----------- | ------------------------ | ----------------- |
| Claude Code | `./.claude/skills/`      | `./CLAUDE.md`     |
| OpenAI Codex| `./.agents/skills/`      | `./AGENTS.md`     |
| opencode    | `./.opencode/skills/`    | `./AGENTS.md`     |

Inspect the result, then delete the scratch directory. Nothing global was
touched.

To test from the TS source instead of the built binary, run the same arguments
through `npm run enigma --` from the repo root, passing an absolute `--local`
target by `cd`-ing into the scratch dir first (the CLI uses the current working
directory for `--local`).

## Test the commit guard

The guard scans for secrets, `.env` files, dependency dirs, etc.

Over all tracked files in this repo:

```bash
npm run guard
```

To test it as an installed pre-commit hook in a scratch repo:

```bash
cd /tmp/enigma-scratch        # a git repo
node /path/to/repo/packages/enigma-cli/dist/enigma.js security
# now try to commit something that should be blocked, e.g. a fake secret:
printf 'AKIA%s\n' "AAAAAAAAAAAAAAAA" > leak.txt
git add leak.txt && git commit -m "test"   # the guard should block this
```

`enigma security` copies the built `dist/guard.js` into `.githooks/guard.mjs`,
writes a `pre-commit` shim and `enigma-guard.json`, and points
`core.hooksPath` at `.githooks`. Bypass once with `git commit --no-verify`.
Toggle individual protections in `.githooks/enigma-guard.json`.

Because the guard runs on `git commit`, it also covers commits made through the
GitHub CLI (`gh`), which shells out to git.

## Test the runtime config (`enigma config`)

`enigma config` reads and writes `.enigma.json`, the opt-out file the agent
checks (currently for commit emojis).

```bash
npm run enigma -- config                          # show effective config + source
npm run enigma -- config commit-emoji off --local # write ./.enigma.json
npm run enigma -- config commit-emoji on  --local # flip it back
npm run enigma -- config commit-emoji off -g      # write ~/.enigma.json (global)
```

Precedence when read: built-in defaults -> `~/.enigma.json` -> repo
`.enigma.json` (nearest wins). Use `--local` against a scratch directory to avoid
leaving a `.enigma.json` in the repo. Invalid keys/values and a missing value
exit non-zero with a helpful message.

## A tip on shell command batching

When scripting checks, avoid chaining commands with `&&` where an early failure
(for example a `find` on a path that may not exist) aborts the rest, and avoid
firing many independent commands as one parallel batch - if one errors, the
siblings can be cancelled. Prefer separate, self-contained commands, and do not
`cd` inside a compound command (the working directory is already the repo root).
