---
name: ci-policy
description: CI/CD pipeline policy for any provider (GitHub Actions, GitLab CI, CircleCI, Buildkite, Azure Pipelines, Jenkins, Bitbucket) - cut wall-clock and runner minutes without dropping a single test or check, measure before and after, one pipeline per commit, caches keyed by a hash of their inputs and never saved from a failed build, no check run twice, sharding, change filters that cannot leave a required check pending, flakes fixed at the root instead of retried, and workflow security (pinned third-party actions, least-privilege tokens, untrusted pull-request code kept away from secrets). Use when creating, editing, debugging, speeding up, or reviewing any CI pipeline or workflow file (.github/workflows, .gitlab-ci.yml, .circleci, azure-pipelines.yml, Jenkinsfile, bitbucket-pipelines.yml, buildkite), or when a build is slow, flaky, red, or burning minutes.
---

# CI Policy (Pipelines & Workflows)

## Activation Scope

- Apply whenever a pipeline definition is created, edited, reviewed, or debugged, and whenever the task is "CI is slow / flaky / red / too expensive".
- Owns pipeline structure, triggers, caching, parallelism, change filtering, and workflow-level security. Which tests exist and how they are written stays with testing-policy; what gets installed and how it is pinned with dependency-policy; secrets and tokens with security-policy; commits and PRs with git-policy.
- Provider-specific mechanics live in references, read only for the provider the repository uses:
  - GitHub Actions -> `references/github-actions.md`.
  - Any other provider -> the concept map at the end of this file, then that provider's own docs. Never carry a GitHub syntax or limit over to another provider by assumption.

---

## Core Principle

- The pipeline exists to tell the truth about a commit. Every optimization keeps that truth intact: the same tests and checks run, on the same code, with the same pass/fail meaning. A faster pipeline that checks less is a regression, not an optimization.
- Optimize only what a measurement points at. CI changes are cheap to write and expensive to get wrong (a broken cache, a skipped required check, a secret exposed to a fork), so each change must name the number it is meant to move.

---

## 1. Measure First, Optimize the Critical Path

- Before changing anything, pull per-job and per-step timings for several recent runs from the provider's API or UI, not from one run and not from memory.
- The wall-clock of a pipeline is its slowest dependency chain (the critical path), not the average job. Shortening a job that is not on the critical path saves runner minutes but no waiting time; say which of the two a change targets.
- Separate the fixed cost of a job (provisioning, checkout, dependency install, cache restore) from its work. Many small jobs that each repeat a 60-90 second setup can be slower and costlier than fewer larger ones.
- After the change lands, measure the same jobs on the next real runs and report the before/after numbers. An estimate is not a result.

---

## 2. One Pipeline per Commit

- A commit should trigger the full suite once. The common duplicate is a pipeline triggered both by the branch push and by the pull/merge request for the same commit; the two runs have different refs, so concurrency grouping never merges them.
- Choose one trigger per context: pull/merge request events for proposed changes, push for the default branch (and release branches or tags) where post-merge work actually needs it, and a manual trigger for branches that have no pull request yet.
- Cancel superseded runs of the same pull request or branch when a newer commit arrives. Never cancel runs on the default branch or release refs, where every commit's result matters (deploys, cache warm-up, status history).
- Put a timeout on every job. A hung job holding a runner for the provider's default maximum is the most expensive failure there is.

---

## 3. Caching

### Key by inputs, never by time or branch

- A cache key is a hash of everything that determines the cached content: the lockfile for a dependency cache; for a build-output cache, the sources, lockfile, patches, shared compiler config, build scripts and toolchain version - with outputs, dependency folders and generated files excluded from the hash. Any input change then misses and rebuilds, so the cache can never serve stale output.
- Add an OS/architecture and toolchain-version component to the key when the content depends on them (native modules, compiled artifacts).
- Restore-key prefixes (partial matches) are fine for dependency stores that the tool revalidates (npm/pnpm/pip/Gradle caches). They are wrong for build outputs, where a partial match means using output built from different sources.
- When the same key has to appear in several jobs or pipelines, define it once (a shared action, template, anchor, or include) instead of repeating the expression.

### Never save a broken cache

- Save a cache only when the step that produced it succeeded. When a job continues on error, split restore and save into separate steps and guard the save on that producing step's own success, not the job's.
- A cache that is written from a failed or partial build poisons every later run that restores it, and the failure then looks unrelated to the change that caused it.

### Know the scope rules

- Every provider limits which runs can read which caches (by branch, by protected status, by pipeline). Read the provider's rule before designing around it. A typical consequence: pull requests can read the default branch's cache, so if nothing ever saves on the default branch, every pull request starts cold.
- When pull requests start cold for that reason, add a small post-merge pipeline on the default branch whose only job is to build and save the caches pull requests restore. It must never mark a commit as failed: tools that read a commit's checks (merge gates, deploy and update gates) treat any failed check as a broken commit, so make its steps non-gating and let a cancelled run be the worst outcome.
- Caches written by short-lived refs (one pull request) are usable only by that ref. Keep them small, and delete them when the ref closes when the provider's storage quota is shared, so they never evict the default branch's caches.

