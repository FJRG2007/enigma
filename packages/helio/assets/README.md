<p align="center">
  <img src="docs/images/logo.png" alt="Helio" width="320"/>
</p>

<div align="center">

<img src="https://img.shields.io/badge/v3.0.0-Bionic_Hunter-blueviolet?style=for-the-badge" alt="v3.0.0">

# Helio

### The AI-Powered Agent Harness for Professional Bug Bounty Hunting

*Your AI copilot that sees live traffic, remembers past hunts, and hunts autonomously.*

[![Python 3.8+](https://img.shields.io/badge/Python-3.8+-3776AB.svg?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![Tests](https://img.shields.io/badge/Tests-129_passing-brightgreen.svg?style=flat-square)](tests/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97706.svg?style=flat-square&logo=anthropic&logoColor=white)](https://claude.ai/claude-code)
[![Claude Code](https://img.shields.io/badge/OpenCode-Plugin-D97706.svg?style=flat-square&logo=opencode&logoColor=white)](https://opencode.ai/)

<br>

<a href="#-quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-how-it-works">How It Works</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-commands">Commands</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-whats-new-in-v300">What's New</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-installation">Install</a>

<br>

TUI-agnostic bug bounty framework for Claude Code, OpenCode, Qwen Code, and OpenClaw.

</div>

## What's Helio?

A bug bounty framework that works across different terminal AI tools:
- **Claude Code** — Uses built-in Anthropic models
- **OpenCode** — Uses Go ($10/mo) or Zen (pay-per-token) models
- **Qwen Code** — Uses DashScope or OpenAI-compatible models
- **OpenClaw** — Future support

## Installation

### Linux/macOS

```bash
# Download or clone
git clone https://github.com/TPEOficial/helio.git
cd helio

# Run installer
chmod +x install.sh
./install.sh
```

### Windows

```bash
python install.py
```

The installer will:
1. Install dependencies (python3, git)
2. Install commands for Claude Code → `~/.claude/commands/`
3. Install commands for OpenCode → `~/.config/opencode/commands/`
4. Install commands for Qwen Code → `~/.qwen/commands/`
5. Create OpenCode config

## Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/helio` | `/helio` | Show help |
| `/recon` | `/recon target.com` | Full recon |
| `/hunt` | `/hunt target.com` | Start hunting |
| `/validate` | `/validate` | 7-Question Gate |
| `/report` | `/report` | Generate report |
| `/chain` | `/chain` | Build exploit chains |
| `/scope` | `/scope asset` | Check scope |
| `/triage` | `/triage` | Quick triage |
| `/pickup` | `/pickup target.com` | Resume hunt |
| `/remember` | `/remember` | Log finding |
| `/intel` | `/intel target.com` | CVE intel |
| `/autopilot` | `/autopilot target.com` | Autonomous loop |
| `/surface` | `/surface target.com` | Attack surface |
| `/web3-audit` | `/web3-audit contract.sol` | Smart contract audit |
| `/token-scan` | `/token-scan contract.sol` | Meme coin / token rug pull scan |

## Quick Start

```bash
/helio              # See all commands
/recon target.com   # Run recon
/hunt target.com    # Start hunting
/validate           # Validate finding
/report             # Generate report
```

## TUI Compatibility

| TUI | Commands Location | Models |
|-----|------------------|--------|
| Claude Code | `~/.claude/commands/` | Built-in (Sonnet, Opus) |
| OpenCode | `~/.config/opencode/commands/` | Go/Zen (user select) |
| Qwen Code | `~/.qwen/commands/` | DashScope (Qwen, DeepSeek) |

## Updating

```bash
# Pull latest
git pull origin main

# Re-run installer
./install.sh
```

## Rules

1. **READ FULL SCOPE** before touching any asset
2. **NEVER hunt theoretical bugs** — must be reproducible
3. **Run validation gate** BEFORE writing report
4. **KILL weak findings fast** — don't waste time
5. **5-minute rule** — no progress = move on

## Directory Structure

```
helio/
├── tui.py              # TUI detection
├── brain.py            # LLM reasoning
├── CLAUDE.md           # Full documentation
├── README.md           # This file
├── install.sh          # Linux/macOS installer
├── install.py          # Windows installer
├── commands/
│   ├── claude-code/   # Claude Code commands
│   └── opencode/      # OpenCode commands
├── memory/            # Hunt journal + patterns
├── tools/              # scope_checker, validate, token_scanner
├── rules/              # Hunting rules
└── hooks/             # Session hooks
```

## Troubleshooting

### Commands not found?
Re-run installer:
```bash
./install.sh
```

### Invalid config?
Backup and recreate:
```bash
mv ~/.config/opencode/opencode.jsonc ~/.config/opencode/opencode.jsonc.bak
./install.sh
```