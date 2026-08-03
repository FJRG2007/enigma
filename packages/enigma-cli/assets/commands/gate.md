---
description: Validate code changes through the enigma gate pipeline - automated review, tests, lint, docs, push, PR, and CI - before they reach the configured push target. Use when the user asks to run the gate, gate/ship/validate their changes, push safely, do a task and then validate it, or invokes /gate. Also the way to turn the gate on or off (/gate on, /gate off, /gate status) when the user asks to enable, disable, or stop it running automatically.
argument-hint: [task] | (bare to gate already-committed work) | on | off | status | "skip the lint step"-style requests
---

# /gate

The enigma gate is a local gate that validates code changes through a pipeline
(intent, rebase, review, test, document, lint, push, PR, CI) before they reach
the configured push target. You drive it through the `enigma gate axi` command
family, which prints machine-readable [TOON](https://toonformat.dev) to stdout
and progress to stderr.

The invocation is: **$ARGUMENTS**

When the user invokes `/gate`, report the outcome at the end. If the user asks
for something specific, translate it into the matching `axi run` flags yourself -
for example "skip the lint step" becomes `--skip=lint`. Run
`enigma gate axi run --help` to see the flags.

## Turning the gate on and off

`/gate on`, `/gate off` and `/gate status` are settings, not runs - handle them
first and stop there, without touching the pipeline.

| Invocation | Command to run |
| --- | --- |
| `/gate status` | `enigma config gate` (prints the value in force here) |
| `/gate off` | `enigma config gate off -l` |
| `/gate on` | `enigma config gate on -l` |
| `/gate off --global` (or "everywhere", "in every project") | `enigma config gate off -g` |
| `/gate on --global` | `enigma config gate on -g` |

Scope matters, so be explicit about it. Plain `/gate off` switches the gate off
for **this project only** by writing `gate: false` into its `.enigma.json` -
narrow and reversible, and it leaves every other repo alone. Only go global when
the user actually says so. Report which of the two you applied.

Toggling rewrites the agent memory file, which is read at startup: tell the user
the change takes effect in their **next** session. In this one, keep honouring
what they just asked for - if they turned the gate off, do not drive it again.

One asymmetry worth stating when it applies: a **global** off also removes this
command from the agent, so tell the user that turning it back on is
`enigma config gate on -g` from a terminal. A project-scoped off leaves `/gate`
in place, so `/gate on` works there.

## Two ways to invoke

- **Validate-only** - bare `/gate` (optionally with flag-style requests like
  "skip the lint step"). The user's changes are already committed; validate them
  and report.
- **Task-first** - `/gate <task>`, e.g. `/gate add a --json flag to status`. First
  carry out the task yourself, then validate:
  1. **Check scope.** Inspect `git status` before changing or committing anything.
     Preserve unrelated uncommitted changes; commit only what belongs to the task.
  2. **Do the work**, then **commit it**. The gate validates committed history on
     whatever branch the user is on - never switch or create a branch just to run
     it.
  3. **Then validate**, passing the user's task as your `--intent` (the goal in
     their words), enriched with the decisions and tradeoffs you made.

## Before you start

- The work must be **committed**. Any branch qualifies, the default branch
  included - there the pipeline opens no PR and its push lands directly on that
  branch, which is the intended behavior. The only exception is a branch the user
  listed in `gate-protected-branches`: `axi run` refuses it, and the answer is to
  tell the user, not to move their work to another branch.
- The repository must be initialized with `enigma gate init`.

If any precondition fails, `axi run` returns an `error:` with the exact fix -
read it and act on it. If the repo is not initialized, run `enigma gate init`
first - that is a setup step you perform, not a reason to hand the run back with
a question; if `enigma gate` itself misbehaves, `enigma gate doctor` reports what
is wrong. Before starting, run `enigma gate axi` (home view): if it shows an active
run on your branch, resume it or `axi abort` before starting over; on another
branch, leave it alone and start your own with
`enigma gate axi run --intent "..."`.

## Intent is required

When you start a run you must pass `--intent`: **what the user set out to
accomplish** - the goal behind the work, in their terms, not a description of the
diff. Err on the side of completeness: capture the goal, the decisions and
tradeoffs, constraints ruled in or out, and anything explicitly asked for that
might look surprising in the diff. A few sentences is normal - the review step
uses `--intent` to tell a deliberate choice from a mistake.

## Validate and decide

