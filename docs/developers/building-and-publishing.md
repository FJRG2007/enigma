# Building and publishing

How `enigma-cli` is built and released to npm.

## Building

```bash
npm run build
```

This runs tsup (`packages/enigma-cli/tsup.config.ts`) and produces two ESM
bundles in `packages/enigma-cli/dist/`:

- `dist/enigma.js` - the CLI (the package `bin`). `@clack/prompts` stays external
  (it is a runtime dependency).
- `dist/guard.js` - the self-contained commit guard, bundled with no shared
  chunks (`splitting: false`) so it can be copied into any repo and run with only
  Node builtins.

Both get a `#!/usr/bin/env node` shebang banner and target `node18`. `clean:
true` wipes `dist/` first, so the output is always fresh.

`dist/` is gitignored. It is produced at publish time and shipped in the npm
tarball; it is never committed.

## What gets published

From `packages/enigma-cli/package.json`:

- `name`: `enigma-cli`, `bin`: `{ "enigma": "dist/enigma.js" }`.
- `files`: `["dist", "assets", "README.md", "LICENSE"]` - only these go in the
  tarball. Source (`src/`) and configs are not published.
- `prepublishOnly`: `npm run verify && npm run build` - npm runs this
  automatically before packing, so a publish cannot ship type errors, unsealed
  skills, or a stale `dist`.

Because `assets/` is shipped, the published package carries the skills and memory
files; the installed CLI copies them out of its own package directory.

## Versioning and the re-seal requirement

The version that matters for a release is
`packages/enigma-cli/package.json` `version`.

Each skill's `skill.json` records a `cliVersion`, stamped by `seal`. The
integrity gate (`check`) fails if any skill's `cliVersion` does not equal the
current package version. Therefore:

> Bumping the `enigma-cli` version REQUIRES a re-seal, or `check` / `verify` /
> `prepublishOnly` / CI will fail.

The bump sequence:

1. Edit `version` in `packages/enigma-cli/package.json`.
2. `npm run seal` - restamps every skill's `cliVersion` (and any changed `sha`).
3. `npm run verify` - typecheck + check + guard, all green.
4. Commit the version bump and the re-sealed `skill.json` files together.

Bump the skill's own `version` (separate from `cliVersion`) only when its content
actually changes.

### Pitfall: keep the bump and the re-seal in one merge

The bump and the re-seal must reach `main` together. The version bump alone makes
every skill's `cliVersion` stale, so any commit that carries the bump but not the
re-seal fails `check` / `verify`.

This bit us once: the bump and the re-seal lived in two separate commits, and the
PR was squash-merged after the bump but before the re-seal commit was pushed.
`main` landed with `package.json` at the new version but `skill.json` still on the
old `cliVersion`. The result:

- CI on `main` went red (`verify` failed on the stale seal).
- The tagged release's `publish.yml` run failed at the `verify` step, so the
  version never reached npm even though the git tag existed.

To avoid it:

- Put the bump and the re-sealed `skill.json` files in the SAME commit (or at
  least the same PR), and confirm the PR's CI is green before merging.
- If you squash-merge, make sure the re-seal commit is already part of the PR -
  do not push it after starting the merge.

Recovery if `main` ships stale: branch from `main`, run `npm run seal`, verify,
and merge a reseal-only fix; then re-publish. Because the failed release never
pushed anything to npm, that version number is still free - re-run `publish.yml`
via `workflow_dispatch` (or recreate the release) once `main` is green.

## Release flow (recommended)

The publish workflow checks that the git tag matches the package version, so the
clean path is a tagged GitHub Release:

1. Bump + re-seal + verify (above), on a topic branch.
2. Open a PR; CI (`ci.yml`) runs `verify` and `build`.
3. Merge to `main`.
4. Create a GitHub Release tagged `vX.Y.Z` where `X.Y.Z` exactly matches the
   `enigma-cli` version.
5. `publish.yml` fires on the published release: it re-verifies, builds, checks
   `tag == version`, skips if that version is already on npm, then runs
   `npm publish --workspace enigma-cli --provenance --access public`.

Requires the repo secret `NPM_TOKEN` (an npm automation token with publish
rights). Provenance needs `id-token: write`, already set in the workflow.

### Other publish triggers

`publish.yml` also runs on:

- `workflow_dispatch` - manual run from the Actions tab (no tag check).
- a push to `main` whose head commit message contains `publish:` - convenient
  for a quick release without cutting a GitHub Release. It still skips cleanly if
  the version is already on npm, so remember to bump first.

A plain push to `main` without `publish:` does not publish; it only runs CI.

## Publishing manually (without CI)

If you ever publish from your machine:

```bash
# from the repo root, after a clean `git status`
npm publish --workspace enigma-cli --provenance --access public
```

`prepublishOnly` runs `verify && build` first, so this is as safe as the CI path
for integrity. You still need to be logged in to npm (`npm whoami`) with publish
rights, and you should bump + re-seal + tag beforehand to keep npm and git in
sync. Prefer the CI release flow; manual publish is a fallback.

## CI summary

- `.github/workflows/ci.yml` - on push to `main` and on every PR: `npm ci`,
  `npm run verify`, `npm run build`. This is the merge gate.
- `.github/workflows/publish.yml` - on release / dispatch / `publish:` push:
  verify, build, tag-vs-version check (releases only), skip-if-already-published,
  then `npm publish`.
