---
description: Create a Rules of Engagement document for a VAPT or red team engagement — defines scope, authorized actions, testing window, escalation contacts, and OPSEC level. Usage: /roe
tui: opencode
---

# /roe

Create a Rules of Engagement (RoE) document before starting any VAPT or red team engagement.

## What This Does

Generates a structured `targets/<engagement>/roe.md` document that defines:
- Authorized targets (in-scope domains, IPs, cloud resources)
- Explicitly excluded assets
- Permitted and prohibited actions
- Testing window and timezone
- Escalation contacts (minimum 2)
- OPSEC level for the engagement

## Usage

```
/roe
/roe --name "acme-corp-ext-2026"
```

## Workflow

### Step 1 — Collect Info (ask user)

**Round 1:**
1. Engagement name and client/target organization
2. Engagement type: `bug-bounty` / `external-vapt` / `internal-vapt` / `assumed-breach`
3. In-scope targets (domains, IP ranges, cloud accounts)
4. Out-of-scope assets (explicit exclusions)

**Round 2:**
1. Testing window (start/end date, allowed hours, timezone) — skip for bug bounty
2. Prohibited actions beyond defaults
3. Special permitted actions (phishing, spraying, physical, etc.)
4. Escalation contacts: name, role, contact method (for VAPT engagements)
5. OPSEC level: `loud` / `standard` / `careful` / `quiet`

### Step 2 — Generate roe.md

Create `targets/<name>/roe.md` with the collected info.

**Default prohibited actions (always included):**
- Denial of Service or actions that degrade availability
- Social engineering unless explicitly authorized
- Physical access unless explicitly authorized
- Exfiltration of real user data (document existence only)
- Modification of production data

### Step 3 — Confirm and Lock Scope

Present a one-page summary to the user for confirmation.
Once confirmed, load scope into `tools/scope_checker.py` for enforcement.

## Output Format

```markdown
# Rules of Engagement — <ENGAGEMENT NAME>

**Engagement Type:** <TYPE>
**OPSEC Level:** <LEVEL>
**Status:** ACTIVE

## Authorized Targets
- ...

## Explicitly Out of Scope
- ...

## Testing Window
- Start: ...
- End: ...
- Allowed hours: ...

## Permitted Actions
- Passive recon
- Active scanning within rate limits
- Exploitation of confirmed vulnerabilities
- <additional authorized actions>

## Prohibited Actions
- Denial of Service
- <additional exclusions>

## Escalation Contacts
| Name | Role | Contact | Use For |
|------|------|---------|---------|
| ...  | ...  | ...     | ...     |

## Authorization Reference
<Contract number / bug bounty program URL>
```

## OPSEC Level Guide

| Level | Description | Scan Rate | User-Agent |
|-------|-------------|-----------|-----------|
| `loud` | Speed over stealth — dev/staging | Unlimited | Default tools |
| `standard` | Balance speed and detection risk | 20 req/sec | Rotated |
| `careful` | Minimize detection — production | 5 req/sec | Browser UA |
| `quiet` | Assume active SOC monitoring | 1-2 req/sec | Randomized |

Load the OPSEC skill for detailed rate limiting guidance: `/opsec`
