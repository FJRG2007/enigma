---
name: debugging-policy
description: Reproduce-isolate-fix debugging methodology with root-cause discipline and regression verification. Use when investigating a bug, crash, failing test, regression, error, or any unexpected behavior.
---

# Debugging Policy (Root-Cause Methodology)

## Activation Scope

- Apply whenever investigating a bug, failure, crash, regression, or unexpected behavior.
- Owns the reproduce-isolate-fix methodology and root-cause discipline.

---

## Core Principle

- Fix the root cause, not the symptom.
- Understand why the bug happens before changing any code.
- Do not guess-and-check randomly; each step must be driven by evidence.

---

## Methodology

1. Reproduce: establish a reliable, minimal reproduction. If it cannot be reproduced, gather more evidence first.
2. Observe: collect facts - error messages, stack traces, logs, inputs, and actual vs expected behavior.
3. Form a hypothesis: a specific, falsifiable theory of the cause based on the evidence.
4. Isolate: narrow the surface using bisection, logging, or targeted breakpoints until the faulty unit is identified.
5. Confirm: prove the hypothesis (the failing case maps to the identified cause) before fixing.
6. Fix: address the underlying cause at the right layer.
7. Verify: add a regression test that fails before the fix and passes after (per testing-policy), then run the relevant suite.
8. Generalize: the reported failure is one instance of a class. Search deterministically for every other occurrence of the same root cause, fix them in this same change, and encode the invariant where it can be checked without you (core-engineering-policy's Generalization Rule).

---

## Investigation Rules

- Read the actual error and the actual code path; do not assume from names or memory.
- Change one variable at a time so cause and effect stay clear.
- Reproduce before fixing and verify after; never declare a fix without confirming it.
- Prefer the smallest change that fixes the root cause; avoid scope creep during a fix.
- If a recalled detail names a file, function, or flag, verify it still exists before relying on it.

---

## Root-Cause Discipline

- Ask why repeatedly until reaching the true origin, not the first plausible layer.
- Distinguish the trigger (what surfaced it) from the cause (what is actually wrong).
- A workaround is acceptable only as an explicit, temporary measure with the real cause documented.
- When the cause spans multiple components, fix it where the invariant is actually owned.
- The reported symptom is a sample, not the population. Once the cause is known, find its other victims by searching for the CAUSE (the wrong call, the missing guard, the unchecked shape), not for the symptom the user happened to notice.

---

## Reporting

- State the root cause plainly, the evidence for it, and the fix applied.
- If the cause is uncertain, say so and describe the leading hypothesis and what would confirm it.
- If a workaround was used instead of a true fix, label it clearly and note the follow-up.