---
name: testing-policy
description: Test strategy (test pyramid), coverage gates, deterministic tests, mocking discipline, and regression-first bug fixing. Use when writing or changing code that needs tests, when asked to add or fix tests, or after fixing a bug to add a regression test.
---

# Testing Policy (Senior Engineering Standards)

## Activation Scope

- Apply whenever code is written, changed, or fixed, and whenever the user asks for tests.
- Owns test strategy, coverage expectations, determinism, and test-first discipline.
- Test file placement, suite layout, naming of test files, and fixture/helper organization live in test-organization-policy; apply it alongside this skill when creating or moving test files.

---

## Core Principle

- Untested behavior is unverified behavior. Treat tests as part of the deliverable, not an afterthought.
- A change is not done until its behavior is covered and the suite passes.
- Tests exist to catch regressions and document intended behavior, not to inflate coverage numbers.

---

## Test Strategy (Pyramid)

- Favor many fast unit tests, fewer integration tests, and a small number of end-to-end tests.
- Unit: pure logic and single modules in isolation.
- Integration: module boundaries, data access, and contracts between services.
- End-to-end: critical user-facing flows only.
- Push verification to the lowest layer that can prove the behavior.

---

## What To Test

- Every bug fix starts with a failing test that reproduces the bug, then the fix makes it pass (regression-first).
- Cover happy paths, boundary conditions, and failure/error paths.
- Test edge cases: empty, null, max size, invalid input, concurrency, and timezone/locale where relevant.
- Test public behavior and contracts, not private implementation details.
- For input handling, assert that invalid input is rejected as defined in validation-policy.

---

## Test Quality Rules

- Tests must be deterministic: no reliance on real time, randomness, network, or ordering.
- Control time, randomness, and external services via injection, fakes, or fixtures.
- Each test must be independent and able to run in isolation and in any order.
- One logical assertion focus per test; name tests by the behavior they verify.
- Follow Arrange-Act-Assert (or given-when-then) structure.
- No conditional logic or loops that hide which case actually ran.
- Tests must fail for the right reason; verify a test fails before making it pass.

---

## Mocking Discipline

- Mock external side effects (network, filesystem, clock, third-party APIs), not the code under test.
- Prefer fakes and real collaborators over deep mock chains.
- Avoid over-mocking that asserts implementation instead of behavior.

---

## Coverage & Gates

- Coverage is a signal, not a target; prioritize meaningful assertions over line count.
- Critical paths (auth, payments, data integrity, security boundaries) require thorough coverage.
- The full relevant suite must pass before delivery; never disable or skip tests to make a build green.
- If a test is flaky, fix the root cause or quarantine it explicitly with a tracked reason - never ignore silently.

---

## Reporting

- State plainly what was tested and the actual result.
- If tests fail, report the failure with output; do not claim success.
- If testing was skipped or partial, say so explicitly and why.