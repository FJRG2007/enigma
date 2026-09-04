# The merged post-edit hook (`enigma __post-edit-hook`)

The one Claude Code `PostToolUse` entry that runs every post-edit step: auto-lint, the EOF
trimmer, guardrails, and the code graph's blast radius. Read this before adding a fifth
thing that wants to run after an edit, or before changing what any of the four does there.

## Why one entry and not four

- THE HOST STARTS A PROCESS PER SETTINGS.JSON ENTRY. Four features wrote after an edit and
  each wired its own entry, so an edit cost four process starts for work whose own runtime is
  milliseconds. Measured on Windows 11 with Defender real-time on: `enigma-bin.exe --version`
  at **109-1658 ms**, `node -e "0"` at **112-874 ms**. Cold is not the outlier in a long
  session - hours of memory churn (an editor with 35 helper processes, browsers, several
  agent sessions) evict the image from the standby cache, which is exactly why the complaint
  is always "it gets slow after a while on the PC" and never "it is slow from boot".
- THE ARITHMETIC IS THE ARGUMENT. A turn with five edits paid 20 process starts on
  PostToolUse alone; it now pays 5. Nothing about the work changed - only how many times the
  runtime is paid for.
- The other three code-graph events (`SessionStart`, `UserPromptSubmit`, `Stop`) keep their
  own entries. Nothing else fires on them, so there is nothing to merge with; the win here
  was never "fewer hooks", it was "fewer processes for the same hook event".

## And why the LAUNCHER answers it, not the binary

`enigma` is an npm launcher (`bin/enigma.mjs`) that resolves the Bun-compiled binary and
spawns it, so every hook cost a Node start AND a Bun start. Measured here, same machine, same
minute: `enigma --version` **290-6109 ms**, the binary alone **109-1658 ms**, `node -e "0"`
**112-874 ms**. The launcher was already paid for; the second start was the avoidable half.

Every step this hook runs is Node-compatible, so `src/post-edit-hook.ts` is bundled to
`dist/post-edit.js` by tsup and the launcher imports it and answers the hook itself. The
binary is never started for an edit. What the model gets back - the trimmed file, the lint
findings, a guardrails BLOCK on exit 2, the blast radius - is identical.

Measured A/B on the same machine, seven runs each, one real edit per run (a file with a
trailing blank line and a lint finding, so every step does work): **median 2294 ms** for the
one-process path against **5794 ms** for the launcher-plus-binary path followed by the separate
lint process - 1571-7024 ms against 2663-9352 ms. The spread is the machine, not the change,
which is the point of taking medians: the floor moves by seconds between two runs of the same
command.

- The fast path sits beside the `statusline` one, before `resolveBinary()`, and reads stdin
  with a synchronous `readFileSync(0)` BEFORE any await: an await lets Node drain the pipe and
  the hook silently sees an empty payload (the guardrails-hook lesson, which cli.ts records
  for the same command).
- A bundle that is missing (an install from before it shipped) falls through untouched, stdin
  included, and the binary answers as it always did. A bundle that fails to LOAD says so on
  stderr rather than exiting 0 quietly: a post-edit hook that stops running looks exactly like
  a clean edit, and that is the failure nobody notices.
- `tests/post-edit-hook.test.ts` pins it by pointing `ENIGMA_BIN_PATH` at `node` itself. If
  the fast path stopped firing, the launcher would spawn it, `node __post-edit-hook` would
  fail, and the case fails - rather than quietly going back to costing double.

## Auto-lint is the step that only Node can run

The linter is installed on demand into `~/.enigma/linter`, outside this package, so loading it
means resolving a path the build never saw. A Bun-compiled binary cannot: both
`import(pathToFileURL(...))` and `createRequire(...)` fail there with `Cannot find package
'typescript' from ...@enigmax/linter/dist/index.js` - a standalone executable does not walk
node_modules for a module it loads at runtime. Verified both ways before the step was written.

That is not a limitation in practice, because the launcher is the runtime: under Node the
require resolves (~130 ms to load, ~27 ms to lint a file). Reached through the binary the step
no-ops and nothing else changes. It is also why the lint step lives here rather than in the
generated runner - opencode and Kimi still invoke `~/.enigma/hooks/lint-hook.mjs` directly,
since neither has a merged hook to fold into.

## The ordering it settled

