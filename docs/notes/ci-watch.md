# CI failure notifier (`ciWatch`)

Tells the agent that the GitHub Actions run its push triggered has failed, with the
failing log attached, without the agent asking and without a human relaying it.

## The problem, and why the obvious fix is wrong

The agent pushes and carries on. The build breaks. Nothing tells the agent, so the
loop closes only when a person notices and pastes the red checks into the chat - which
is a person's time spent as a message bus.

The obvious fix is to have the agent poll. That is worse than it looks: every check
spends model tokens on the answer "still green", which is the answer almost every
time. Paying continuously to be told nothing is the wrong shape.

## The shape that works: nobody pays for silence

Two halves, and the model's loop is in neither of them.

```
Bash call ──► hook (asyncRewake: runs in the BACKGROUND, the call never waits on it)
                ├─ undelivered failure on file ──► exit 2 + report on stderr (wakes the model)
                ├─ this call pushed ──► claim SHA, spawn DETACHED poller ──► gh ──► state.json
                └─ a pending commit for this repo ──► wait on state.json (file reads only)
                                                        ├─ failure ──► exit 2, marked delivered
                                                        └─ green / stood down ──► exit 0, no output
gate push to the default branch ──► claim SHA, spawn the same poller
```

- **The poller** (`enigma __ci-watch <repo> <sha>`) is an ordinary background process.
  Its waiting costs wall clock and nothing else. It polls every 30 s for at most 30
  minutes, then gives up rather than living forever behind a queued runner or an
  environment approval. Every exit - green, red, no runs, gh unusable, budget spent -
  writes `done: true`, which is how a waiting hook tells "still polling" from "stopped".
- **The hook** (`enigma __ci-hook rewake`) is a `PostToolUse` Bash hook with Claude Code's
  `asyncRewake: true`: it runs in the background, and exit code 2 wakes the model with its
  stderr - mid-turn OR after the turn ended. On a green build it writes zero bytes and
  exits 0, so the common case costs zero tokens. `asyncRewake` is in Claude Code's settings
  schema ("If true, hook runs in background and wakes the model on exit code 2"); its
  `rewakeMessage`/`rewakeSummary` siblings are marked internal and are not used.

## Why it never reached the agent (fixed 2026-09)

`~/.enigma/ci-watch/state.json` did not exist on the author's machine after weeks of pushes:
not one watch had ever armed. Causes, in order of weight:

1. **The hook timed out before doing anything.** `__ci-hook` had no launcher fast path, so
   every Bash call paid a Node start plus the ~99 MB Bun binary start: 16-22 s measured for a
   no-op against a 20 s budget, and arming adds four git subprocesses on top. Claude Code
   logged `UserPromptSubmit hook [enigma __ci-hook UserPromptSubmit] timed out after 20s`.
   Fix: `bin/enigma.mjs` answers `__ci-hook` and `__ci-watch` from `dist/ci-watch.js`
   (tsup entry), and the hook is async so its cost never lands on a tool call.
2. **A verdict reached the model only at its next Bash call or prompt.** An agent that pushes
   and ends its turn - the normal case - heard nothing until the user wrote again, and then
   only if the prompt hook survived its timeout. Fix: `asyncRewake` waiting hook.
3. **Gate pushes never armed.** The gate pushes from its own worktree, so the checkout's
   tracking ref records `fetch: fast-forward` later, never `update by push`. Fix: the push
   step calls `armGatePushWatch` - only for the default branch with no fork, because a PR
   branch has the gate's own CI step (which also auto-fixes) and two fixers on one build is
   worse than one. Keyed by the checkout's `workingPath`, which is where the session runs.

Still not covered: a build triggered by something other than your push (`gh pr merge`, a
merge button) - it is not "your push", and the reflog guard exists to keep it out.

## Delivery rules

- **Once.** The entry is marked `delivered` before the report is emitted. A broken
  build re-announcing itself at every tool boundary would cost more context than the
  failure it reports.
- **Per repository.** `~/.enigma/ci-watch/state.json` holds `{ version, repos }`, the
  same shape as `gate-ledger.ts` and the status-line snapshot, and for the same reason:
  one global slot lets one project's verdict overwrite another's. Deepest matching root
  wins, so a clone nested inside another repo reads its own. Keys are normalized
  (`repoKey`: forward slashes, upper-case drive letter) so the hook's `git rev-parse` root
  and the gate's `workingPath` land in the same slot.
- **Delivery and waiting never shell out.** They match `cwd` against the recorded paths
  instead of resolving the git root, which is also what lets a gate-armed entry (keyed by
  the checkout, not by anything git in the session reported) be found. Only ARMING runs
  git, and only after delivery found nothing; it is in the background now, so it costs no
  tool-call latency.

