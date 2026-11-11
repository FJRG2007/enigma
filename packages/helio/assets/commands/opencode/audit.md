---
description: Full multi-phase security audit of a codebase you can read (white-box). Runs the security-audit skill's six phases - recon, coverage-led hunting, candidate validation, structured findings, independent verification, and a target-neutral report - with every finding backed by a source trace and a bounded result. Usage: /audit [path] [--quick|--deep]
tui: opencode
---

# /audit

Run a complete, source-first security audit of a codebase and produce verified, machine-readable
findings. This drives the vendored `security-audit` skill (`skills/security-audit/SKILL.md`), which
owns the full methodology; this command is the entry point and the Helio-specific wiring.

## Usage

```
/audit                      # audit the current repo (standard profile)
/audit ./path/to/repo       # audit a specific path
/audit --quick              # one bounded pass, for small targets or a fast first look
/audit --deep               # high-stakes or large targets, critic waves to a clean pass
```

## When to use

- The user owns or is authorized to review the code and asks to "audit", "pen-test", or do a
  "full / comprehensive / end-to-end security review", or asks for report artifacts.
- For a quick question, a focused review, or "is this exploitable?", do NOT run the full workflow -
  use the skill in guidance mode (and Helio's `/triage`, `/validate`).

## How it runs

1. Load `skills/security-audit/SKILL.md` and follow its six phases in order. It is agent-neutral:
   its **parent** is you, its **Task tool** is Claude Code's subagents, and its `research` / `general`
   roles map to Helio's `recon-agent` / `validator` style delegated agents.
2. **Execution safety first.** Source inspection is read-only. Run target-controlled code only inside
   an OS-enforced sandbox with every control the skill lists. A scratch-local `HOME` is a path into
   `scratch/`, never a reason to touch the real profile. If no sandbox can be proven on this host
   (common on Windows without WSL2/Docker/Windows Sandbox), say so and run source-only: no finding
   reaches `confirmed` by execution, blocked facts become `needs_validation`.
3. **Output directory** defaults to outside the target (`~/security-audit-skill/<repo>/run-<N>`).
4. Validate `findings.json` with `validate-findings.cjs` and the coverage claim with
   `validate-coverage-ledger.cjs` (both run on Windows). A record is `confirmed` only with a complete
   source trace, a verbatim byte quote at the cited line, and a bounded observed result.

## Helio integration

- **Evidence bar.** This is the white-box / `--source-code` path. The same discipline as Helio's
  `rules/source-audit.md` applies: a candidate needs a crossed trust boundary and a concrete result,
  not a missing best practice. The skill's `confirmed` verdict is the audit equivalent of Helio's
  internal finding gate.
- **Persistent ledger.** When the repo is team-owned (white-box), mirror each `confirmed` finding
  into the repo's own `docs/vulnerabilities/` ledger per `AGENTS.md` rule 12 and `rules/source-audit.md`:
  read it before hunting to skip known findings and flag regressions, write confirmed findings back
  after verification. The skill's run output stays outside the target; the ledger is the in-repo
  memory for the devs. Never write a ledger into a third-party target you do not own.
- **Reporting.** Hand verified `confirmed` records to Helio's `report-writing` skill when the user
  wants a platform report; the audit's `REPORT.md` is target-neutral and stays source-only.
