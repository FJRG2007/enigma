# The merged post-edit hook (`enigma __post-edit-hook`)

The one Claude Code `PostToolUse` entry that runs every post-edit step: the EOF trimmer,
guardrails, and the code graph's blast radius. Read this before adding a fourth thing that
wants to run after an edit, or before changing what any of the three does there.

## Why one entry and not three

- THE HOST STARTS A PROCESS PER SETTINGS.JSON ENTRY. Three features wrote after an edit and
  each wired its own entry, so an edit cost three starts of the ~99 MB Bun binary for work
  whose own runtime is milliseconds. Measured on Windows 11 with Defender real-time on:
  `enigma-bin.exe --version` at **98-102 ms warm, 816-3341 ms cold**, `node -e "0"` at
  **55-73 ms warm, 562-1584 ms cold**. Cold is not the outlier in a long session - hours of
  memory churn (an editor with 35 helper processes, browsers, several agent sessions) evict
  the image from the standby cache, which is exactly why the complaint is always "it gets
  slow after a while on the PC" and never "it is slow from boot".
- THE ARITHMETIC IS THE ARGUMENT. A turn with five edits paid 15 process starts on
  PostToolUse alone; it now pays 5. Nothing about the work changed - only how many times the
  runtime is paid for.
- The other three code-graph events (`SessionStart`, `UserPromptSubmit`, `Stop`) keep their
  own entries. Nothing else fires on them, so there is nothing to merge with; the win here
  was never "fewer hooks", it was "fewer processes for the same hook event".

## The ordering it settled

As three entries the host was free to run them concurrently, so guardrails could scan a file
either side of the trimmer's rewrite and **nothing declared a winner**. In one process the
order is stated and testable: the step that WRITES runs first (trim), then the steps that
READ (guardrails, then the graph). `tests/post-edit-hook.test.ts` asserts it by blocking on a
`.sql` file that also has a trailing blank line - the block fires AND the file comes back
trimmed, which only holds if the write landed before the scan.

## Exit codes

`2` when guardrails BLOCKs, `0` otherwise. Exit 2 is the channel Claude Code feeds back to the
model, and it is the reason the merge cannot simply run everything and return 0 - losing it
turns a gate into a silent no-op, the worst way for this to break. A BLOCK short-circuits the
blast radius on purpose: the model is about to redo the write, so the graph note would
describe an edit that is being taken back.

## Toggle gating moved from the wiring to the runtime

One entry cannot encode three toggles, so `post-edit-hook.ts` gates each step on its own
config value instead of relying on its entry being absent. Two consequences worth knowing:

- The entry exists when ANY of `trim` / `guardrails` / `codeGraph` is on. Turning ONE off must
  not delete an entry the other two still use - which three independent writers could not
  honour, and is why `post-edit-deploy.ts` is the single owner of that group.
- It reads `readConfig()`, which layers the repo-local `.enigma.json` over the global one, so
  a project that turns trim off now turns it off for the hook too. The three globally-wired
  entries never did that.

## Wiring

- `src/post-edit-hook.ts` - runtime. Dynamic imports so a normal command never loads the
  engines; every step fails soft except the BLOCK.
- `src/post-edit-deploy.ts` - the ONLY writer of the Claude `PostToolUse` group.
  `applyClaudePostEditHook(settingsPath)` reconciles it from the toggles and removes the three
  legacy markers (`__guardrails-hook`, `__trim-hook`, `__codegraph-hook post-edit`) on every
  call, so an install that predates the merge migrates itself with no upgrade step to
  remember. A leftover legacy entry is the regression to watch for: it keeps paying the
  process start this exists to stop, and it is invisible.
- The code graph's marker carries its event argument (`__codegraph-hook post-edit`) because
  all four of its entries share a command name; matching the bare name would delete its
  `SessionStart`, `UserPromptSubmit` and `Stop` entries too.
- `cli.ts` dispatches `__post-edit-hook` EARLY with a synchronous `readFileSync(0)` before any
  await - the guardrails-hook lesson: an await lets Node drain the pipe and the hook silently
  sees an empty payload.
- The three per-feature hidden commands still exist and still work. opencode's generated
  plugins invoke them directly, and a `settings.json` that predates the merge still names them
  until its next reconcile.

## What was deliberately NOT merged

- opencode's two plugins (`enigma-guardrails.js`, `enigma-trim.js`) each `spawnSync` enigma per
  edit, which is the same defect on a different host. Untouched here because the measured
  problem and the fix were both on Claude Code; if opencode ever matters on a slow host, this
  is the same change one layer over.
- Kimi wires only the trimmer, so it has one entry and nothing to merge.

## Timeout

45 s, and it is a budget for a cold start plus a graph load (~4.5 s + ~7.5 s measured on this
monorepo), not the sum of the three it replaced. Sizing it to the happy path does not degrade
gracefully, for the reason `codegraph-deploy.ts` documents: the host kills the hook, discards
its output, and prints a timeout warning into the session - so the process cost is paid and
buys nothing but noise.

## Tests

- `tests/post-edit-deploy.test.ts` - presence follows the three toggles TOGETHER, idempotence,
  legacy migration, the other code-graph events surviving, a user's own hook surviving both
  directions, an unparseable settings file refused.
- `tests/post-edit-hook.test.ts` - drives the real CLI over stdin: per-toggle gating, the
  trim-before-scan order, exit 2 on a BLOCK. It passes `ENIGMA_CONFIG_HOME` **explicitly** to
  the child; assigning `process.env` in the parent does not steer it, and the failure is silent
  and misleading - the hook reads the real `~/.enigma.json` and the assertions pass or fail on
  whatever the machine running the suite happens to have configured.
