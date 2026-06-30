---
description: Build exploit chains from individual findings. Usage: /chain
---

# /chain

Build A→B→C exploit chains from individual findings.

## What This Does

1. Reads all findings from current session
2. Identifies chainable vulnerabilities
3. Builds chain with combined impact
4. Generates POC for each chain

## Known Chain Patterns

| Chain | Steps |
|-------|-------|
| Open Redirect → OAuth | redirect_uri → auth code theft → ATO |
| CORS + JS | wildcard + API key in JS → token theft |
| Subdomain Takeover | takeover + cookie on parent → session hijack |
| SSRF → Cloud | SSRF + metadata → IAM credentials |
| GraphQL + IDOR | introspection + missing field auth → PII |
| XSS + HttpOnly | stored XSS → session steal → ATO |
| IDOR (read) + IDOR (write) | read → enumerate → write → ATO |

## Usage

```
!chain
!chain --focus ssrf
```

## Output

```
EXPLOIT CHAINS: target.com
══════════════════════════════════════

Chain 1: CORS + Stored XSS → Full Account Takeover
────────────────────────────────────────────────────
Severity: CRITICAL
Payout estimate: $3,000-5,000

Steps:
1. Find CORS misconfig allowing credentials
2. Find stored XSS in user profile
3. XSS steals session token via CORS
4. Attacker logs in as victim

POC:
POST /api/settings HTTP/1.1
Host: target.com
...
```

## Chain Validation

Before pursuing a chain:
1. Confirm each step independently
2. A, B, C must be DIFFERENT bugs
3. Each must pass !validate gate