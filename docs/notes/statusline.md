# The agent status bar (`enigma statusline`)

What an agent's status line shows: the `[ENIGMA]` badge, the session's model,
project, context meter and cost, and - while a gate run is in flight - a second
line with live pipeline progress.

## Why it exists

A gate run is one blocking `enigma gate axi run` call that can sit for minutes.
Nothing in a coding harness reports progress inside a blocking tool call: hooks
fire only at tool boundaries, and foreground command output is buffered until the
command returns. The status line is the single channel that keeps updating while
a tool call blocks, because `refreshInterval` re-runs it on a timer independent of
conversation events. That is the whole reason this feature is shaped the way it is.

## The Node/Bun split (the constraint that shapes everything)

`bin/enigma.mjs` short-circuits `statusline` and never resolves the Bun binary -
a status bar re-runs every second, and cold-starting a ~260 MB binary on each
refresh is not an option. So the renderer, `bin/statusline.mjs`, runs under the
user's plain Node with **zero dependencies**.

That means it cannot open the gate's SQLite database: `bun:sqlite` needs the Bun
runtime. Hence the snapshot file:

```
daemon (Bun)                          status bar (Node)
RunManager.broadcast ─► writeSnapshot ─► ~/.enigma/gate/statusline.json ─► readSnapshot ─► render
```

- `src/gate/daemon/snapshot.ts` builds the snapshot from the DB and writes it
  atomically (temp file + rename), because the reader polls once a second and must
  never catch a half-written file.
- The hook is in `RunManager.broadcast` (`src/gate/daemon/manager.ts`) - the one
  choke point every run event passes through. `log_chunk` is skipped: it carries no
  state the bar shows and arrives far too often to rewrite on.
- The snapshot is a derived cache. Deleting it costs nothing; the next event
  rewrites it.

`Paths.statuslineFile()` and `snapshotPath()` in the renderer resolve the same
location independently - they cannot import each other across the runtime split, so
changing the path means changing both.

## One entry per repository (the bug that made the line vanish)

Both snapshots are keyed by repository, `{ version, repos: { [repoPath]: entry } }`,
the same shape `gate-ledger.ts` uses for `last-runs.json`.

They were not, and that was a real bug rather than a tidiness point. A single slot is
fine with one project and wrong with two: whichever writer fired last owned the file,
and because the reader DROPS an entry whose repo does not contain its cwd, the loser
did not see someone else's run - it saw nothing. A clobber and "no run in flight" are
the same picture, which is why the symptom reads as "the gate line disappears" and
"it shows up in a session that has nothing to do with it".

The code graph's snapshot is the one that hurts more, and it is easy to miss why: its
writer is a **session hook**, so ordinary prompts rewrite it. With several projects
open, every prompt in one of them blanked the segment in all the others. Its write is
also atomic now (temp file plus rename), which the gate's already was.

Where more than one entry contains the cwd - a worktree, a clone vendored inside
another repo - the **deepest** root wins, matching `lastGateRun`. Both files are capped
at 100 repositories, and the gate's writer DELETES a repository's entry once its run
settles rather than storing a finished run.

Version 2 is the map. `readSnapshot` still accepts a version-1 file (one flat snapshot)
because during an upgrade the renderer is new while the daemon is still the old
long-running process, and a dark bar in that window would look exactly like the bug
this replaced. The code graph's pre-map file carried no `version` at all, so that is
what identifies it.

Not fixed, deliberately: two sessions open on the SAME repository both show that
repository's run. A run IS in flight there, and keying per session would need the
daemon to know which session started the run, which it does not.

## Rejection rules (why the gate line sometimes does not appear)

`readSnapshot` returns null - and the bar silently drops to one line - when no entry is
for this repository (cwd must be the repo root or below it), the file is from an
unrecognized schema version, the run has already settled, or the entry was **written by a
daemon whose PID is no longer alive**. That last one is what stops a crashed daemon
from leaving a phantom run on screen forever, and it is checked with
`process.kill(pid, 0)` rather than a staleness timeout, because a run can legitimately
sit parked at a gate for a long time.

## Rendering rules

- Nothing may throw. A status bar that errors displays the error until the next
  refresh, so every reader is guarded and every field is absent until proven present.
