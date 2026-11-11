# Vendored: security-audit

This skill is vendored from Cloudflare's open-source `security-audit-skill`, licensed MIT
(see `LICENSE`). It runs only inside the isolated Helio agent context, never the normal coding
agent. Helio wires it through the `/audit` command and the natural-language routing in
`AGENTS.md`.

- Upstream: https://github.com/cloudflare/security-audit-skill
- Base commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (`skills/security-audit/`)
- Refreshed by the maintainer with `node scripts/sync-security-audit.mjs` from the monorepo root;
  `scripts/sync-helio.mjs` preserves this directory when it replaces the Helio tree.

## Patches applied on top of the base commit

Picked from the upstream project's open pull requests after review; the full diffs are in this
repo's git history.

- **#145** - Windows support for the validators: an identity-checked open (`lstat` -> `open` ->
  `fstat` -> re-`lstat`, comparing `dev`/`ino`, refusing `ino 0`), plus a UNC/device-path refusal.
  Without it `validate-findings.cjs` and `validate-coverage-ledger.cjs` reject every input on
  Windows. Other platforms lacking `O_NOFOLLOW`/`O_NONBLOCK` still fail closed.
- **#63** - the validators reject anything other than exactly one input path, instead of silently
  ignoring extra arguments.
- **#45** - `line` is upper-bounded at 2147483647 (`Number.isInteger(1e308)` is otherwise true).
- **#111** - `validate-findings.cjs` enforces a 1,000-fields-per-object limit (before and after
  parse), matching the ledger validator.
- **#102 / #103** - both validators reject duplicate object keys (decoded, so escaped duplicates
  are caught too), closing a record that can say two different things.

## Reviewed, deferred to a future upstream sync

These upstream PRs were reviewed and judged worthwhile but not applied now: they are refinements to
an already-correct skill, several conflict with each other, and hand-merging them into a security
tool risks transcription errors. Revisit them with `sync:security-audit` once upstream merges them,
or port deliberately with their tests.

- Workflow safety (docs): #108 (treat target content as untrusted in every agent prompt), #95
  (sanitized repo ID + exclusive run dir + untrusted prior-run check), #76 (clean-clone-only git /
  symlink handling), #58+#13 (sequential fallback + live-child cap; a refusal is not coverage),
  #50 (config-dependent reachability stays `needs_validation`), #89 (`preserved_uses` + regression
  case), #125 (critic returns `{coverage_id, reason}`), #132 (recon deployment controls become
  ledger units), #80 part 1 (scope Phase 5/6 gates to confirmed/needs_validation).
- Validator logic: #82 (artifact sharing within one attempt), #104 (ordinary block not in its own
  excluded list), #143 (reject reused archived verifier owners), #127 (assigned-state attack-class
  block), #84 (`--terminal`, never-returned rule), #48 validator-only (on-disk artifact identity
  check), #44 (`FINGERPRINT_PATTERN` in findings), #85 (a `validate-run-metadata.cjs`).
- Content companions: #142 (crypto/secrets, BaaS, Web3 companions + SARIF export + `coverage-id.cjs`),
  #116 (`ANDROID.md`), #101 (extra crypto classes), #93 (abort-path / stale-worker memory classes),
  #35 (edge-isolate state + KV races), #23 (streaming early-dispatch), #90 (CWE/CVSS/references on
  findings), #92 (domain-format validators as ledger units), #121/#119 (domain-companions section).
- Flagged unsafe / skip: #113, #99, #59 (lstat/open race Windows fixes superseded by #145), #129
  `host-lock.cjs` (legitimizes host mutation), #26 `--schema-only` (bypasses the evidence check),
  #74/#73 (change `findings.json` shape), #83 part 2 (retracted by its own issue author).

## Helio-local changes

- `SKILL.md` "Universal execution safety": an explicit guard that a scratch-local `HOME` is never
  a reason to delete or reset the real profile (upstream issue #128, where an agent wiped a user
  profile), a source-only fallback when no sandbox can be proven, and two matching anti-patterns.
