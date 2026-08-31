# The AI quality gate (`enigma gate`)

A faithful TypeScript port of upstream `no-mistakes` (vendored for reference at
`references/repos/no-mistakes`). Read that repo's `docs/src/content/docs/` before changing
pipeline semantics: the port tracks it 1:1, and its `concepts/pipeline.md`,
`concepts/auto-fix.md` and `reference/repo-config.md` are the specification.

Layout under `packages/enigma-cli/src/gate/`: `pipeline/` (executor + the nine steps),
`agent/` (one adapter per coding agent), `daemon/` (the background process, crash recovery,
the status-line snapshot), `db/` (SQLite over `bun:sqlite`), `scm/` (GitHub/GitLab/Bitbucket),
`intent/` (transcript readers), `cli/` (`axi`, `daemon`, `doctor`, `init`).

## What the nine steps cost

`intent -> rebase -> review -> test -> document -> lint -> push -> pr -> ci`. The order is
fixed and not configurable, by upstream design. In practice **review is essentially the whole
wall-clock of a run**: the other local steps are a shell exec or a git operation, review is a
full agent pass over the diff, and every fix round is *two more* full passes (one to apply
fixes, one to re-review). A run parked on review for 40 minutes is normal, not stuck - check
`~/.enigma/gate/logs/<run-id>/review.log` mtime to tell the difference.

Measured over 72 runs of this repo (`state.sqlite`, `step_results` summed by `step_name`),
39h of gate time split: **review 46.8%** (avg 15.6m, median 8.7m, p90 37.3m, 1.57 rounds per
review), **ci 32.2%** (avg 47m but median ~9.5m - the mean is three stuck workflows, one of
430m), test 14%, document and lint 6.5% combined, everything else under 1%. Re-run that query
before optimizing anything; the shape is not what it feels like from the status line.

Re-measured at 93 runs: median run **22.8m**, p90 59.1m, mean 30.9m (max 465m, a stuck CI).
So the "the gate always takes an hour" complaint is the p90, not the floor - quote the median.

### Head-to-head against upstream, on the same diff

Six runs over one 12-line diff (3 files), same agent and model, isolated gate homes,
`--skip push,pr,ci`, fresh clone each time, run sequentially so they never competed for the
API. Upstream binary was the `v1.45.3` release; the scaffolding is reproducible from this note.

|                       | no-mistakes            | enigma                 |
| --------------------- | ---------------------- | ---------------------- |
| total                 | 329 / 551 / 562 s      | 635 / 698 / 603 s      |
| review, initial pass  | 45.8 / 64.4 / 60.8 s   | 54.9 / 74.9 / 51.2 s   |
| review, fix round     | 228.3 / 198.8 (2 of 3) | 226.7 / 327 / 297 s    |
| test                  | 213.3 / 194.1 / 202.5  | 243.6 / 227.2 / 167.7  |
| document              | 63.8 / 59.4 / 95.1     | 106.5 / 65.4 / 83.7    |

**Per pass the two are indistinguishable** - the port costs what upstream costs, and the Go/TS
difference is noise next to an agent pass. The totals gap is entirely how often the review
returned `auto-fix` findings and bought a fix round (enigma 3 of 3, upstream 2 of 3); the
review prompt is byte-identical between `review.go` and `review.ts`, so that is model sampling,
not drift. The same run legitimately costs 5.5 or 10.6 minutes depending on the draw.

Two facts worth keeping from that floor:

- On a 12-line diff, **`test` + `document` were 46% of the run** while the initial review - the
  only pass that does what the product claims - was ~1 minute. `--skip test,document` is the
  honest lever for a throwaway change.
- **`test` spends a full agent pass even when `commands.test` is a shell no-op.** `test.ts`
  gates the evidence agent on `testCmd === "" || cleanedUserIntent(sctx) !== ""`, and `--intent`
  is mandatory to start a run, so a configured test command makes the step thorough, not cheap.

### What `agent_step_args_override` actually bought

Same harness, two more runs with `claude-sonnet-5` mapped onto intent, rebase, test, document,
lint and pr, review deliberately left on the strong model as the control:

| step     | default model             | mechanical steps on Sonnet |
| -------- | ------------------------- | -------------------------- |
| review   | 281.6 / 401.9 / 348.2 s   | 360 / 333.9 s (unchanged)  |
| test     | 243.6 / 227.2 / 167.7 s   | **65.1 / 65.5 s**          |
| document | 106.5 / 65.4 / 83.7 s     | 78.2 / 81.9 s              |
| total    | 635 / 698 / 603 s         | **506 / 485 s**            |

