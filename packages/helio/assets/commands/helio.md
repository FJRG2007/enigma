---
description: Show Helio framework help — list all available commands and usage. Usage: /helio
---

# /helio

Helio — Multi-TUI Bug Bounty Framework

## What is Helio?

A TUI-agnostic bug bounty and VAPT framework that works with:
- **Claude Code** (native models)
- **OpenCode** (Go $10/mo or Zen pay-per-token)
- **OpenClaw** (future)

## Available Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/recon` | `/recon target.com` | Full recon pipeline |
| `/hunt` | `/hunt target.com` | Start vulnerability hunting |
| `/validate` | `/validate` | 7-Question Gate validation |
| `/report` | `/report` | Generate bug bounty report |
| `/chain` | `/chain` | Build exploit chains |
| `/scope` | `/scope asset` | Check scope |
| `/triage` | `/triage` | Quick triage |
| `/pickup` | `/pickup target.com` | Resume previous hunt |
| `/remember` | `/remember` | Log finding to memory |
| `/intel` | `/intel target.com` | Fetch CVE intel |
| `/autopilot` | `/autopilot target.com` | Autonomous hunt loop |
| `/surface` | `/surface target.com` | Ranked attack surface |
| `/web3-audit` | `/web3-audit contract.sol` | Smart contract audit |
| `/token-scan` | `/token-scan contract.sol` | Meme coin / token rug pull scan |

## Quick Start

```bash
/recon target.com    # Run recon
/hunt target.com    # Start hunting
/validate           # Validate finding
/report             # Generate report
```

## Model Selection

Each TUI uses its built-in authentication:
- **Claude Code**: Uses Claude Sonnet/Opus (built-in)
- **OpenCode**: Uses Go models by default (change in OpenCode settings)

## Installation

```bash
# Linux/macOS
chmod +x install.sh && ./install.sh

# Windows
python install.py
```

## Rules

1. READ FULL SCOPE before touching any asset
2. NEVER hunt theoretical bugs
3. Run validation gate BEFORE writing report
4. KILL weak findings fast
5. 5-minute rule — no progress = move on

## More Info

See CLAUDE.md for full documentation.