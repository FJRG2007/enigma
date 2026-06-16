---
name: testing-policy
description: Test strategy (test pyramid), coverage gates, deterministic tests, mocking discipline, regression-first bug fixing, and test-suite organization (directory structure by test type and domain, mirrored source paths, file naming, fixture/helper/factory placement). Use when writing or changing code that needs tests, when asked to add or fix tests, after fixing a bug to add a regression test, or when creating, moving, renaming, or structuring test files - never dump tests flat into a single tests/ folder.
---

# Testing Policy (Senior Engineering Standards)

## Activation Scope

- Apply whenever code is written, changed, or fixed, and whenever the user asks for tests.
- Apply whenever a test file is created, moved, or renamed, and whenever a test suite is scaffolded or restructured.
- Owns test strategy, coverage expectations, determinism, mocking discipline, and test-first discipline.
- Owns test-suite layout: directory structure, subfolders, file naming, and placement of fixtures, helpers, factories, and mocks.

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

## Suite Organization: Core Principle

- A test suite is navigable code: anyone must find the tests for a module in seconds from the module's path alone, and find the module from its test's path.
- Never dump test files flat into a single tests/ folder. Flat suites hide coverage gaps, cause name collisions, and stop scaling past a handful of files.
- Organize from the first test file. Structure is cheapest at file creation and most expensive after the folder is a mess.

---

## Framework Convention First

- Every ecosystem has an established convention; it beats any custom layout:
  - JS/TS (Vitest, Jest, Bun): colocated `*.test.ts` next to the source file, a `__tests__/` folder per directory, or a mirrored `tests/` tree - follow whichever the repo already uses.
  - Python (pytest): a `tests/` package mirroring the source package; shared fixtures in `conftest.py` at the narrowest directory that covers their users.
  - Go: `_test.go` colocated in the same package (mandated by the toolchain); black-box tests use the `_test` package suffix.
  - Rust: unit tests in `#[cfg(test)] mod tests` inside the module; integration tests as separate files under the crate-root `tests/`.
  - Java/Kotlin: `src/test/<lang>/` mirroring the `src/main/<lang>/` package path exactly.
- In an existing repo, detect the established layout and extend it; never introduce a second competing layout. Migrations to a better layout are proposed explicitly, not done by stealth.

---

## Structure by Test Type, Then by Domain

- When more than one test type exists, separate types at the top level - they differ in speed, dependencies, and CI stage:

  ```text
  tests/
    unit/          fast, isolated, no I/O
    integration/   module boundaries, DB, contracts
    e2e/           critical user flows only
    fixtures/      shared static data
    helpers/       shared builders, factories, fakes
  ```

- Inside each type, mirror the source tree: tests for `src/<domain>/<module>` live at `tests/<type>/<domain>/<module>.<suffix>`.
- Group e2e tests by user flow (e.g. `e2e/checkout/`), not by source module - flows cross modules.
- Default to one test file per module under test; split a large file by scenario, never by arbitrary size cuts.
- Keep the test runner's discovery config (`testMatch`, `testpaths`, includes) in sync with the layout; a test the runner cannot find is dead code.

---

## Naming Conventions

- Test file name = module under test + the framework's suffix: `parser.test.ts`, `test_parser.py`, `parser_test.go`.
- When splitting by scenario, encode the scenario in the name: `parser.errors.test.ts`, `auth.session-expiry.test.ts`.
- Suite and case names describe behavior, not implementation - name tests by the behavior they verify, consistent with the Test Quality Rules above.
- Forbidden names: `test1`, `misc`, `temp`, `new`, `utils-tests`, or any name that does not identify what is verified.

---

## Shared Test Code Placement

- Fixtures (static data), factories/builders (object construction), helpers (setup/assertion logic), and fakes each get their own folder; do not mix them in one grab-bag file.
- Place shared test code at the narrowest scope that covers its users; promote it upward only when a second consumer appears (same reuse rule as production code).
- Test helpers are production code: deduplicate, name well, and review them like any other module.
- Never import from another test file; extract the shared piece into a helper module instead.
- Large fixtures live as data files under `fixtures/`, named after the scenario they encode, not inlined into test bodies.

---

## Scaling & Maintenance

- When adding a test to an existing flat or misplaced suite: place the new test correctly and surface the layout debt; do not extend the mess to match it.
- Layout migrations are pure moves: never change test logic in the same commit as a file move (atomic-commit rule in git-policy).
- After any move, run the affected suite to prove discovery still works, and delete emptied folders.
- If two layouts coexist after a partial migration, finish the migration or document the boundary; a half-migrated suite is worse than either layout.

---

## Decision Rule: Colocated vs Centralized

- Colocated tests (next to source) fit unit tests in ecosystems that idiomatically support it (JS/TS, Go, Rust) - shortest navigation distance, moves with the code.
- A centralized `tests/` tree fits integration/e2e tests, packages that must exclude tests from the published artifact, and ecosystems whose tooling expects it (Python, Java).
- Mixing is fine when each side follows its rule (e.g. colocated unit + centralized integration); mixing within the same test type is not.

---

## Reporting

- State plainly what was tested and the actual result.
- If tests fail, report the failure with output; do not claim success.
- If testing was skipped or partial, say so explicitly and why.
