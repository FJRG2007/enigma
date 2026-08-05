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

The guard also has two other scan modes, for when nothing is staged (a
pre-push hook, or CI on a branch):

```bash
npm run enigma -- guard --range origin/main..HEAD --json
```

`--range <base>..<head>` (a lone ref means `<ref>..HEAD`) scans exactly what
that commit range touched, reading each file's content at the range's head
rather than the working tree - `--all` would report pre-existing findings the
range never introduced, and the default (staged-only) scan sees nothing at
all post-commit. `--json` prints one document
(`{tool, ok, exit, mode, range, files, error, findings[]}`) instead of text.
Exit codes: 0 clean, 1 blocking findings, 2 the guard could not run at all (no
repository, an unresolvable range) - useful for a caller that wants to retry
the latter and act on the former.

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

## Test the automated-install options

These flags exist for installs run by a container or CI harness rather than a
person, so they are worth exercising in a scratch directory the same way as a
normal install (see above):

```bash
node /path/to/repo/packages/enigma-cli/dist/enigma.js install --local --all --yes --no-hooks --no-statusline
node /path/to/repo/packages/enigma-cli/dist/enigma.js install --local --all --yes --ref v1.35.2
node /path/to/repo/packages/enigma-cli/dist/enigma.js install --local --all --yes --assets-from /path/to/staged/assets
```

- `--hooks <classes>` / `--no-hooks` decide which of `post-edit`/`stop` hooks
  (and `--no-statusline` the statusLine entry) this run wires into the agent's
  settings, for a harness that already owns those events. This governs the
  install run only; `enigma config verify|guardrails|trim|lint off` is the
  durable off switch, since `enigma update` and the pre-launch auto-sync
  re-assert the wiring on their next run.
- `--ref <tag|sha>` pins the skills source and prints the resolved commit; two
  installs with the same `--ref` install the same skills regardless of what
  `main` has moved to since.
- `--assets-from <dir>` installs from a staged `skills/`/`memory/`/`commands/`
  tree instead of the bundled assets, and implies `--offline`.
- `--offline` (or `ENIGMA_OFFLINE=1` in the environment) makes no network call
  at all: no remote-skill check, no update notice, no background linter or
  dashboard-UI install.

`--hooks`/`--no-hooks` and `--assets-from`/`--offline` are covered by
`tests/install-options.test.ts`; `--ref` pinning is covered by
`tests/skills-remote.test.ts`.

## A tip on shell command batching

When scripting checks, avoid chaining commands with `&&` where an early failure
(for example a `find` on a path that may not exist) aborts the rest, and avoid
firing many independent commands as one parallel batch - if one errors, the
siblings can be cancelled. Prefer separate, self-contained commands, and do not
`cd` inside a compound command (the working directory is already the repo root).
