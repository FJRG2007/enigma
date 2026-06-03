<div align="center">
  <h1>Enigma</h1>
  <h3>Everything you need to work with a coding agent, in one command.</h3>
  <img src="https://img.shields.io/badge/TypeScript-blue?style=for-the-badge&logo=typescript&logoColor=white"/> 
  <a href="https://github.com/FJRG2007"> <img alt="GitHub" src="https://img.shields.io/badge/GitHub-purple?style=for-the-badge&logo=github&logoColor=white"/></a>
  <a href="https://ko-fi.com/fjrg2007"> <img alt="Kofi" src="https://img.shields.io/badge/Ko--fi-purple?style=for-the-badge&logo=ko-fi&logoColor=white"></a>
  <br />
  <br />
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

## Install

```bash
npm install -g enigma-cli      # provides the `enigma` command
enigma                         # interactive: pick what to set up
```

Or run once without installing:

```bash
npx enigma-cli
```

## Commands

```
enigma                 Interactive menu: choose features to set up
enigma install         Install/update agent skills
enigma security        Set up git security hooks in the current repo
enigma guard [--all]   Run the commit guard (staged files, or all tracked)
enigma config [k v]    Show or set runtime toggles (e.g. config commit-emoji off)
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
    --bypass <names> Disable approval prompts (claude,codex,opencode | all | none)
    --no-bypass      Never configure permission bypass (skip the prompt)
    --output-style <off|lite|full|ultra>  Token-efficient output level (asked if omitted)
    --skills-only / --memory-only / --no-prune / --keep-modified / --dry-run
```

### Permission bypass (opt-in)

During install you can let an agent skip its per-action approval prompts, so it
stops asking before each edit or command. It is a deliberate security trade-off,
so it is **strictly opt-in**: enabled only via the interactive prompt or an
explicit `--bypass` flag, and **never** in a non-interactive (`--yes`) run
without the flag. In the interactive prompt Claude Code and Codex are
preselected; opencode is left off because its models are less reliable without
the approval gate. Your existing deny rules and other settings are preserved.

### Token-efficient output (opt-in)

Optionally have the agent compress its chat prose to save output tokens - drop
filler and pleasantries, keep every technical fact. It is chosen at install (or
`enigma config output-style <off|lite|full|ultra>`) and writes a section into the
agent's memory file, so **restart the agent** after changing it:

- `off` - normal full prose (default).
- `lite` - professional and tight: drops filler, keeps grammar and your language.
- `full` - shorter, caveman-style fragments.
- `ultra` - telegraphic, maximum compression.

Code, comments, commits, and PRs are always written normally, and the agent
reverts to full prose for security warnings and other safety-critical replies.
You can also switch level mid-session just by asking ("be more terse", "ultra",
"normal mode"). Inspired by [caveman](https://github.com/JuliusBrussee/caveman).

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

## Quality gates and publishing

This repo gates itself mechanically (it is a tooling distributor, so there is no
app test suite):

```bash
npm run typecheck # tsc --noEmit (tsup does not typecheck)
npm run check     # every skill well-formed and SEALED
npm run guard     # scan all tracked files for secrets, .env, node_modules, ...
npm run verify    # typecheck + check + guard (used by CI)
npm run build     # build dist with tsup (enigma.js + guard.js)
```

- **CI** (`.github/workflows/ci.yml`) runs `npm ci` + `npm run verify` + `npm run
  build` on every push and pull request.
- **Publish** (`.github/workflows/publish.yml`) publishes `enigma-cli` to npm with
  provenance when a GitHub Release is published (or via manual dispatch). It
  requires the `NPM_TOKEN` repo secret and checks that the release tag matches the
  package version.
- **Pre-commit** for this repo: `git config core.hooksPath .githooks`.

Full contributor guide (dev loop, build internals, release flow, local testing):
[`docs/developers/`](docs/developers/README.md).

#### Contributors
To contribute to the project visit the requirements at [`CONTRIBUTING`](./docs/developers/CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).

<p align="right"><a href="#top">Back to top 🔼</a></p>