`test` fell 69% and is where the whole win comes from - it was spending a strong-model pass on
gathering evidence. `document` did not move (its cost is the diff read, not the reasoning), and
review staying inside its baseline range is what proves the map only touched the steps named in
it. Net 23% off the run for no quality change on the step that finds things.

A failure found while building the harness, worth reading before trusting its error message:
with the gate home under a deep path, the run died at review with `git diff --name-only
<base>..<head>: exit status 128: fatal: failed to stat '<base>..<head>': Filename too long`.

That message names neither the real problem nor a real file, and the error *class* is the
useful part. Git has two distinct failure paths here, verified against git 2.54:

- **It never parsed the value as a revision.** Git falls back to treating the argument as a
  pathspec and stats it, which is `verify_filename`; errno alone decides the wording, so
  `failed to stat '<X>'` and `ambiguous argument '<X>'` are the *same* path. A long enough
  argument turns ENOENT into ENAMETOOLONG, which is where `Filename too long` came from: the
  worktree sits at roughly 194 chars (`<gate home>/worktrees/<repo id>/<run id>`) and a
  `<sha>..<sha>` range adds 83.
- **It parsed the range but an endpoint is not a known object.** That reports
  `Invalid revision range` and never stats anything, so it is unaffected by a trailing `--`.

That distinction narrows the root cause rather than explaining it away. A full 40-hex base that
is simply missing from the worktree yields `Invalid revision range`, so it **cannot** produce
the stat message we saw. The failing base was therefore a value git could not parse as a
revision at all - an abbreviated SHA, a ref name, or a value carrying stray whitespace such as
a trailing CR - which points at `run.baseSha` itself, not at object availability.

Two changes follow from that. The trailing `--` lives in `git.diffNameOnly`, which every
name-only listing goes through - `review.ts` (single-rev in fix mode, range otherwise),
`document.ts` and `intent.ts` (`--diff-filter=d` via `extraArgs`) - so a new call site gets the
separator for free rather than from a comment telling it to. `git.diff`, `git.log`, the `pr.ts`
diffstat and `verify.ts` pass it directly, being different command shapes. Git can therefore
never reinterpret a range as a pathspec, and the failure names the revision.

And `resolveBaseSHA` in `commonGit.ts` resolves the incoming base through `rev-parse --verify
<base>^{commit}` before returning it, falling back to merge-base and then the empty tree SHA.
That guard is the one that matters: an empty or unparseable base previously flowed straight
into `<base>..<head>`, and git reads an empty left side as HEAD, so `git diff --name-only
..HEAD --` exits 0 with no output and the review step passes having reviewed nothing.

Both substitutions are announced, and where matters. `log.warn` alone lands in the daemon log
file, which nobody opens unless they already suspect the problem, so the resolver takes an
optional `ScopeNotifier` and every step passes `sctx.log` - the run-visible channel the
dashboard and `axi query` read. The empty-tree fallback is the reason: it widens the diff to the
whole repository, so review reports every tracked file as changed and the run gets slower and
noisier without failing. The empty tree stays the correct base for a genuinely empty history;
what it must never be is a silent catch-all for a broken base. An unusable base is now either
corrected or loud where it is being paid for, never silently vacuous.

Every path into that fallback reports, not just the one where a non-zero base failed
`rev-parse`. The zero ref (new-branch push) reaching the empty tree - default branch never
fetched into the disposable worktree, orphan branch, or an empty `defaultBranch` - is the more
common trigger, and it says so in its own words rather than claiming a broken base. A zero ref
that does find a merge-base is the expected new-branch path and stays quiet. The same
`ScopeNotifier` threads through `resolveDefaultBranchTip`/`unresolvedDefaultBranchTip`, whose
substitution feeds the rebase target in `ciFix.ts`.

