---
description: Run autonomous hunt loop on a target — scope → recon → rank → hunt → validate → report. Usage: /autopilot target.com [--paranoid|--normal|--yolo]
---

# /autopilot

Autonomous hunt loop with deterministic scope safety and configurable checkpoints.

## Usage

```
!autopilot target.com                    # default: --paranoid
!autopilot target.com --normal         # batch checkpoint after validation
!autopilot target.com --yolo           # minimal checkpoints
```

## What This Does

```
1. SCOPE      Load and confirm program scope
2. RECON     Run recon (or use cached if < 7 days old)
3. RANK      Prioritize attack surface
4. HUNT      Test P1 endpoints systematically
5. VALIDATE  7-Question Gate on findings
6. REPORT   Draft reports for validated findings
7. CHECKPOINT Present to human for review
```

## Safety Guarantees

- Every URL is checked against scope allowlist before any request
- Every request is logged to audit.jsonl
- Reports are NEVER auto-submitted — always requires approval
- PUT/DELETE/PATCH require human approval in --yolo mode
- Circuit breaker stops if 5 consecutive 403/429/timeout

## Checkpoint Modes

| Mode | When it stops | Best for |
|---|---|---|
| `--paranoid` | Every finding | New targets |
| `--normal` | After validation batch | Systematic coverage |
| `--yolo` | After surface exhausted | Familiar targets |

## After Autopilot

- Run `!remember` to log patterns to memory
- Run `!resume target.com` to pick up where left off