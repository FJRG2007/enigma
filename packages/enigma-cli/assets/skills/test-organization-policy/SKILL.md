---
name: test-organization-policy
description: Expert test-suite organization - directory structure by test type and domain, mirrored source paths, file naming conventions, and fixture/helper/factory placement. Use when creating, moving, or renaming test files, scaffolding or restructuring a test suite, or deciding where a new test lives - never dump tests flat into a single tests/ folder.
---

# Test Organization Policy (Senior Engineering Standards)

## Activation Scope

- Apply whenever a test file is created, moved, or renamed, and whenever a test suite is scaffolded or restructured.
- Owns test-suite layout: directory structure, subfolders, file naming, and placement of fixtures, helpers, factories, and mocks.
- Test strategy, coverage, determinism, and mocking discipline live in testing-policy; compose with it, never restate it.

---

## Core Principle

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
- Suite and case names describe behavior, not implementation (naming-by-behavior rules live in testing-policy).
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