1. Start the run. It blocks until the first decision point or the end:
   ```sh
   enigma gate axi run --intent "<what the user set out to accomplish>"
   ```
   `axi run` and every `axi respond` block synchronously - review, test, and CI
   can each take several minutes, so a single call may not return for a while.
   That is normal; allow a long timeout and do not cancel or re-issue it. To
   check progress, use `enigma gate axi status` from a separate call. When status
   shows `awaiting_agent: parked <duration>`, the run is parked at a gate waiting
   for your `axi respond`.
2. If the output contains a `gate:` object, the pipeline is waiting on you. Read
   its `findings` table. Each finding has an `action`:
   - `auto-fix` - mechanical, low-risk; authorize on your own judgment with
     `--action fix`.
   - `no-op` - informational; nothing to do.
   - `ask-user` - a judgment call only the user can make. STOP and escalate it
     (see below) before responding.

   The gate object also carries `fix_policy`, the user's standing answer to "who
   decides?". Follow it - the `help` line spells out what it means for the gate in
   front of you, and it is the user's setting, not a suggestion:
   - `assisted` (default) - anything mechanical was already settled before this
     gate reached you, so what is left is the judgment call. Escalate it.
   - `ask` - the user wants every finding put to them, `auto-fix` ones included.
     Relay them and let the user choose instead of authorizing anything yourself.
   - `auto` - the user asked you to settle everything. Respond without checking back.

   Choose one response:
   ```sh
   enigma gate axi respond --action approve
   enigma gate axi respond --action fix --findings <id1,id2> --instructions "<optional>"
   enigma gate axi respond --action skip
   ```
   For long guidance, write it to a file and pass `--instructions @path/to/notes.md`.
   That avoids the shell quoting differences between PowerShell and sh, which mangle
   quotes and newlines in a long inline string.
   While a run is active, never fix findings by editing code yourself - the
   pipeline owns the findings and the fixes. Decide and respond; `--action fix`
   has the pipeline apply the fix and re-review.
3. Repeat step 2 until the output has an `outcome:` instead of a `gate:`:
   - `checks-passed` - validated and CI green, PR not merged yet. You are done
     driving. Tell the user the PR is ready and ask them to review and merge it
     (link in the `help` line). The gate keeps monitoring the PR in the
     background; do not poll for the merge.
   - `passed` - cleared the gate and the PR was merged or closed. On the default
     branch this is the normal ending: no PR is opened and CI monitoring is
     skipped, so the run finishes here once the push lands.
   - `failed` / `cancelled` - read the output, fix what it points at, commit on
     the same branch, and drive again (`axi run` for a fresh run, or
     `enigma gate rerun`). Do not leave the user at a failed outcome without
     either retrying or explaining what blocks it.

On a successful outcome, summarize what the pipeline validated and found. If the
output includes a `fixes` table, the pipeline fixed things your change missed -
acknowledge those and list each fix.

## Escalate ask-user findings

A finding marked `ask-user` is the user's decision, not yours. Relay it verbatim
(its `id`, `file`, full `description`) - do not paraphrase or pre-judge - ask how
to proceed, then translate their answer into the matching `respond` call. The
exceptions are `fix_policy: auto` and `--yes` (below), both of which are standing
consent to drive every gate unattended.

If you have clear consent to drive the whole run automatically, pass `--yes` to
`axi run` or `axi respond`: it treats every actionable finding (auto-fix and
ask-user alike) as consent to fix, accepts the resulting fix review, and approves
no-op-only gates. Only use it when the user asked you to drive without checking
back - it overrides `fix_policy` for that run.

The user sets `fix_policy` themselves, in the dashboard's Quality gate view or as
`fix_policy` in `~/.enigma/gate/config.yaml`. If they ask you to stop checking back
(or to start), point them there rather than passing `--yes` from then on.

## Inspecting state

```sh
enigma gate axi               # home view
enigma gate axi status        # full detail of the resolved run
enigma gate axi logs --step <name> --full
enigma gate axi abort         # cancel the current-branch active run
enigma gate axi abort --run <id>   # cancel a specific run by id
```

## Reading the output

- TOON: `key: value` pairs, `name[N]{cols}:` tables, `help[N]:` hints. The `help`
  list tells you the next commands. Errors print as `error: ...` with a `help`
  list - act on the suggestion.
- Exit codes: `0` success/no-op/decision-gate, `1` failed/cancelled, `2` bad usage.
- Field names and columns can vary by step and version, so read the actual
  `findings` header rather than assuming a fixed layout.
