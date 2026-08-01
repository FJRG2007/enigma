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

The levers that actually change a run's duration and token cost, in order:

1. **The model.** Each adapter spawns its agent's CLI with no model flag, so the gate inherits
   whatever that CLI defaults to (Claude Code: your configured model). Set it explicitly with
   `agent_args_override.<agent>` in the global config - `["--model", "claude-sonnet-5"]` for
   claude/opencode, `["-m", ...]` for codex. `RESERVED_AGENT_ARGS` in `gate/config.ts` lists
   what a user may NOT override (the flags enigma manages); the model is not one of them.
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

## Gotchas

- Windows: worktree teardown routinely logs `git worktree remove failed, falling back to
  recursive delete`. Cosmetic; the fallback removes it.
- `spawnDetachedDaemon` re-execs `process.argv[1]` under node/bun and takes no subcommand under
  the compiled binary. Testing `startDaemon` by importing it from a scratch script therefore
  re-runs that script, not the daemon - verify daemon start/stop through the real binary
  (`enigma gate daemon start` with an isolated `ENIGMA_GATE_HOME`).
