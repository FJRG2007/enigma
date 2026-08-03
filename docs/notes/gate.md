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
  polling every 5s while a run is in flight and 20s when idle. Polling stops when the tab is
  hidden or the view is left, and a poll refresh repaints only the run strip - never an editor,
  or it would overwrite what is being typed.

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
  share, so the filename and shape have ONE definition (`Paths.runLedgerFile()` delegates to
  it). Unlike the snapshot it must OUTLIVE the run: a gate that finished an hour ago is exactly
  what makes the next completion claim legitimate.
- Every state change is recorded, in-flight runs included. A turn that ends while the pipeline
  is parked awaiting the driving agent did NOT skip the gate, and blocking it would be a false
  block - the one thing that gets a gate switched off.
- Still a derived cache: deleting it costs one extra gate run, not correctness. A repository
  with no entry reads as "never validated here", which is the honest answer.

## Gotchas

- Windows: worktree teardown routinely logs `git worktree remove failed, falling back to
  recursive delete`. Cosmetic; the fallback removes it.
- `spawnDetachedDaemon` re-execs `process.argv[1]` under node/bun and takes no subcommand under
  the compiled binary. Testing `startDaemon` by importing it from a scratch script therefore
  re-runs that script, not the daemon - verify daemon start/stop through the real binary
  (`enigma gate daemon start` with an isolated `ENIGMA_GATE_HOME`).
