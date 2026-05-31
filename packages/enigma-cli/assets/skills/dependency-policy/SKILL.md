---
name: dependency-policy
description: Dependency and supply-chain security - lockfiles and reproducible installs, version pinning, vulnerability auditing, minimizing and vetting third-party packages, vendoring obscure code instead of fragile remote dependencies, and SBOM/provenance. Use when adding, upgrading, removing, or auditing dependencies, or editing package manifests, lockfiles, or build/CI dependency steps.
---

# Dependency & Supply-Chain Policy

## Activation Scope

- Apply whenever a dependency is added, upgraded, removed, or audited, and when editing package manifests, lockfiles, or CI/build steps that fetch dependencies.
- This skill owns third-party dependency and supply-chain risk. Runtime application security is owned by security-policy; commit/PR mechanics by git-policy.

---

## Add Dependencies Deliberately

- Prefer the standard library or existing project utilities before adding a dependency.
- Justify every new dependency: real need, active maintenance, healthy adoption, compatible license, and acceptable transitive footprint.
- Avoid trivial micro-packages that add supply-chain surface for little value; a small amount of owned code can beat a risky dependency.
- Watch for typosquatting and confusable names; verify the exact package name, owner, and repository before installing.

---

## Pin & Reproduce

- Always commit the lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock, poetry.lock, etc.); it is the source of truth for what actually installs.
- Use reproducible, locked installs in CI and release (e.g. `npm ci`, not `npm install`), so builds are deterministic.
- Pin versions deliberately; avoid loose ranges for anything security-sensitive. Upgrade intentionally, not implicitly.
- Keep one package manager per project; do not mix lockfiles from different managers.

---

## No Fragile Remote Dependencies

- Do not depend on code fetched from arbitrary remote URLs or CDNs at build or runtime (aligns with ciphera-style-policy).
- For obscure or unmaintained libraries, vendor the needed code into the project (with attribution and license) instead of taking a live dependency, so the supply chain stays under your control.
- Pin and verify any external artifact you must fetch (checksums/integrity hashes); never trust mutable remote sources.

---

## Audit & Patch

- Run a vulnerability audit (`npm audit`, `pip-audit`, `osv-scanner`, or equivalent) as part of CI; fail the build on high/critical advisories.
- Triage findings promptly: patch, upgrade, or document an accepted risk with justification and an expiry; do not silently ignore.
- Keep dependencies reasonably current; large version gaps make security patches harder to adopt.
- Prefer automated dependency-update tooling (Dependabot/Renovate) with CI gating so updates are reviewed and tested, not blind-merged.

---

## Provenance & SBOM

- For enterprise/release builds, generate an SBOM (e.g. CycloneDX or SPDX) so shipped components are inventoried and auditable.
- Prefer packages and registries that support provenance/signing; verify integrity where the ecosystem allows.
- Review licenses for compatibility and obligations before shipping; treat license compliance as a release gate.

---

## Verification (Make It Mechanical)

- Enforce these rules deterministically in CI: locked install, audit gate, license check, and (for releases) SBOM generation.
- A dependency change is not done until the audit and license gates pass; a failing gate blocks merge.
