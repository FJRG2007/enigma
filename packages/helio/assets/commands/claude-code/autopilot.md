---
description: Run autonomous hunt loop on a target — scope check → recon → rank surface → hunt → validate → report with configurable checkpoints. Usage: /autopilot target.com [--paranoid|--normal|--yolo]
---

# /autopilot

Autonomous hunt loop with deterministic scope safety and configurable checkpoints.

## Usage

```
/autopilot target.com                    # default: --paranoid mode
/autopilot target.com --normal           # batch checkpoint after validation
/autopilot target.com --yolo             # minimal checkpoints (still requires report approval)
```

## What This Does

Runs the full hunt cycle without stopping for approval at each step:

```
1. SCOPE     Load and confirm program scope
2. RECON     Run recon (or use cached if < 7 days old)
3. RANK      Prioritize attack surface (recon-ranker agent)
4. HUNT      Test P1 endpoints systematically
5. VALIDATE  7-Question Gate on findings
6. REPORT    Draft reports for validated findings
7. CHECKPOINT  Present to human for review
```

## Safety Guarantees

- **Every URL** is checked against the scope allowlist before any request — hard stop if not in scope
- **Scope creep is a hard failure** — if a host is not in the defined scope list, autopilot skips it entirely and logs the skip
- **Every request** is logged to `hunt-memory/audit.jsonl`
- **Reports are NEVER auto-submitted** — always requires explicit approval
- **PUT/DELETE/PATCH** require human approval in --yolo mode (safe methods only)
- **Circuit breaker** stops hammering if 5 consecutive 403/429/timeout on same host
- **Rate limited** at 1 req/sec (testing) and 10 req/sec (recon)
- **MCP browser tools** are used only for account creation and interactive flows — all standard HTTP requests use curl/fetch

## Impact Filter (Applied Before Report Step)

Autopilot only drafts reports for findings that pass the impact threshold:

```
REPORT:  CVSS >= 4.0 (Medium or above) — confirmed, with evidence
REPORT:  Lower severity but confirmed part of an exploit chain reaching CVSS >= 4.0
SKIP:    Informational findings (missing headers, GraphQL introspection, version disclosure)
SKIP:    Standalone low-impact findings (open redirect alone, SSRF DNS-only, self-XSS)
SKIP:    Any finding that fails the 7-Question Gate at Q6 (no proof beyond "technically possible")
```

Informational reports damage your validity ratio. Autopilot kills them before they cost you time.

## Checkpoint Modes

| Mode | When it stops | Best for |
|---|---|---|
| `--paranoid` | Every finding + partial signal | New targets, learning the surface |
| `--normal` | After validation batch | Systematic coverage |
| `--yolo` | After full surface exhausted | Familiar targets, experienced hunters |

## Report Generation (Step 6)

When autopilot reaches the REPORT step, it follows the same rules as `/report`:

- Always generate a full PoC from the request/response data captured during hunting
- No AI-style formatting: no `---` separators, no em-dashes, prose summary, human tone

## After Autopilot

- Run `/remember` to log successful patterns to hunt memory
- Run `/pickup target.com` next time to pick up where you left off
- Check `hunt-memory/audit.jsonl` for a full request log
