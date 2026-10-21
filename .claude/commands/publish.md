---
description: Commit everything to origin/main, release every package whose code changed, and update enigma on this machine
argument-hint: "[patch|minor|major] [notes]"
---

Ship this repository end to end. Invoking this command is the user's instruction to commit and push straight to `main` and to publish: do not open a PR, and do not drive the AI quality gate (say "gate skipped by /publish" in the report). Arguments, optional: a bump level that overrides the default, and notes for the release text: $ARGUMENTS

Run every step; stop only on a real blocker (failing verification, a merge conflict you cannot resolve without losing work, missing credentials) and name it.

## 1. Start from the real main

1. `git fetch origin` and compare `main` with `origin/main`. If not on `main`, switch to it (bring the branch's work along with a merge or cherry-pick; never abandon commits).
2. Behind `origin/main`: `git pull --rebase --autostash origin main` BEFORE committing anything. Releasing from a stale base is how a version gets bumped twice or upstream work gets reverted.
3. A conflict: resolve it keeping both sides' intent. A local change that is already upstream in another form is dropped, not re-applied.

## 2. Commit everything that belongs to the project

1. Read `git status` and the full diff. Group the changes into atomic Conventional Commits with the type emoji (git-policy); every commit message describes what changed.
2. Leave out and report: scratch files (`scratch-*`, temp output, logs), anything holding a secret or a private value, and editor or machine-local files. Never `git add -A` blind.
3. After editing any `SKILL.md`, bump that skill's `version` in its `skill.json`; `npm run seal` runs in step 4 anyway.

## 3. Verify

1. `npm run verify` must pass.
2. Run each changed or related test file on its own (`bun test <file>`): a bare `bun test` gives false results here.
3. A failure is fixed and committed, or it is the blocker. Never release over a red check.

## 4. Release the packages that changed

For each workspace in `packages/*`, the last release is the commit that last changed the `version` line of its `package.json`: `git log -1 --format=%H -G'"version"' -- packages/<p>/package.json`. The package needs a release when `git diff --quiet <that>..HEAD -- packages/<p>` reports changes. Bump level: the argument if given, else `minor` when any commit since then is a `feat`, else `patch`.

1. Bump each with `npm version <x.y.z> -w <workspace> --no-git-tag-version` (updates `package-lock.json` too).
2. `enigma-cli`: also set `version:` in `CITATION.cff`, then `npm run seal` (a stale `cliVersion` fails `check`). The bump and the seal go in ONE commit.
3. `npm run verify` again, then one commit: `🔖 chore(release): enigma-cli X.Y.Z, @enigmax/<pkg> A.B.C` (only the packages bumped).
4. `git push origin main`.
5. Trigger the publish:
   - `enigma-cli`, `@enigmax/dashboard`, `helio`, `orion`, `vega`: `gh release create vX.Y.Z --target main --title "enigma-cli X.Y.Z" --notes "<one line per user-facing change>"`. Even when only a non-cli package changed, `publish.yml` is what publishes it: run `gh workflow run publish.yml`.
   - `primitives`, `utils`, `icons`: published by `publish-components.yml` on the push.
   - `linter`: `gh workflow run publish-linter.yml`.
6. Wait for the runs in a background command (no foreground sleep loop) and confirm each `npm view <name> dist-tags.latest --prefer-online` shows the new version. A run that published but npm still shows the old version is registry lag: wait, do not re-publish.

Nothing changed in any package: say so and skip to step 5.

## 5. Update this machine

1. `enigma update --yes`, then `enigma --version` must print the version just published.
2. `EBUSY` means other agent sessions hold the binary: name that as the blocker. Do not kill their processes.

## 6. Clean up and report

Remove any worktree or branch this command created. Report as a table: commits pushed (hash + subject), packages published with versions (verified on npm), local version, files left uncommitted and why, and anything still unverified.
