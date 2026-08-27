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
agent pushes ──► hook notices the tracking branch moved
                     └─► spawns a DETACHED poller ──► gh run list / run view
                                                          └─► state.json (per repo)

next tool call ──► hook reads state.json
                     ├─ nothing to report ──► prints NOTHING (zero tokens)
                     └─ undelivered failure ──► prints it once, marks delivered
```

- **The poller** (`enigma __ci-watch <repo> <sha>`) is an ordinary background process.
  Its waiting costs wall clock and nothing else. It polls every 30 s for at most 30
  minutes, then gives up rather than living forever behind a queued runner or an
  environment approval.
- **The hook** (`enigma __ci-hook`) fires at tool boundaries the harness was going to
  spawn anyway. On a green build it writes zero bytes, so the feature's cost in the
  common case is exactly zero tokens.

Non-blocking by construction: the hook never denies a call and always exits 0. A
notifier that could fail a turn would be a worse problem than the one it solves.

## Delivery rules

- **Once.** The entry is marked `delivered` before the report is emitted. A broken
  build re-announcing itself at every tool boundary would cost more context than the
  failure it reports.
- **Per repository.** `~/.enigma/ci-watch/state.json` holds `{ version, repos }`, the
  same shape as `gate-ledger.ts` and the status-line snapshot, and for the same reason:
  one global slot lets one project's verdict overwrite another's. Deepest matching root
  wins, so a clone nested inside another repo reads its own.
- **Delivery never shells out.** It matches `cwd` against the recorded paths instead of
  resolving the git root, because it runs at every tool boundary and must not cost a
  subprocess to answer "nothing to say". Only ARMING runs git, and only after delivery
  found nothing.

## What arms a watch

The tracking branch moving to a commit this repository produced. The ancestor test
(`git merge-base --is-ancestor @{u} HEAD`) is what keeps a plain `git fetch` from
arming one: pulling a teammate's commit moves the upstream ref exactly like a push
does, and reporting on someone else's build is noise the agent cannot act on.

The SHA is claimed in the state file BEFORE the poller is spawned, so two tool calls
landing together cannot arm two pollers for the same commit and report it twice.

## The log excerpt

`gh run view --log-failed`, last 60 lines, capped at 4000 characters, with `gh`'s
`<job>\t<step>\t` prefix stripped. This text is spent from the agent's context window
and a workflow log is measured in megabytes; the error is at the end, not the start.

## Wiring

Two Claude Code hooks (`ci-watch-deploy.ts`), both calling the same command:

- `PostToolUse` matched on `Bash`, which is where a push comes from. This is the one
  that arms, and the one that delivers soonest - mid-task is when a break is cheapest
  to fix.
- `UserPromptSubmit` as the backstop, so a verdict landing after the agent stopped
  running commands is the first thing on the next turn instead of sitting unread.
  **Delivery only** - it never arms. Arming costs three git subprocesses to answer
  "did you push?", and this chain runs before the turn starts with several hooks
  sharing its budget; it was observed timing out (`UserPromptSubmit hook timed out
  after 30s`) on a loaded box before this feature existed. A push comes from Bash, so
  `PostToolUse` is where those subprocesses belong. `runCiWatchHook` enforces it: any
  event other than `PostToolUse` returns after the state read.

Claude Code only, deliberately: the delivery channel is a hook whose stdout is fed back
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