As separate entries the host was free to run them concurrently, so guardrails could scan a
file either side of the trimmer's rewrite and **nothing declared a winner**. In one process
the order is stated and testable: the steps that WRITE run first (lint, then trim - the
formatter can leave or take a trailing newline and the trimmer settles the end of the file),
then the steps that READ (guardrails, then the graph). `tests/post-edit-hook.test.ts` asserts
it by blocking on a `.sql` file that also has a trailing blank line - the block fires AND the
file comes back trimmed, which only holds if the write landed before the scan.

## Exit codes

`2` when guardrails BLOCKs or the linter has a finding it could not fix, `0` otherwise. Exit 2
is the channel Claude Code feeds back to the model, and it is the reason the merge cannot
simply run everything and return 0 - losing it turns a gate into a silent no-op, the worst way
for this to break. A block short-circuits the blast radius on purpose: the model is about to
redo the write, so the graph note would describe an edit that is being taken back.

## Toggle gating moved from the wiring to the runtime

One entry cannot encode four toggles, so `post-edit-hook.ts` gates each step on its own
config value instead of relying on its entry being absent. Two consequences worth knowing:

- The entry exists when ANY of `autoLint` / `trim` / `guardrails` / `codeGraph` is on. Turning
  ONE off must not delete an entry the other three still use - which four independent writers
  could not honour, and is why `post-edit-deploy.ts` is the single owner of that group.
- It reads `readConfig()`, which layers the repo-local `.enigma.json` over the global one, so
  a project that turns trim off now turns it off for the hook too. The four globally-wired
  entries never did that.

## Wiring

- `src/post-edit-hook.ts` - runtime, and the source of `dist/post-edit.js`. Dynamic imports so
  a normal command never loads the engines; every step fails soft except the BLOCK.
- `src/post-edit-deploy.ts` - the ONLY writer of the Claude `PostToolUse` group.
  `applyClaudePostEditHook(settingsPath)` reconciles it from the toggles and removes the four
  legacy markers (`__guardrails-hook`, `__trim-hook`, `__codegraph-hook post-edit`, and
  auto-lint's `lint-hook.mjs`) on every call, so an install that predates a merge migrates
  itself with no upgrade step to remember. A leftover legacy entry is the regression to watch
  for: it keeps paying the process start this exists to stop, and it is invisible.
- The code graph's marker carries its event argument (`__codegraph-hook post-edit`) because
  all four of its entries share a command name; matching the bare name would delete its
  `SessionStart`, `UserPromptSubmit` and `Stop` entries too. Auto-lint's is matched by its
  RUNNER PATH, because its command names a script rather than an enigma subcommand.
- `applyPostEditWiring()` is called from `syncDeployed()` (skills.ts), next to the verify
  re-assert, and **that call is the migration's only carrier for an existing install**. This
  group is wiring, not a file the sync loop copies, and nothing else rewrites it: `enigma
  update` reaches an install through `syncDeployed`, so without that call a pre-merge install
  keeps its separate entries and goes on paying the process starts until the user happens to
  run `enigma install` or toggle one of the features. The failure is invisible from the inside
  - the hooks still work, they just cost more - which is why `tests/post-edit-deploy.test.ts`
  pins the call rather than trusting it to stay. It shipped missing in 1.40.0 and was fixed in
  1.40.1.
- `lint.ts` no longer writes a Claude entry at all; toggling auto-lint reconciles this group
  instead (`applyClaudePostEditHook`), which is what keeps "turn one feature off" from
  deleting an entry three others need.
- `cli.ts` dispatches `__post-edit-hook` EARLY with a synchronous `readFileSync(0)` before any
  await, for the binary path that is now only reached by invoking the binary directly.
- The four per-feature hidden commands still exist and still work. opencode's generated
  plugins invoke them directly, and a `settings.json` that predates the merge still names them
  until its next reconcile.

## What is still a process per turn, and what is not enigma's to fix

Measured on the same machine, so the next person does not have to re-measure to know where
the remaining time goes:

- `__codegraph-hook prompt` (UserPromptSubmit): 0.3-1.7 s, once per user message.
- `__verify-hook` (Stop): 1.4-3.0 s when the message claims nothing, 4.6-13.5 s when it claims
  the work is done - the claim path reads git and the gate ledger. That is the largest single
  hook cost left in a turn.
- The floor under all of them is the machine's process start, and on Windows with Defender
  real-time scanning it is the whole cost: the same binary measured 109 ms and 1658 ms minutes
  apart. Excluding the binary and node from real-time scanning is the one lever that is not
  ours to pull, and it is worth more than any of the merges above.
