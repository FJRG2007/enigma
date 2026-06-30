---
description: Show Helio framework help. Usage: /helio
---

# Helio — Bug Bounty Framework

This is the Helio help. All commands available:

## Core Commands

- **/recon** — Full recon pipeline (subdomains, live hosts, URLs, nuclei)
- **/hunt** — Start vulnerability hunting (IDOR, SSRF, XSS, auth bypass)
- **/validate** — 7-Question Gate validation
- **/report** — Generate submission-ready report
- **/chain** — Build exploit chains

## Helper Commands

- **/scope** — Check if asset is in program scope
- **/triage** — Quick triage
- **/pickup** — Resume previous hunt
- **/remember** — Log finding to memory
- **/intel** — Fetch CVE intel
- **/autopilot** — Autonomous hunt loop
- **/surface** — Ranked attack surface
- **/web3-audit** — Smart contract audit
- **/token-scan** — Meme coin / token rug pull scan

## Quick Start

```
/recon target.com    # Run recon
/hunt target.com    # Start hunting
/validate           # Validate finding
/report             # Generate report
```

## Rules

1. READ FULL SCOPE before touching any asset
2. NEVER hunt theoretical bugs
3. Run validation BEFORE writing report
4. KILL weak findings fast
5. 5-minute rule — no progress = move on

## More Info

See CLAUDE.md for full documentation.