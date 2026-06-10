---
name: task-completion-policy
description: Exhaustive completion discipline for long, complex, or multi-item tasks (1:1 ports, migrations, sweeping refactors, batch changes) - mechanical inventory of every work unit, a persistent coverage ledger, per-item verification, and an evidence-based completion gate that forbids declaring done while anything is missing. Use whenever a task spans many files or items, is likely to outlive one context window, or asks to port, migrate, convert, or replicate something completely.
---

# Task Completion Policy (Exhaustive Coverage & Verified Done)

## Activation Scope

- Apply to any task with more than a handful of work units: 1:1 ports, language/framework migrations, repo-wide refactors, "implement all X", multi-feature builds, large integrations.
- Owns inventory, coverage tracking, and completion claims. Subtask decomposition lives in core-engineering-policy; per-change review lives in code-review-policy; test strategy lives in testing-policy.

---

## Core Principle

- Completeness is measured against an enumerated inventory, never against memory or impression. "It looks done" is not evidence; an empty pending list plus passing verification is.
- An unfinished task reported honestly is acceptable. A finished-sounding report with silent gaps is a failure, and the most common failure mode of long tasks - this policy exists to prevent it.

---

## Phase 1 - Inventory (Before Any Implementation)

- Enumerate EVERY unit of work mechanically, with deterministic commands, not by recalling or sampling:
  - Port/migration: all source files, public symbols/exports, endpoints, CLI commands, config keys, assets (file listings, grep counts, compiler/AST symbol dumps).
  - Multi-item feature work: every item from the spec, issue, or user message, one per line.
- Record the counts (e.g. "src: 87 files, 412 exported functions"). Counts are the completion oracle for Phase 3.
- Persist the inventory as a checklist artifact that survives context loss: a file in the working tree (e.g. `.task/coverage.md`) or the runtime's persistent todo/task system. One line per unit with status `pending`, `done`, `blocked(<reason>)`, or `deferred(<user-approved reason>)`.
- If the full inventory cannot be enumerated, that is a blocker to surface and resolve (narrow the scope with the user) - never silently work on a sample of it.

---

## Phase 2 - Execute Against the Ledger

- Work unit by unit (or in coherent batches). Flip a unit to `done` only after its own verification - it compiles/typechecks, its tests pass, or a smoke check ran - never because a similar unit worked.
- Never silently skip, stub, or simplify a unit. A stub, TODO, or partial implementation keeps the unit `pending` or `blocked` with the reason recorded. Schedule hard units early; difficulty is a reason to start sooner, not to defer.
- On context compaction, session resume, or sub-agent handback: re-read the ledger FIRST and continue from it. Never reconstruct progress from memory - that is where items get dropped.
- Sub-agents must report which ledger units they completed and how each was verified; unverified claims stay `pending`.

---

## Phase 3 - Completion Gate (Before Saying "Done")

A completion claim is forbidden unless ALL of these hold:

1. The ledger has zero `pending` and zero `blocked` units. `deferred` units require the user's explicit approval and must appear in the final report.
2. Counts reconcile mechanically: target counts match the inventory (files ported vs source files, symbols vs symbols, endpoints vs endpoints). Run the comparison commands; never estimate.
3. The whole artifact builds/compiles/typechecks and the test suite (or smoke run) passes - not just the last file touched.
4. A final sweep finds no incompleteness markers introduced by this task: grep the produced code for TODO, FIXME, "not implemented", placeholder/stub patterns. Every hit is fixed or explicitly reported.
5. Self-review per code-review-policy.

- If any check fails, the task is NOT done: state exactly what remains and keep working (or report the blocker). Never say "everything is complete", "fully ported", or "all done" while the ledger has open units.
- Words like "complete", "all", "every", and "fully" in a final report are claims that must be backed by checks 1-4.

---

## Honest Reporting

- The final report must state: total units, done, deferred (with approval), and the verification evidence (commands run and their results).
- Anything that could not be verified is reported as unverified. Never upgrade unverified to done.

---

## Token Efficiency (Coverage Without Burning Tokens)

- Enumerate and count with shell commands (ls/find/grep/wc, compiler output), not by reading files into context. The ledger lives on disk, not in the conversation.
- Read each source unit once, when implementing it; do not re-read finished units. The ledger status is the cache - never re-verify unchanged units.
- Verify per unit with the cheapest sufficient check (typecheck one file, run its tests); reserve full-suite runs for batch boundaries and the completion gate.
- Batch trivial units (constants, type-only files) into one pass and spend the saved tokens on the hard units.
- Update the ledger with small status-line edits, not full rewrites.