## What arms a watch

A push from this repository, made moments ago. Three tests, and every one of them is
there because something that is not a push moves the same ref:

- `git merge-base --is-ancestor @{u} HEAD` - the tracking ref points at a commit we
  have.
- The tracking ref's reflog subject is `update by push`. A fetch or a pull writes
  `<command>: fast-forward` instead. Without this, `git pull` arms a watch and the
  agent is handed a teammate's build - it leaves the upstream an ancestor of HEAD
  exactly like a push does, so the ancestor test alone does not separate them.
- That reflog entry is less than 10 minutes old. A tracking ref keeps its last push
  forever, so `git checkout` of a branch pushed last week would otherwise look
  identical to a push made now, and the report would be about a build someone already
  dealt with.

One `git rev-parse @{u} --symbolic-full-name @{u}` answers both "which commit" and
"which ref", so the reflog test costs one subprocess rather than two.

The SHA is claimed in the state file BEFORE the poller is spawned, so two tool calls
landing together cannot arm two pollers for the same commit and report it twice. The
claim is also what the verdict is checked against: a poller lives up to half an hour,
so a second push routinely overtakes the first, and `recordVerdict` is a no-op once
the slot has moved on - writing the stale verdict back would un-claim the newer SHA,
arm a duplicate poller for it, and (the entry having lost `delivered` on the way)
report the same failure twice.

The poller stands down early when a push triggers no run at all: GitHub registers a
run within seconds, so an answer that is still empty after 3 minutes means there is
nothing to watch. Without that, a repository with a GitHub remote and no workflows
spends the full 30-minute budget - sixty API calls - on every push.

## The log excerpt

`gh run view --log-failed`, last 60 lines, capped at 4000 characters, with `gh`'s
`<job>\t<step>\t` prefix stripped. This text is spent from the agent's context window
and a workflow log is measured in megabytes; the error is at the end, not the start.

When there is no excerpt - expired logs, a `gh` that failed - the report drops the log
section entirely and leans on the run URL. A heading with nothing under it reads as
"fix this, reason withheld".

## Spawning the poller

`startPoller` uses the same runtime dispatch as the lint-install and update-check
children: the compiled binary takes `__ci-watch` directly, node/bun on the source entry
need `process.argv[1]` in front of it. Passing the entry path to the binary is silently
fatal - the SHA is claimed either way, so the watch looks armed while the child exits
without polling and no verdict ever arrives (`monorepo-and-distribution.md`).

## Wiring

One Claude Code hook (`ci-watch-deploy.ts`): `PostToolUse`, matcher `Bash`, command
`enigma __ci-hook rewake`, `asyncRewake: true`, timeout 2400 s (the host kills a hook at its
timeout, so it must outlast the poll budget plus the log fetch; the wait budget is 35 min).

- **One waiter per commit.** The waiting hook writes `waiter: { pid, at }` into the entry; a
  later Bash call sees a live claim and exits at once. A claim whose pid is dead (the session
  closed) or older than the budget is taken over, so the next session still hears the verdict.
  A newer push replaces the entry, which drops the old waiter and makes the arming hook the
  new one. The poller carries the waiter over when it records the verdict.
- **The `UserPromptSubmit` entry is removed** on every re-assert, whatever the toggle. It was
  the one that timed out, it cost a process per prompt, and the waiting hook delivers what it
  backstopped.
- **Old wirings still behave.** `__ci-hook PostToolUse` (synchronous) delivers as JSON
  additionalContext and arms but never waits - a synchronous hook that waited would hold the
  tool call to its timeout. `__ci-hook UserPromptSubmit` delivers only. Both disappear at the
  next `enigma install`/sync, which rewrites the entry.

Claude Code only, deliberately: the delivery channel is a hook whose output is fed back
to the model. opencode and Kimi get nothing rather than a hook firing into a void - the
same call `trim-deploy.ts` documents for Codex and `guardrails-deploy.ts` for Kimi.

## Degrading

`gh` absent, unauthenticated, or the remote not being GitHub all end the poller
silently. A convenience feature must never announce its own plumbing.

## Related

`claudeGlobalSettings()` moved to `claude-hooks.ts` while adding this - it had been
copy-pasted into five modules. Note that `lint.ts` and `verify-deploy.ts` were NOT
folded in: theirs resolve `homedir()` rather than `enigmaHome()`, which is a real
behavioral difference (see the comment on the shared helper) and not a duplicate.

Tests: `tests/ci-watch.test.ts`.
