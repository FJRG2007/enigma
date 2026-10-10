# GitHub Actions specifics

Read with ci-policy when the repository's pipelines live in `.github/workflows`. Each section maps to the numbered rule of the same topic in SKILL.md.

## Measure

- Per-job and per-step timings of a run: `gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs`, then `jobs[].steps[].started_at` / `completed_at`. List recent runs of one workflow with `gh run list --workflow <file> --limit 20 --json databaseId,conclusion,createdAt`.
- Compare the same job across several runs; a single run's numbers include runner and cache noise.

## One run per commit

```yaml
on:
  pull_request:
  push:
    branches: [main]        # only where post-merge work needs it
  workflow_dispatch:        # branches without a pull request

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- `on: push` without a `branches` filter plus `on: pull_request` runs the suite twice for every pull request commit: the push run is on `refs/heads/<branch>`, the pull request run on `refs/pull/<n>/merge`, so they never share a concurrency group.
- `cancel-in-progress` is limited to pull requests so default-branch runs are never cancelled.
- Every job gets `timeout-minutes`; the default is 360.

## Cache scope

- A run restores caches from its own ref and the default branch; a pull request run also from its base branch. It cannot restore caches from sibling or child branches.
- A cache saved by a pull request run is scoped to `refs/pull/<n>/merge` and only that pull request can restore it.
- Default quota is 10 GB per repository. Entries not accessed for 7 days are removed, and above the quota the least recently accessed go first - so pull request caches can evict the default branch's.
- A key's content cannot be changed once saved; a new content needs a new key.

### Warm the default branch

A non-gating workflow on `push` to the default branch that builds and saves what pull requests restore. Steps use `continue-on-error: true` so the commit never shows a failed check:

```yaml
- id: build
  continue-on-error: true
  run: npm run build
- if: steps.build.outcome == 'success'
  uses: actions/cache/save@<sha> # vX.Y.Z
  with:
    path: packages/*/dist
    key: ${{ steps.key.outputs.value }}
```

- `steps.<id>.outcome` is the result before `continue-on-error` is applied; `conclusion` is after it and reads `success` for a failed step. Guard saves on `outcome`.
- Split `actions/cache` into `actions/cache/restore` + `actions/cache/save` whenever the save must depend on a specific step.

### Build-output cache keyed by inputs

```yaml
- id: build-cache
  uses: actions/cache/restore@<sha> # vX.Y.Z
  with:
    path: packages/*/dist
    key: build-${{ runner.os }}-${{ hashFiles('packages/*/src/**', 'package-lock.json', 'patches/**', 'tsconfig*.json', '!**/dist/**', '!**/node_modules/**') }}
- if: steps.build-cache.outputs.cache-hit != 'true'
  run: npm run build
```

- Adapt the `hashFiles` globs to the repository's real inputs; a missing input means a stale hit.
- Share a key used by several jobs or workflows through a local composite action (`.github/actions/<name>/action.yml`) that computes it as an output, instead of repeating the expression.
- Dependency stores: prefer the setup action's built-in cache (`actions/setup-node` with `cache: npm`, `setup-python` with `cache: pip`) over a hand-written one.

### Clean up pull request caches

```yaml
on:
  pull_request_target:
    types: [closed]
permissions:
  actions: write
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          REF: refs/pull/${{ github.event.pull_request.number }}/merge
        run: |
          gh cache list --ref "$REF" --limit 100 --json id --jq '.[].id' |
            while read -r id; do gh cache delete "$id"; done
```

- `pull_request_target` runs with the base repository's token, which is why it can delete caches for fork pull requests too. It is safe here only because it checks out and executes nothing from the pull request - keep it that way.

## Required checks and change filters

- A workflow skipped by `paths`, `paths-ignore`, `branches` or a commit message leaves its required checks "Pending", which blocks the merge.
- A job skipped by an `if:` condition reports "Success". For a required check, run the workflow always and skip at job level, deciding with a first job that inspects the changed files (`git diff --name-only` against the base, or a vetted, SHA-pinned path-filter action).

## Do not lint twice

- When a separate job lints, disable the framework's build-time lint only in that CI job (an env var read by the framework config), so local and release builds keep it. Check the framework version first: some versions no longer lint during build at all.
- Before dropping a build-time type check in favor of a standalone one, check whether the build generates types the standalone check needs (route types, codegen); generate them first or keep the build's check.

## Sharding

```yaml
strategy:
  fail-fast: false
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: npx vitest run --shard=${{ matrix.shard }}/4
```

- Collect each shard's report as an artifact and merge them in a final job (for Vitest: `--reporter=blob` per shard, then `vitest --merge-reports`) before any coverage threshold runs.

## Security

- Pin every third-party action to a full commit SHA with the version as a comment (`uses: owner/action@<40-char-sha> # v4.2.1`), and let Dependabot (`package-ecosystem: github-actions`) or Renovate move the pins.
- Set `permissions:` at the top of every workflow (`contents: read` as the baseline) and widen per job.
- `actions/checkout` with `persist-credentials: false` unless a later step pushes.
- `pull_request_target` and `workflow_run` run with secrets and a write token: never check out `github.event.pull_request.head.sha` / `head.ref` or run the contributor's code there.
- Never put `${{ github.event.* }}` text fields (titles, bodies, branch names, commit messages) directly inside `run:`; pass them through `env:` and quote the variable.

## Verify

- `actionlint` on every changed workflow (install a pinned release and check its checksum, per dependency-policy). It also runs shellcheck over `run:` blocks when shellcheck is installed.
- After merge: `gh cache list --ref refs/heads/main` shows the warm-up saved; `gh run list` shows one run per commit; compare the critical-path job's duration with the baseline.