Two traps that fall out of "a failing git call means this revision is unusable". First, a
cancelled run fails every git call the same way, so the fallbacks would print `base commit does
not resolve` at an operator who merely pressed cancel - a false diagnosis of exactly the kind
this work exists to remove. Every catch in `commonGit.ts` rethrows when the signal is aborted.
That makes the CI monitor's bounded tip lookup (`AbortSignal.any` with a resolve-window timeout)
throw where it used to swallow, so `ci.ts` owns its own deadline: it catches, rethrows only when
the run signal aborted, and otherwise treats the window expiring as a skipped poll. Second,
`git.diffRange` refuses a blank base outright instead of emitting `..HEAD`. `resolveBaseSHA` is
what keeps a blank base from reaching it; the funnel is what makes a regression there loud.
`tests/gate/common-git.test.ts` pins both invariants against real temp repositories, because a
silent pass is the one failure mode a green pipeline cannot show you.

The base a step diffs against is now canonical (`resolveBaseSHA` returns what git resolved, so
a ref name or CR-tainted value is normalized), and `intent.ts` shares that resolver instead of
keeping its own copy. None of this reproduces the original failure: why `run.baseSha` held an
unparseable value is still unknown, so do not read a green run under a short path as evidence
it is fixed - the warning is what will identify it next time.

The levers that actually change a run's duration and token cost, in order:

1. **The model, per step.** Each adapter spawns its agent's CLI with no model flag, so the gate
   inherits whatever that CLI defaults to (Claude Code: your configured model). Set it globally
   with `agent_args_override.<agent>` - `["--model", "claude-sonnet-5"]` for claude/opencode,
   `["-m", ...]` for codex - or **per step** with `agent_step_args_override.<agent>.<step>`,
   which layers over it. Review is where the judgment is; test, document, lint, rebase, pr and
   intent are mechanical, so giving only those a smaller model cuts the run without touching
   review quality. A step absent from the map keeps the agent-wide args, and with neither key
   set `configForStep` returns the config object unchanged, so the unconfigured path is exactly
   the old one. `RESERVED_AGENT_ARGS` in `gate/config.ts` lists what a user may NOT override
   (the flags enigma manages); the model is not one of them.
   Mechanism: all five adapters read their extra args from `agentArgsOverride[agent]`, so
   `configForStep(cfg, step)` folds the step's args into a cloned config and no adapter needed
   changing. `manager.startRun` caches one backend per distinct arg set and closes them all
   with the run.
   **Rollout order matters**: `loadGlobal` THROWS on an unknown field (`config.ts`, the
   `GLOBAL_KNOWN_KEYS` check), so writing `agent_step_args_override` into
   `~/.enigma/gate/config.yaml` before the binary that knows it is installed breaks every gate
   command instantly. Install first, then write the config.
2. **Fix rounds.** `auto_fix.review` is 0 by default, so review pauses for approval. Every
   `axi respond --action fix` is another two passes. Batch every finding into ONE fix round.
   Note this is the PIPELINE's own fixing; who answers the resulting pause is `fix_policy`,
   below. WHICH findings can open a pause at all is `gateSeverity` (CLI key `gate-severity`,
   `.enigma.json`, default `warning`): `hasBlockingFindings` (pipeline/findings.ts) compares
   every finding against it and only a finding at or above the threshold sets `needsApproval`,
   on all four finding-driven steps (review, test, lint, document). This is a TIME knob, not a
   coverage one - a finding below the threshold is still found, still recorded on the step
   outcome and still reported; it just does not cost a round. The failure mode it was added
   for: a diff where each full re-review surfaces one more `info`, answered with `fix`,
   answered again - ten rounds and four hours of review on a run whose measured average is
   1.57 rounds. The threshold comes from `readConfigAt(sctx.repo.workingPath)`, the registered
   repo rather than the worktree, same as `gateCommitMessage`; config reads are uncached, so a
   change applies to the next step the running daemon evaluates. An unrecognized severity never
   blocks. Three things it deliberately does NOT govern, each a place a run can still stop:
   (a) `autoFixable` - the executor's unattended auto-fix costs no approval round, so test.ts
   keeps the fixed error-or-warning bar (`hasFixableSeverityFindings`) instead of following the
   threshold, otherwise raising it would silently drop coverage; (b) the infrastructure pauses
   in ciChecks.ts and rebase.ts and document.ts's unparsable-output fallback, which set
   `needsApproval` unconditionally because they report a broken run rather than a graded
   finding; (c) nothing else - the executor's second park path, an `ask-user` finding, DOES
   honor it through `hasBlockingAskUserFindingsJSON` (same file), which is what keeps a
   low-severity `ask-user` from re-opening the very loop the threshold closes. Tests:
   `tests/gate/severity-threshold.test.ts`.
