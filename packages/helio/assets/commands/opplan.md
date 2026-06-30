---
description: Create and track an engagement OPPLAN — structured objectives with phases, dependencies, and status tracking. Usage: /opplan [new|status|update]
---

# /opplan

Engagement Objective Plan. Breaks a hunt or VAPT into structured objectives with clear dependencies, success criteria, and status tracking.

## Usage

```
/opplan new                    # create new engagement plan
/opplan status                 # show current objective status
/opplan update OBJ-001 done    # mark objective complete
/opplan next                   # show what to work on next
```

## What This Does

Creates `targets/<target>/opplan.md` — a structured plan the agent reads at the start of each session to know exactly what's been done and what's next.

Unlike a generic to-do list, OPPLAN captures:
- Phase dependency (don't exploit before recon is done)
- Which objectives are blocked by others
- Crown jewels (what attacker most wants to reach)
- Current objective the agent is working on

## OPPLAN Structure

```markdown
# OPPLAN — <TARGET> | <DATE>

## Crown Jewels
- <what the attacker wants most: admin panel, DB, customer PII, internal API>

## Objectives

### Phase 1: Recon
- [ ] OBJ-001: Subdomain enumeration — subfinder + amass + crt.sh
- [ ] OBJ-002: Live host discovery — httpx + nuclei
- [ ] OBJ-003: URL crawl + parameter discovery

### Phase 2: Vulnerability Discovery
- [ ] OBJ-004: Automated scan — nuclei full templates [DEPENDS: OBJ-001, OBJ-002]
- [ ] OBJ-005: Manual hunt — IDOR on API endpoints [DEPENDS: OBJ-003]
- [ ] OBJ-006: Auth bypass testing — all sibling endpoints
- [ ] OBJ-007: SSRF testing — URL parameters [DEPENDS: OBJ-003]

### Phase 3: Exploitation
- [ ] OBJ-008: Exploit confirmed findings [DEPENDS: OBJ-004-OBJ-007]
- [ ] OBJ-009: Chain findings into escalation path

### Phase 4: Reporting
- [ ] OBJ-010: Validate all findings through gates
- [ ] OBJ-011: Generate reports

## Current Status
| ID | Objective | Phase | Status | Notes |
|----|-----------|-------|--------|-------|
| OBJ-001 | Subdomain enum | Recon | TODO | |
```

## Status Values

- `TODO` — not started
- `IN_PROGRESS` — actively working
- `BLOCKED` — waiting on dependency
- `DONE` — complete
- `SKIP` — skipped with reason

## Workflow

1. `/roe` first — lock scope before creating OPPLAN
2. `/opplan new` — generates phase-appropriate objectives based on engagement type
3. Before each session: read OPPLAN to pick next available objective
4. After each session: `/opplan update OBJ-XXX done`
5. Completed OPPLAN = engagement complete → run `/report`

## Auto-Updating

The agent updates OPPLAN status automatically when:
- Recon completes → marks recon objectives done
- Finding confirmed → notes in relevant objective
- Objective blocked → marks as BLOCKED with reason