- Width comes from `COLUMNS` (Claude Code sets it; `tput cols` does not work because
  the script's output is captured, not attached to the terminal). `fit()` drops
  `optional` segments from the end until the line fits, so the step and its progress
  always survive and the branch/PR go first.
- Animation is stateless: the frame index is derived from wall-clock seconds by the
  caller, so consecutive refreshes advance the spinner without the module holding
  state. The spinner turns only while a step is actually working; a failed run holds
  a red marker, so a stalled pipeline never looks like a busy one.
- The pipeline bar doubles as the legend - cell N is step N - which is what makes the
  whole run fit on one line.
- A negative elapsed time (snapshot and reader disagreeing about the clock) drops the
  segment rather than printing a confident `0s`.

## The toggle, and why it needs a config flag

`enigma config statusline on|off` (also in the TUI and the dashboard settings panel).
The flag lives in `.enigma.json` and defaults to ON; Claude's `settings.json` carries
the effect. Both are needed: with only the effect, "the user turned it off" is
indistinguishable from "never installed".

That matters because `syncDeployed` re-asserts the bar on every sync - the same
treatment the completion gate gets, and for the same reason. The status bar is
settings.json WIRING, not a file the sync's copy loop touches, so an existing
deployment would otherwise only pick it up on an explicit `enigma install`. Since
`enigma update` calls `syncDeployed`, that re-assert is what makes `enigma update`
actually deliver the feature.

The re-assert is safe to run on every sync because it is gated on the config flag and
because `enableClaudeStatusline` never replaces a statusline the user wrote themselves.

One ordering caveat: `runUpdateCli` syncs BEFORE it self-updates the npm package, so the
running process is still the old code. A default introduced in version N therefore lands
on the *next* sync - the following `enigma update`, or the next `enigma claude` launch
with `autoSync` on, whichever comes first.

## Windows

The statusline used to be excluded on Windows: Claude Code spawned it without
`windowsHide`, so every refresh popped a console window
([#54590](https://github.com/anthropics/claude-code/issues/54590), closed as a
duplicate of #51867, which was itself closed as not planned). The shipped client now
routes the statusline through the same spawn helper as hooks, which does pass
`windowsHide`, so the exclusion was removed in `enableClaudeStatusline`.

If console windows ever come back, `disableClaudeStatusline` removes it, or the user
deletes the `statusLine` key from `~/.claude/settings.json`.

## Refresh interval (a spawn budget, not a taste call)

`refreshInterval` defaults to 10 seconds. Every refresh spawns a process, and on Windows each
spawn creates console hosts. Measured on a Windows 11 box with Windows Terminal as the
default terminal, sampling process creation for 14s with the bar off and then on:

| statusLine | conhost.exe created | node.exe created |
| ---------- | ------------------- | ---------------- |
| off (baseline: Docker/VS Code polling) | 36 | 0 |
| on, `refreshInterval: 1` | 95 | 14 |

That is ~4 console hosts per refresh on top of the machine's baseline, which made the
status bar the single busiest process spawner on the box. It is also the mechanism
behind the console-window flash reported in
[#54590](https://github.com/anthropics/claude-code/issues/54590) (closed as a duplicate
of #51867; neither was ever fixed).

Pointing the command at `node <launcher>` instead of the npm `.cmd` shim roughly halves
the churn (61 vs 95 conhost for the same 13 refreshes), but it hardcodes an absolute
install path into `settings.json`, which breaks on reinstall. Not worth it once the
interval is sane.

Ten seconds is also where the established projects landed - ccstatusline defaults fresh
installs to 10 (range 1-60), claude-powerline documents 10 as "within ~10s of reality".
Pipeline steps run for minutes, so the information the gate line carries is not
meaningfully staler at 10s; only the spinner stops reading as a smooth animation.

The value is written by `enableClaudeStatusline` and can be edited directly in
`settings.json` for anyone who wants a faster spinner and does not care about the spawns.

### The dial (`statuslineRefresh`)

Ten is a budget for a healthy box, not a floor that holds everywhere. The harness owns the
status bar's lifecycle - it re-runs the command as a **fresh process** on every tick, so the
cost per refresh is a whole process start, and nothing enigma does inside the renderer can
change that. Measured on the author's Windows box under load (real-time AV scanning the
runtime, six agent sessions open): `node -e "0"` alone took 650-1800 ms with 4 s outliers,
and the renderer added ~200 ms on top of it. At that point the bar is the thing the user
feels as input lag while typing, and the fix is fewer ticks, not a faster script.

`enigma config statusline-refresh <0-60>` writes `statuslineRefresh` (config.ts, default 10).
**0 omits `refreshInterval` from the block entirely** - the key is what creates the timer, so
its absence is the difference between "every N seconds" and "only when the conversation
moves". At 0 the bar is correct at rest and frozen while a gate run blocks, which is exactly
the trade this feature exists to make: the only thing the timer buys is a moving gate line.

The value is read at the SCOPE being written, not from the merged config: `readConfig()`
layers the repo-local `.enigma.json` over the global one, so using it for a global write
would take one project's value and stamp it on the bar every other project sees, while
the CLI printed "(global)". A local write is the merged, nearest-wins value by definition.

The ceiling is 60 because Claude Code documents 1-60 and silently ignores anything above it;
a value out of range (or a non-number - `.enigma.json` is hand-edited and a repo-local one
travels with a clone) collapses to the default rather than reaching `settings.json`.

Two writers, deliberately:

- `enableClaudeStatusline` is **install-only** and refuses to touch an existing block. That
  is what stops `syncDeployed` - which runs on every launch - from clobbering a bar the user
  hand-tuned in `settings.json`.
- `syncClaudeStatuslineRefresh` reconciles the interval on an enigma-managed bar (never a
  custom one) and is called only from the setter. It returns three outcomes rather than a
  boolean (`not-installed` / `unchanged` / `updated`), because "no enigma bar here" and
  "the bar already had this value" are both no-writes and collapsing them made the CLI
  tell someone who had just re-set the value that no status bar was installed. Without it a changed setting would never
  reach an existing install; with it on the sync path, hand edits would not survive. An
  explicit `enigma config statusline-refresh N` is the one moment where overwriting the
  value is what was asked for.

## Reading the piped session (the orphan-process bug)

The harness pipes the session JSON to the renderer's stdin. Reading it with
`readFileSync(0, "utf8")` looks right and is not: that call blocks until **EOF**, so a
harness that writes the session and then leaves its end of the pipe open hangs the
renderer forever. Nothing recovers it - the process is stuck inside a synchronous read,
so no timer, no `unref`, and no signal handler written in JS can fire.

Measured on the author's Windows box: nine orphaned `enigma.mjs statusline` processes
alive across a single day, each the child of a Claude session that had already exited,
together holding 344 MB and 171 handles. They accumulate at roughly one per session and
survive until reboot, which is why the symptom is "the machine gets laggy after a few long
sessions" and why `/clear` does nothing for it - the orphans outlive the conversation.

`readSession` is therefore a streaming read with four exits, in the order they fire in
practice:

1. **the buffer parses as JSON** - the harness has finished writing, whether or not it
   closes the pipe. This is the one that matters: it keeps the full bar in the case that
   used to hang, instead of degrading it.
2. **EOF** - the ordinary path.
3. **the timeout** (`STDIN_TIMEOUT_MS`, 2 s) - nothing parseable ever arrived, so the bar
   renders without the session rather than waiting on a writer that is not coming.
4. **the cap** (`MAX_SESSION_BYTES`, 1 MB) - whatever is being streamed is not a session,
   so it is abandoned immediately instead of buffered and reparsed for the whole timeout.

Parsing on every chunk is safe because a partial write of a JSON object is never itself
valid JSON, so step 1 cannot settle early on a half-written payload. The parse is attempted
only once the buffer ends in `}`, which skips the work entirely while a write is still in
flight.

Whichever exit fires detaches the listeners and pauses the stream. Resolving alone is not
enough: the promise settles once but `data` keeps arriving, so the buffer would go on
growing past the cap that was supposed to abandon it, and on a stream the renderer does not
own (a test's `PassThrough`, anything not `process.stdin`) the listeners would outlive the
read - `drain()` destroying stdin is what hid that, and it only covers the real one.

The exit needs the same care. `drain()` destroys stdin - an open stdin keeps the event loop,
and therefore the process, alive for as long as the harness holds the pipe - and bounds the
write with `DRAIN_TIMEOUT_MS` for the mirror case, a stdout whose reader is already gone and
whose drain callback never fires. That case also needs `silenceWriteErrors`: the dead reader
answers with EPIPE an event-loop turn *after* the failed write reports back, and an unhandled
`error` event is an uncaught exception - a stack trace on stderr and exit 1, from the one
module that must never make noise. The listener is a permanent no-op for that reason; a
handler removed when the drain resolves is removed a turn too early. `printStatusline` is
async and the launcher **awaits** it: exiting before the write drains truncates the bar,
since stdout to a pipe is asynchronous on Windows.

`readSession` takes its stream and timeout as parameters purely so this is testable without
spawning a process; nothing but the tests passes them.

## Tests

`tests/gate/statusline.test.ts` covers the round trip that no single runtime can
verify alone: `writeSnapshot` against a real gate DB, then `readSnapshot` and
`render` from the `.mjs` side, plus the rejection rules, the animation, and the
width invariant. Two cases pin the per-repository map: concurrent runs in different
repositories each keeping their own bar (and one settling dropping only its own entry),
and a repository nested inside another reading its own snapshot. The code graph's half
is pinned in `tests/codegraph-hooks.test.ts`. The last two cases cover the exits above: `readSession` over a
`PassThrough` for the unclosed pipe, the split payload and the cap, and a spawned
renderer whose stdout is destroyed before it writes, which must still exit 0 with an
empty stderr.