3. **`ignore_patterns`** in the repo's `.enigma-gate.yaml`: review and document read the whole
   diff, so lockfiles, generated clients, migrations and snapshots are pure cost.
4. **Explicit `commands.test` / `commands.lint`.** Left empty, those steps spend an agent pass
   *detecting* the project's test and lint setup. Set, they become a shell exec plus an exit
   code. Note the trust boundary: the daemon reads `commands` and `agent` from the DEFAULT
   BRANCH, never the pushed SHA, so they only take effect once committed there.

## Config: two files, one validator

Global `~/.enigma/gate/config.yaml`, per-repo `.enigma-gate.yaml` merged over it
(`gate/config.ts: merge`). Both are parsed with `Bun.YAML` (`gate/yaml.ts`), so **nothing that
touches gate config works under a Node dev runtime** - `dashboard-gate.ts` gates every such
path behind `canValidateConfig()` and degrades instead of failing.

`loadGlobal` does NOT enumerate `agent` or `log_level`; it accepts any string and the daemon
only fails later, at run time. Any new writer must range-check those itself (see `ENUM_KEYS`).
`fix_policy` is the exception and deliberately so: it is range-checked IN `loadGlobal`, which
throws on anything else, because the failure mode of a typo there is the run silently deciding
not to ask the user - and every writer goes through that loader, so one check covers them all.

## Finding the agent in a sandbox (`ENIGMA_AGENT_<NAME>`)

`resolveAgent` probes claude, codex, opencode, rovodev, pi **by binary name on PATH**. A
harness that installs its agent into a private directory and launches it by absolute path
therefore got "no supported agent found in PATH" on a machine that was running one - the
workaround was to write a `claude` shim and put it on PATH.

`ENIGMA_AGENT_CLAUDE=/abs/path` (also `_CODEX`, `_OPENCODE`, `_ROVODEV`, `_PI`) feeds
`agentPathOverride`, applied in `loadGlobal` so it lands whether or not a config file exists
and wins over `agent_path_override` in the YAML. Two things follow from where it is read:

- **The daemon executes the pipeline**, so the daemon's environment is the one that counts.
  A container that sets it before the first `axi run` is fine (the CLI spawns the daemon and
  it inherits); an already-running daemon needs `enigma gate daemon stop` first.
- **A broken override is named, and fatal only when nothing else resolves.** An override is
  an explicit instruction, and silently skipping a typo'd one is what produced the original
  "no agent installed" on a machine with an agent - so `resolveAgent` collects every override
  that failed to resolve and, if the probe ends with no agent at all, fails with a message
  naming those paths and their variables instead of the generic "no supported agent found in
  PATH". It does NOT abort the probe: a stale `ENIGMA_AGENT_CLAUDE` in a shell profile must
  not break a run on a machine where codex or opencode would have been selected. `gate doctor`
  shows the same thing as an `✗` naming the path and the variable.

`gh` is NOT a system requirement. It is reached only by the push, pr and ci steps (see
`stepCLIAvailable` in `pipeline/steps/commonExec.ts`); `gate init` shells out to git only, so
`axi run --skip push,pr,ci` runs to completion in an image that has no forge CLI. `doctor`
lists it as optional and says which steps use it.

## `fix_policy`: who answers a gate (an enigma extension)