### Check the cache actually helps

- A cache that takes longer to restore than the work it replaces is a cost. Compare restore time with rebuild time from the step timings, and drop or narrow caches that lose.

---

## 4. Do Not Run the Same Check Twice

- Map which job runs which check. If a dedicated job runs lint, type-check, or a security scan, a later build step must not repeat it - turn the duplicate off for that CI job only (an environment flag or CLI option), so local and release builds keep it.
- Before removing a "duplicate", confirm it really is one. A framework build sometimes checks things a standalone tool cannot see (files generated during the build, for example); keep the check that covers more, or generate those files first so the standalone check sees them too.
- Build once, reuse the artifact. Jobs that need the built output download it from the producing job instead of rebuilding it.

---

## 5. Parallelism

- Split a slow suite into shards when it is on the critical path. Each shard runs a fixed, deterministic slice, so coverage is unchanged; let every shard finish (no fail-fast across shards) so one failure does not hide others.
- Balance shards by measured duration, not by file count, and check the slowest shard after the change: the pipeline is as fast as its slowest shard.
- When the suite produces coverage or test reports, merge the per-shard reports before any coverage gate evaluates them. A gate reading one shard's report fails or, worse, passes on partial data.
- Run independent jobs in parallel and declare only real dependencies between them. A dependency that exists only out of habit serializes the pipeline.

---

## 6. Run Only What a Change Can Affect, Precisely

- Change filters (paths, rules:changes, and the like) may skip a pipeline only for files that provably cannot affect any test or check. Before excluding a path, grep the test suite and build for it: tests sometimes read a README, a docs file, or a fixture outside the source tree as input.
- Prefer narrow exclusions ("this docs folder", "markdown at this package root") over broad ones ("every *.md").
- A skipped pipeline must not leave a required check pending. If a check is required for merging, skip the work inside the pipeline (a job- or step-level condition that reports success) rather than skipping the whole pipeline at the trigger level, or the pull request can never merge.

---

## 7. Flakes Are Bugs

- Never paper over a flaky test with automatic retries, a rerun-until-green job, or a raised timeout. A retry hides real intermittent defects (races, ordering, time zones) and doubles the cost of every genuine failure. Fix the root cause or quarantine the test with a tracked reason (testing-policy).
- Reproduce a flake by running the single test many times with the same seed and environment as CI, and by randomizing order. A flake that never reproduces locally usually depends on CI-specific state: parallelism, clock, locale, file system case, or available CPU.
- When the cause is found, sweep the suite for the same pattern and fix every instance in the same change.

---

## 8. Security of the Pipeline Itself

- Pin third-party actions, orbs, templates, and container images to an immutable reference (a full commit SHA or an image digest), with the human-readable version in a comment, and let an update bot move the pin. A tag can be moved to malicious code after you reviewed it.
- Grant the pipeline token the least privilege it needs, set at the top of the pipeline and widened only on the job that needs more.
- Code from an untrusted contributor (a fork's pull request) must never run in a context that has secrets or a write token. Triggers that run with the base repository's privileges are for metadata-only work (labelling, cache cleanup, commenting) and must not check out or execute the contributor's code.
- Never interpolate untrusted event fields (titles, branch names, commit messages, comment bodies) directly into a shell script. Pass them through an environment variable and quote it.
- Secrets reach only the jobs and steps that use them, and are never echoed, written to artifacts, or stored in caches.

---

## 9. Verify a Pipeline Change Before It Merges

- Lint the definition with the provider's linter or validator, and parse it as YAML, before pushing (for GitHub Actions: actionlint).
- Run the changed pipeline on a branch or pull request and read the result of every changed job, including the ones that are supposed to skip.
- After merge, confirm the side effects the change was for (the cache was saved on the default branch, the duplicate run is gone, the shard times balanced) and report the measured numbers against the baseline from step 1.

---

## Provider Concept Map

The rules above are provider-neutral. The names differ:

| Concept | GitHub Actions | GitLab CI |
| --- | --- | --- |
| Pull/merge request trigger | `on: pull_request` | merge request pipelines (`workflow: rules` on `$CI_PIPELINE_SOURCE == "merge_request_event"`) |
| Avoid branch + MR duplicates | drop `push` for non-default branches | `workflow: rules` that skip the branch pipeline while an MR is open (`$CI_OPEN_MERGE_REQUESTS`) |
| Cancel superseded runs | `concurrency` + `cancel-in-progress` | `interruptible: true` + auto-cancel redundant pipelines |
| Input-hashed cache key | `hashFiles(...)` in `key` | `cache: key: files:` |
| Change filter | `paths` / `paths-ignore` | `rules: changes:` |
| Job timeout | `timeout-minutes` | `timeout:` |
| Shared definition | composite action, reusable workflow | `include:`, `extends:`, YAML anchors |

For any other provider, map each rule to its equivalent from that provider's documentation before applying it, and say so when a rule has no equivalent there.
