---
name: code-review-policy
description: Pre-delivery self-review gate and prioritized review dimensions (security, correctness, data integrity, reuse, performance, readability) with change-quality criteria. Use BEFORE declaring any code change complete, and when asked to review a diff, PR, or branch.
---

# Code Review Policy (Self-Review & Quality Gate)

## Activation Scope

- Apply before delivering any code change, and whenever the user asks to review a diff, PR, or branch.
- Owns the self-review gate and review dimensions. Commit/PR mechanics live in git-policy; bug-hunting methodology lives in debugging-policy.

---

## Core Principle

- Review your own change before presenting it as done. The diff is the deliverable; read it as a reviewer would.
- Optimize the review for the reader: small, focused, and easy to reason about.
- Report findings honestly, including ones you chose not to fix and why.

---

## Pre-Delivery Self-Review (Mandatory)

Before declaring a change complete, verify:

1. The change does exactly what was asked - no more, no less.
2. The full diff was re-read; no debug code, stray logs, commented-out blocks, or TODOs left behind.
3. Only relevant files are touched; unrelated changes are removed.
4. No secrets, credentials, or sensitive data are included.
5. Existing patterns, naming, and structure are followed (per core-engineering-policy).
6. Tests exist and pass for the changed behavior (per testing-policy).
7. The change covers the whole class the request implied, not only the example the user named (per core-engineering-policy's Generalization Rule) - or states which siblings were deliberately left and why.

---

## Review Dimensions

Evaluate every change across these dimensions, in priority order:

1. Security: untrusted input, injection, authz/authn, secret exposure, least privilege.
2. Correctness: logic, edge cases, error/failure paths, concurrency, off-by-one, null handling.
3. Data integrity: transactions, consistency, and the database-expert rules when persistence is involved.
4. Reuse & architecture: duplication, single responsibility, fit with existing modules.
5. Performance & scalability: N+1 queries, unnecessary work in hot paths, allocation in loops.
6. Readability & maintainability: clear naming, reasonable function size, self-documenting code.
7. Style: formatting and conventions (lowest priority).

---

## Finding Quality

- Be specific: point to the exact location and explain the concrete impact, not vague concerns.
- Separate must-fix (correctness, security) from nice-to-have (style, minor refactor).
- Prefer high-confidence findings; flag uncertain ones explicitly as uncertain.
- Suggest a concrete fix or direction, not just a complaint.
- Do not invent issues to appear thorough; "no issues found" is a valid result.

---

## Change Quality Gate

A change should not be delivered if it:

- Introduces a security or data-integrity risk.
- Breaks or skips tests, or ships untested critical behavior.
- Duplicates logic that already exists, or stores duplicated/derivable data without justification.
- Mixes unrelated concerns in one change.
- Fixes the reported instance while identical instances of the same defect stay untouched in the codebase.
- Leaves the codebase less consistent than it found it.