Upstream's pipeline only knows "park and wait for a response"; WHO produces that response was
always the driving agent, guided by prose in the `/gate` command. Prose is skippable (this
repo's own thesis), and the user had no way to say "stop asking me about typos". So the global
config gained `fix_policy` - `ask` | `assisted` (default) | `auto` - and the DRIVE LOOP enforces
it, not the executor:

- The pipeline's semantics are untouched. `driveRun` already returned at the first gate without
  `--yes` and answered every gate with it; the policy just decides that per gate, through
  `canAutoResolve(policy, gate)` in `axiDrive.ts`.
- `assisted` is the only one that reads the findings: it hands the gate back when it carries an
  `ask-user` finding and answers it otherwise. So a review that only found mechanical nits is
  fixed and re-reviewed without a round trip through the user, and one carrying a judgment call
  still stops. Unparseable findings count as none - the same fallback `gateResolution` takes.
- `--yes` still wins for that run: an explicit flag is standing consent and outranks a setting.
- The gate object emitted to the agent carries `fix_policy` plus a `help` line saying what it
  means, because the agent's default instinct (authorize auto-fix, escalate ask-user) is exactly
  wrong under `ask`, where the user asked to see everything first.
- `canAutoResolve` is the COARSE half of `assisted`; the fine half is the agent's, and it is a
  bar, not a category. The dashboard sells `assisted` as "Fix, and ask about the rest", and the
  rest a user means is a genuine doubt - not permission to repair a defect the review just
  proved. So the `help` line, the `/gate` command and the memory kernel all state the same bar:
  escalate only when fixing it would contradict the request, undo a deliberate decision, change
  agreed behavior, or take a very large change. "Should I fix this?" is never escalated, because
  recommending a fix and then asking permission for it is the same question twice. Reported
  2026-08-06 by the user after two plain defects were relayed as questions. All four criteria
  travel together - the always-on kernel must never state a laxer bar than the skippable tiers,
  or the tier that always loads is the one that under-protects.
- `enigma verify` does NOT enforce that bar and is not meant to: `LEGITIMATE_STOP_RE` and
  `GATE_EXCUSE_RE` stand the stop-short block down on the bare `ask-user` token. Deliberate -
  an escalation that cleared the bar and one that should have been a `fix` read identically to
  a regex, and a false block lands on the turn that did everything right (verified-completion.md
  has the asymmetry). The bar lives in the tiers that can weigh a finding, not in the pattern.
- Same rule, one tier earlier: review's classification prompt (`steps/review.ts`) used to say
  "when in doubt, default to ask-user" and treated any user-visible finding as one, which is how
  a bug that DEFEATS the stated intent got marked `ask-user`. The test is now directional - would
  the fix contradict the author's intent, or carry it out - so a defect whose repair serves
  `--intent` is `auto-fix` and never parks the run.
- `readFixPolicy(p)` lives in `axiEnv.ts`, NOT `axiDrive.ts`: `axiQuery` needs it too and
  `axiDrive` already imports from `axiQuery`, so putting it there would close a cycle. It falls
  back to the default on any read failure - a config that will not parse must never be the
  reason the user stops being asked.

Note the gate reads one setting from the OTHER config (`.enigma.json`, not `.enigma-gate.yaml`):
`commitEmoji`. See the commit subjects section below.

## Commit subjects (`pipeline/steps/commitMessage.ts`)

A run commits into the same history the user's agent does, so its subjects honor the same
`commitEmoji` setting git-policy gives the agent: `<emoji> enigma(<step>): <summary>`, or the
bare `enigma(<step>): <summary>` when the user turned emojis off. The `enigma(<step>)` type is
kept from upstream so a pipeline commit stays recognizable, and the step is what the emoji is
picked from (review -> the `fix` emoji, document -> `docs`, lint -> `style`, and so on).

Every commit site goes through `gateCommitMessage`: the agent-fix rounds all commit through
the single exported `commitAgentFixes` in `commonFix.ts` (document.ts and lint.ts import it
rather than keeping their own copies), AND the two that used to be hardcoded strings,
`push.ts` ("apply agent fixes") and `ciFix.ts` ("apply CI fixes"). A new commit site must call
it too, or the setting silently stops holding for that step.

PR text is the exception: it stays emoji-free, title and body. `pr.ts` runs a candidate title
through `stripSubjectEmoji` before `tightenTitle`, since a leading emoji makes the
conventional-commit regex miss and would otherwise yield `chore: <emoji> fix(...): ...`; a title
that was only an emoji strips to empty and drops to `fallbackPRContent` rather than reaching
`gh pr create --title ""`. The body is covered at the source: the `git log --oneline` range is
passed through `stripCommitLogEmoji` the moment it is read, so neither the fallback
"## What Changed" section nor the commit history handed to the PR-content agent carries one.

The setting is read from `sctx.repo.workingPath`, not `sctx.workDir`: the worktree only carries
a `.enigma.json` that is committed, while the user's own may be untracked in the repo itself.

## The dashboard bridge (`dashboard-gate.ts`)

Two halves with independent availability: the config half is plain filesystem work, the run
half needs `bun:sqlite` and is imported dynamically.

- **Structured settings.** The form edits ONE dotted key per request *in place* - the config
  ships with more explanatory comments than settings, and regenerating it from parsed values
  would erase the only documentation most people read. `agent_args_override` is the exception:
  it is a nested list with no hand-written comments, so it is regenerated wholesale (preserving
  every other flag and every other agent). Every write, structured or raw, ends at
  `saveGateConfig`, which stages a temp file, parses it with the daemon's own loader, and only
  then renames it into place.
- **Liveness.** The daemon PID file is JSON (`{"pid":...,"started_at":...}`), not a bare
  integer - read it with `readDaemonPIDFile` from `gate/daemon/recover.ts`, never `parseInt`.
- **Live runs.** A step's `duration_ms` is only written when a round ENDS, so a step that is
  `running` or `fixing` would otherwise show a frozen number for its whole life. The view sends
  `started_at` plus a `serverNow` stamp and the browser ticks the active step against that,
  polling every 3s while a run is in flight and 20s when idle. Polling stops when the tab is
  hidden or the view is left, and a poll refresh repaints only the run strip - never an editor,
  or it would overwrite what is being typed.
- **What a run is DOING**, not just which step it is on. A run carries `activity` = the step in
  flight plus the tail of `<gate home>/logs/<run-id>/<step>.log`, which is the only place the
  pipeline says what it is actually working on. Computed ONLY for a live run (`LIVE_RUN_STATUS`),
  so a page listing twelve finished runs reads no log files at all; the tail is capped at 8 lines
  of 300 chars. The 1s tick repaints the elapsed counters only (`.gate-steps` and `.gate-act-h`),
  never the log block - replacing it every second would drop a text selection and reset its
  scroll.
- **Stopping a run.** `abortGateRun(runId)` is `axi abort --run <id>` without the CLI: a run
  lives in the DAEMON's memory, so this is an IPC `cancelRun` over `Paths.socket()`, and a dead
  daemon means there is nothing in flight. Idempotent on purpose - by the time a click lands the
  run may have finished, so "no active run" reports success, not an error. The button only
  renders on a run the payload marked `live`, and it confirms first (naming the branch, not the
  run id) because a stopped pipeline cannot be resumed.

## The run ledger (`src/gate-ledger.ts` + `daemon/ledger.ts`)

- WHY: the reported failure was agents SKIPPING the gate while it was on - either handing it
  back ("the gate has not run, tell me if you want me to launch it") or ending the turn
  silently with commits nothing reviewed. The memory kernel already said to drive it, which is
  this repo's own thesis again: rules persuade, gates enforce. So the completion gate
  (`verify.ts`) now checks it, and to check it, it has to know whether any run ever saw those
  commits.
- MECHANISM: same Bun/Node split that forced the status-line snapshot - the turn-end hook runs
  on the Node launcher and cannot open `bun:sqlite`. `daemon/ledger.ts` writes
  `<gate home>/last-runs.json` (repo path -> branch, head, status, `updatedAt`) from the same
  `broadcast` that refreshes the snapshot; `gate-ledger.ts` is the Node-safe half both sides
  share, so the filename and shape have ONE definition: `Paths.runLedgerFile()` delegates to it
  and is what the writer PASSES (the record/read functions take the file, not a home to
  re-derive it from), so nothing under a resolved gate home names `last-runs.json` twice.
  Unlike the snapshot it must OUTLIVE the run: a gate that finished an hour ago is exactly
  what makes the next completion claim legitimate.
- Every state change is recorded, in-flight runs included. A turn that ends while the pipeline
  is parked awaiting the driving agent did NOT skip the gate, and blocking it would be a false
  block - the one thing that gets a gate switched off.
- The STATUS is read, though, and `failed`/`cancelled` vouch for nothing (`validatingRun`).
  `broadcast` records the `EventRunCompleted` the executor emits for a run it failed or
  aborted too, so without that rule `axi run` followed by `axi abort` left a fresh entry that
  stood both checks down permanently - the enforcement cleared by the two commands that do the
  least work. The catch is that an abort must not erase the run that DID clear the work, so a
  record carries the run it displaced as `prior` (flattened to one generation) and a `runId`,
  which is what keeps a run's own `pending`/`running` stamps from vouching for it after it dies.
- The `branch` a record carries is READ, not decoration: the pipeline reviews, fixes and pushes
  one branch, so `verify.ts` only lets a run vouch for the branch it ran on. Without that a run
  on `feature` stood the check down over commits sitting on `main` that nothing ever looked at.
- Still a derived cache: deleting it costs one extra gate run, not correctness. A repository
  with no entry reads as "never validated here", which is the honest answer.

## Gotchas

- Windows: worktree teardown routinely logs `git worktree remove failed, falling back to
  recursive delete`. Cosmetic; the fallback removes it.
- `spawnDetachedDaemon` re-execs `process.argv[1]` under node/bun and takes no subcommand under
  the compiled binary. Testing `startDaemon` by importing it from a scratch script therefore
  re-runs that script, not the daemon - verify daemon start/stop through the real binary
  (`enigma gate daemon start` with an isolated `ENIGMA_GATE_HOME`).
- THE TEST STEP HAS A SECOND PHASE and it can fail a run whose tests all passed. `commands.test`
  runs first and its exit code is not the end: whenever user intent was extracted (any `--intent`
  run), `useEvidenceAgent` is also true, and an agent is asked to explore the repository and
  produce end-user evidence. Four consecutive runs on `verify.ts` died there with
  `Autocompact is thrashing ... claude exited: exit status 1` while `npm run verify` passed inside
  the same step every time - so `outcome: failed, error: step test failed` can mean the evidence
  agent ran out of context, not that anything is broken. Read the step log before believing the
  outcome. A contributing term was measured and fixed (`tests/verify.test.ts` wrote 57 KB of the
  hook's own stderr, three quarters of the package's test output, and an agent running the suite
  pays for all of it), and it was not sufficient on its own. The step ends up unreachable for a
  change this size: review and its fix rounds land, `document` onward never run, and nothing is
  pushed.
- THE DOCUMENT STEP DIES THE SAME WAY, and the trigger is not the test suite's output. A
  policy-skill change (markdown only, no executable code) took it down with the identical
  `Autocompact is thrashing` after the agent had already reported its conclusion ("no
  documentation gap"), because `packages/enigma-cli/assets/skills/frontend-policy/SKILL.md` alone
  is ~84 KB and any agent that reads the changed files whole pays for it. Treat the thrash as a
  property of the files in the diff rather than of one step: `--skip test,document` is the way
  past it, and the skip belongs in the reported outcome because neither test evidence nor a docs
  check was gathered.
- THE RUN IS NOW RIGHT-SIZED TO ITS DIFF (`pipeline/profile.ts`, applied in `startRunLocked` via `rightSizeSkips`), which is the automatic form of the `--skip test,document` conclusion above. Reported symptom: "a un agente le pedi agregar una cosa a un slash command y solo para eso ha ejecutado el gate que tarda horas". THE AXIS IS FILE CLASS, NEVER SIZE. Size is the dangerous one - a three-line change to an auth check deserves every step - while "this diff contains no executable file" is a FACT about the diff, not a judgement about the work, and it makes two steps structurally unable to say anything: `test` has nothing new to exercise, and `document` is being asked whether a documentation change needs documenting. Those two are skipped and nothing else is: `review` still runs on a prose-only change because prose can be wrong, and push/pr/ci are how the work ships. UNKNOWN COUNTS AS CODE - a file with no extension, a Dockerfile, a language not in the list - so the profiler over-runs rather than under-runs, and an unreadable diff runs the whole pipeline. An explicit `--skip` still wins: `rightSizeSkips` only ever ADDS to what the caller asked for. Covered by `tests/gate/change-profile.test.ts`, which checks the conservative direction of every classification as well as the useful one.
- A FAILED RUN STRANDS ITS FIX COMMITS RATHER THAN LOSING THEM. Each `--action fix` round commits
  into the run's isolated clone at `<gate home>/repos/<repo id>.git`, on the run's own branch
  (`commitAgentFixes` ends the round with `git update-ref refs/heads/<run branch>`), and only the
  `push` step brings them back - so a run that dies at `test` or `document` leaves the working
  repo untouched with no reflog trace, and `axi status` reports a `head` git cannot resolve.
  Recover them instead of redoing the work by hand: `enigma gate init` already wired that clone
  into the working repo as the `gate` remote, so `git fetch gate <run branch>:refs/gate/roundN`
  from the working repo is the whole retrieval - read the diff, then fast-forward. Only when that
  remote was removed or the working directory moved do you have to locate the clone yourself
  (`for r in <gate home>/repos/*.git; do git --git-dir="$r" cat-file -t <sha> && echo "$r"; done`)
  and fetch `<run branch>` from the path it prints. Four rounds of review fixes were recovered
  this way across three failed runs of one change.
