# Development

How the `enigma-cli` package is structured and how to run it from source.

## Project layout (`packages/enigma-cli`)

The CLI is TypeScript, compiled by tsup. Source lives in `src/`:

| File                | Responsibility                                                        |
| ------------------- | -------------------------------------------------------------------- |
| `src/bin/enigma.ts` | Entry point. Thin wrapper: parses `argv` and calls `run()`.          |
| `src/cli.ts`        | Argument parsing, the interactive menu, and command dispatch.        |
| `src/skills.ts`     | Skill discovery, integrity (seal/check), and install planning.       |
| `src/agents.ts`     | Supported agents (Claude Code, Codex, opencode) and OS detection.    |
| `src/security.ts`   | `enigma security`: installs the commit guard into a target repo.     |
| `src/guard.ts`      | The self-contained commit guard (see "The guard" below).            |
| `src/config.ts`     | Runtime config (`.enigma.json`) read by the agent and `enigma config`. |
| `src/claude.ts`     | Claude-specific settings (disabling commit/PR attribution).         |
| `src/util.ts`       | Small dependency-free helpers (`isDir`, `readJson`, `isOnPath`).     |

Assets shipped to agents live under `src/`'s sibling `assets/`:

- `assets/skills/<name>/` - one folder per policy skill (`SKILL.md` + `skill.json`).
- `assets/memory/CLAUDE.md` and `assets/memory/AGENTS.md` - the always-on memory
  files deployed per agent.

Skills and memory are authored once and deployed to every agent. Never create
per-agent copies of a `SKILL.md`.

## Running the CLI from source

The fastest loop uses `tsx` (no build step). From the repo root:

```bash
npm run enigma -- <args>
```

The `--` forwards everything after it to the CLI. Examples:

```bash
npm run enigma -- help
npm run enigma -- config
npm run enigma -- install --local --all --yes --dry-run
```

Under the hood the root `enigma` script delegates to the workspace
(`npm run -w enigma-cli enigma --`), which runs `tsx src/bin/enigma.ts`.

To exercise the actually-built binary instead of the TS source, build first and
run the bundle directly:

```bash
npm run build
node packages/enigma-cli/dist/enigma.js help
```

Running the built bundle matters before publishing: tsup bundles `guard.ts` into
`dist/enigma.js`, so the bundle path can differ subtly from the tsx path. See
"The guard" below.

## Watch mode

```bash
npm run -w enigma-cli dev
```

This is `tsup --watch`: it rebuilds `dist/` on every source change. Useful when
you are iterating against the built binary.

## The deterministic gates

Skills and memory only persuade the model; correctness is enforced mechanically.

- `npm run typecheck` - `tsc --noEmit`. Type errors. tsup does not typecheck on
  its own (it only transpiles), so this is the only type gate.
- `npm run seal` - recompute each skill's content hash (`sha`) into its
  `skill.json`, and stamp the current CLI version (`cliVersion`), the canonical
  `provider`, and `updated` (the last commit that changed the skill's content).
  It also rewrites `docs/skills-catalog.json`, the catalog the website reads, so
  expect that file in the diff. Run this after editing ANY `SKILL.md` or
  `skill.json` content.
- `npm run check` - integrity gate. Verifies every skill has valid frontmatter,
  a `skill.json`, the managed provider, a `version`, a `cliVersion` that matches
  the current CLI version, and a `sha` that matches the current content. Fails
  (non-zero) on any drift. This is what catches "I edited a skill but forgot to
  re-seal".
- `npm run guard` - the commit guard over all tracked files (secrets, `.env`,
  dependency dirs, generated dirs, junk, large files).
- `npm run verify` - `typecheck && check && guard`. The full pre-publish/CI gate.

Always run `npm run verify` before committing or publishing.

### Editing a skill: the seal/check cycle

1. Edit `assets/skills/<name>/SKILL.md` (and/or its `skill.json`).
2. Bump the skill's `version` in `skill.json` for any real content change.
3. `npm run seal` - refreshes `sha` and `cliVersion`.
4. `npm run check` - confirms it is sealed and well-formed.

If you skip the seal, `check` (and therefore CI and `prepublishOnly`) fails with
a "stale sha" error. The installer also keys off `sha` to detect changes, so an
unsealed edit will not be picked up by `enigma install`.

> Note: `check` requires each skill's `cliVersion` to equal the current
> `enigma-cli` version. Bumping the package version therefore requires a
> re-seal. See building-and-publishing.md.

## The guard (`src/guard.ts`)

`src/guard.ts` is a self-contained, dependency-free commit scanner. It is used
two ways:

1. As this repo's own CI/pre-commit scanner (run via tsx or as `dist/guard.js`).
2. As the engine `enigma security` copies into a target repo's `.githooks/`
   (`security.ts` copies the built `dist/guard.js` to `<repo>/.githooks/guard.mjs`).

Because of (2) it must stay Node-builtins-only with no imports from other
modules - tsup bundles it as a standalone file (`splitting: false`).

The file ends with a "run standalone" footer that executes the guard when the
file is the program entry. The footer only fires when `process.argv[1]`'s
basename matches `guard.*`. This is deliberate: `cli.ts` imports `runGuardCli`,
so tsup also inlines `guard.ts` into `dist/enigma.js`; without the basename check
the inlined copy would auto-run the guard on every `enigma <command>` and exit
before dispatch. Keep that guard if you touch the footer.

## Adding a new policy skill

1. Create `assets/skills/<name>/SKILL.md` (YAML frontmatter with `name` +
   `description`) and `skill.json` (`name`, `version`, `description`; `provider`,
   `cliVersion`, and `sha` are filled by seal).
2. Wire it into `assets/skills/core-engineering-policy/SKILL.md`: add a trigger
   line under "Skill Activation Discipline" and an ownership line under "Harness
   Map". Bump core's `version`.
3. Restate it in both memory files (`assets/memory/AGENTS.md`,
   `assets/memory/CLAUDE.md`) under "Policy Skills" so it survives even when
   skills do not auto-load.
4. `npm run seal`, then `npm run check` and the dry-run preview.
