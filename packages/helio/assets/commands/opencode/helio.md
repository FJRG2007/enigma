---
description: Show Helio framework help — list all available commands and usage. Usage: /helio
tui: opencode
---

# Helio — Bug Bounty Framework

This is the Helio help command. Below are all available commands:

## Core Commands

- **/recon target.com** — Run full recon pipeline (subdomains, live hosts, URLs, nuclei)
- **/hunt target.com** — Start vulnerability hunting (IDOR, SSRF, XSS, auth bypass)
- **/validate** — 7-Question Gate validation on finding
- **/report** — Generate submission-ready bug bounty report
- **/chain** — Build exploit chains (A→B→C)

## Helper Commands

- **/scope asset** — Check if asset is in program scope
- **/triage** — Quick triage (7-Question Gate)
- **/pickup target.com** — Resume previous hunt
- **/remember** — Log finding to hunt memory
- **/intel target.com** — Fetch CVE and disclosure intel
- **/autopilot target.com** — Autonomous hunt loop
- **/surface target.com** — Ranked attack surface
- **/web3-audit contract.sol** — Smart contract audit
- **/token-scan contract.sol** — Meme coin / token rug pull scan

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
3. Run validation gate BEFORE writing report
4. KILL weak findings fast
5. 5-minute rule — no progress = move on

## TUI Compatibility

- **Claude Code** — Uses built-in Anthropic models
- **OpenCode** — Uses Go ($10/mo) or Zen models
- **OpenClaw** — Future support

## More Info

See CLAUDE.md or README.md for full documentation.
