# Helio — Multi-TUI Bug Bounty Framework

TUI-agnostic bug bounty and VAPT framework supporting Claude Code, OpenCode, and OpenClaw.

## What's Here

### Supported TUIs

| TUI | Status | Commands |
|-----|--------|----------|
| Claude Code | Full support | `/recon`, `/hunt`, etc. |
| OpenCode | Full support | `/recon`, `/hunt`, etc. + model selection |
| OpenClaw | Future support | `/recon`, `/hunt`, etc. |

### Core Modules

- `tui.py` — TUI detection and routing
- `brain.py` — Multi-provider LLM reasoning (Ollama, Claude, OpenAI, Grok)

### Skills (load per engagement type)

#### Bug Bounty
- `skills/bug-bounty/` — master workflow, all phases
- `skills/bb-methodology/` — hunting mindset + 5-phase non-linear workflow
- `skills/web2-recon/` — subdomain enum, live host discovery, URL crawl, nuclei
- `skills/web2-vuln-classes/` — 22 bug classes with bypass tables (incl. deserialization + prototype pollution)
- `skills/security-arsenal/` — payloads, bypass tables, never-submit list
- `skills/report-writing/` — H1/Bugcrowd/Intigriti/Immunefi templates, CVSS 4.0
- `skills/triage-validation/` — 7-Question Gate, 4 gates, auto-kill list

#### Web3
- `skills/web3-audit/` — 10 smart contract bug classes, Foundry PoC template
- `skills/meme-coin-audit/` — rug pull detection, token authority checks

#### VAPT / Red Team
- `skills/opsec/` — scan rates, user-agent rotation, evidence handling, detection awareness
- `skills/post-exploit/` — privesc (Windows/Linux), credential access, lateral movement
- `skills/ad-attacks/` — BloodHound, Kerberoasting, ADCS ESC1-ESC8, DCSync, Golden Ticket
- `skills/cloud-exploit/` — AWS IAM privesc (21 primitives), IMDS pivot, K8s escape, S3, Azure

### Tools

- `tools/scope_checker.py` — Deterministic scope validation
- `tools/validate.py` — 7-Question Gate + Adversarial Skeptic + CVSS 4.0 calculator

### Rules

- `rules/hunting.md` — 29 always-active hunting rules (incl. false positive exclusions, reachability/exploitability classification, framework-aware FP filters, confidence scoring, hard scope lock, MCP browser policy, OSS production verification)
- `rules/reporting.md` — Reporting standards (STRIDE/CWE table, structured PoC format, reachability + exploitability labels)
- `rules/source-audit.md` — White-box source code audit methodology (trust boundaries, cross-file analysis, security checklist, calibration examples)

### AI Knowledge Docs

Extended reference material the AI should use during hunts. Located in `docs/ai-docs/`:

- `docs/ai-docs/advanced-techniques.md` — Advanced techniques: A→B cluster hunting, framework-specific playbooks (Next.js, Rails, Django, GraphQL, OAuth, race conditions, HTTP smuggling, cache poisoning, LLM/agentic attacks)
- `docs/ai-docs/smart-contract-audit.md` — Smart contract audit guide: target evaluation, attack surface mindmap by protocol type, OWASP SC Top 10, new 2024-2025 bug classes, Foundry PoC templates, Immunefi rules and report format, tools reference

> **Note:** `docs/helio-development/` and `docs/images/` are internal dev docs — ignore them.

### Memory

- `memory/hunt_journal.py` — Session and finding tracking
- `memory/pattern_db.py` — Cross-target pattern learning

### Commands

#### Bug Bounty

| Command | Usage | Description |
|---------|-------|-------------|
| `/recon` | `/recon target.com` | Full recon pipeline |
| `/hunt` | `/hunt target.com` | Start vulnerability hunting |
| `/validate` | `/validate` | Run validation gate |
| `/report` | `/report` | Generate report |
| `/chain` | `/chain` | Build exploit chains |
| `/scope` | `/scope asset` | Check scope |
| `/triage` | `/triage` | Quick triage |
| `/pickup` | `/pickup target.com` | Resume previous hunt |
| `/remember` | `/remember` | Log finding |
| `/intel` | `/intel target.com` | Fetch intel |
| `/autopilot` | `/autopilot target.com` | Autonomous hunt loop |
| `/surface` | `/surface target.com` | Ranked attack surface |
| `/web3-audit` | `/web3-audit contract.sol` | Smart contract audit |
| `/token-scan` | `/token-scan contract.sol` | Meme coin / token rug pull scan |

#### VAPT / Red Team

| Command | Usage | Description |
|---------|-------|-------------|
| `/roe` | `/roe` | Create Rules of Engagement document |
| `/opplan` | `/opplan new\|status\|update` | Engagement objective planning and tracking |
| `/postexploit` | `/postexploit [--os windows\|linux]` | Post-exploitation after initial foothold |
| `/vaccine` | `/vaccine [finding-file]` | Attack → fix → verify loop |
| `/ad-attack` | `/ad-attack [--domain DOMAIN --dc IP]` | AD kill chain: BloodHound → Kerberoast → ADCS → DCSync |

**Note:** `/pickup` replaces `/resume` and `/continue` to avoid conflicts with Claude Code's native commands.

## Quick Start

```bash
# Linux/macOS
chmod +x install.sh && ./install.sh

# Or use Python installer
python install.py

# Run in any TUI
/recon target.com
/hunt target.com
/validate
/pickup target.com
```

## Installation

### Linux/macOS
```bash
chmod +x install.sh && ./install.sh
```

This will:
1. Install dependencies (python3, git)
2. Create ~/.helio/ directory
3. Link commands to OpenCode global commands
4. Create ~/.config/opencode/opencode.jsonc with all commands
5. Create environment template

### Windows
```bash
python install.py
```

## Model Support

### How It Works

The framework auto-detects your TUI and uses its built-in authentication:

| TUI | Authentication | Default Model |
|-----|---------------|---------------|
| **Claude Code** | Built-in | Claude Sonnet 4 |
| **OpenCode** | Built-in (Go/Zen) | MiniMax M2.5 (Go) |
| **OpenClaw** | Future | TBD |
| **Fallback** | Ollama local | qwen3:8b |

### OpenCode Plans

| Plan | Models | Cost | Requests/month |
|------|--------|------|----------------|
| **Go** | GLM-5, Kimi K2.5, MiniMax M2.5/2.7 | $10/mo | ~100k |
| **Zen** | Claude, GPT, Gemini + 30+ | Pay-per-token | Unlimited |

### Available Models

```yaml
# Free (Ollama local)
model: qwen3:8b
model: deepseek-r1:14b
model: mistral:7b

# OpenCode Go ($10/mo)
model: glm-5
model: kimi-k2.5
model: minimax-m2.5

# OpenCode Zen (pay-per-token)
model: anthropic/claude-3-5-sonnet-20241022
model: openai/gpt-4o
model: google/gemini-2.0-flash

# BYOK (bring your own key)
model: ollama/qwen3:8b
model: openai/gpt-4o
model: anthropic/claude-opus-4-6
```

### Per-Command Model Override

Each command can specify a model in frontmatter:

```yaml
---
description: Run full recon pipeline
model: qwen3:8b
---
```

Or via opencode.jsonc:

```jsonc
{
  "command": {
    "recon": {
      "model": "kimi-k2.5"
    },
    "hunt": {
      "model": "minimax-m2.5"
    }
  }
}
```

## Configuration

### Environment Variables

```bash
export BRAIN_PROVIDER=ollama  # or claude, openai, grok
export OLLAMA_HOST=http://localhost:11434
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export XAI_API_KEY=...
```

### Model Selection per Command (OpenCode)

Each command file supports the `model` frontmatter option to specify which model to use:

```yaml
---
description: Run full recon pipeline
model: qwen3:8b
---
```

Supported model formats:
- Ollama: `qwen3:8b`, `deepseek-r1:14b`, etc.
- Claude: `anthropic/claude-3-5-sonnet-20241022`
- OpenAI: `openai/gpt-4o`

## Directory Structure

```
helio/
├── CLAUDE.md           # This file
├── tui.py              # TUI detection
├── brain.py            # LLM reasoning
├── config.example.json # Config template
├── install.py          # Installer
├── commands/           # Command definitions (*.md)
├── rules/              # Hunting rules
├── memory/             # Hunt memory
│   ├── hunt_journal.py
│   ├── pattern_db.py
│   └── targets/        # Target profiles
├── tools/              # Tools
│   ├── scope_checker.py
│   ├── validate.py
│   └── token_scanner.py
└── hooks/              # Session hooks
```

## TUI Detection

```python
from tui import detect_tui, get_command_prefix, is_native_command

tui = detect_tui()
print(tui.name)  # Claude Code, OpenCode, or OpenClaw
```

## Natural Language Invocation (No Slash Command Required)

Most users do NOT invoke slash commands manually. When a user says anything like:

- "find bugs in target.com"
- "audit this program"
- "here's a HackerOne program, look for vulns"
- "I think I found a bug in X, what do you think?"
- "write a report for this finding"
- "is this exploitable?"

...the same pipeline and rules apply as if they had typed `/hunt`, `/validate`, and `/report` explicitly. The slash commands are entry points — the rules are NOT optional just because the user didn't type the command name.

**When asked to hunt / find bugs / audit:**
1. Lock scope first (ask the user for the program page if not provided)
2. Follow the hunt pipeline from `commands/hunt.md`
3. Before sharing ANY finding with the user, run the validation gate internally (see "Before Sharing Any Finding" below)
4. Never present a lead as a confirmed bug until it passes validation

**When asked to write a report / submit a bug:**
1. If the finding has not been validated yet, validate it first — silently if the user didn't ask for it
2. Run the rejection prevention checklist from `commands/report.md`
3. Block report writing if Impact Gate fails (CVSS < 4.0 and no chain)

**When a user shares a finding and asks "is this valid?" / "can I report this?":**
1. Run the full 7-Question Gate from `agents/validator.md`
2. Output PASS / KILL / DOWNGRADE / CHAIN REQUIRED with reason and rejection category
3. Do not encourage submission if any gate fails

## Before Sharing Any Finding With the User

**This applies in ALL modes: slash command, autopilot, conversational, natural language.**

Before you present any vulnerability finding to the user (in any format — even casually mentioning "I found an issue"), it must pass this internal gate:

```
MANDATORY INTERNAL CHECK (run silently before every finding mention):

[ ] Have actual HTTP request + response proving it (not code reading alone)
    EXCEPTION: OSS target + code path traced + version confirmed deployed passively
[ ] Reachability classified: EXTERNAL / AUTHENTICATED / INTERNAL / UNREACHABLE
    If UNREACHABLE → do not mention it. Kill silently.
[ ] Exploitability: EASY / MEDIUM / HARD
[ ] Confidence >= 70 (0-100 scale)
    If < 70 → do not mention it. Investigate more or kill.
[ ] Not on the false-positive auto-kill list (see rules/hunting.md Rule 21)
[ ] Not a framework false positive (ORM, template escaping, middleware)
[ ] Not vuln-dependent: reaching it does NOT require first exploiting a separate vulnerability
    If it does → it is only valid as part of a confirmed end-to-end chain. Do not present as standalone.
[ ] Impact >= CVSS 4.0, OR confirmed step in a chain that reaches 4.0
    If neither → do not mention it as a finding. Kill silently.
```

If ANY check fails → do not present it to the user as a finding. Say "investigating..." or move on silently. Do not present weak leads as bugs.

**The 5 platform rejection reasons — prevent each before ever mentioning a finding:**

- NOT REPRODUCIBLE: have exact copy-pasteable HTTP request, reproduced 2+ times
- INFORMATIONAL: CVSS >= 4.0 or confirmed chain step
- OUT OF SCOPE: asset verified on program scope page, not third-party
- SPAM/DUPLICATE: not already disclosed or in changelog
- INVALID: not a framework FP, not documented behavior, adversarial skeptic passed

## Rules

Always active:
1. READ FULL SCOPE before touching any asset — write down the exact in-scope list
2. HARD SCOPE LOCK — if an asset is not explicitly in scope, it does not exist for this hunt
3. NEVER hunt theoretical bugs
4. NEVER report informational or standalone low-impact findings (CVSS < 4.0 unless part of a chain)
5. Run validation gate BEFORE writing report — even if user didn't ask for it
6. KILL weak findings fast — do not share leads that have not passed the internal gate
7. 5-minute rule -- no progress = move on
8. MCP browser tools only for interactive flows (account creation, OAuth, CAPTCHA) — use curl/fetch for everything else
9. NEVER present a finding without a working PoC (or OSS code-path + passive version confirmation)
10. NEVER use theoretical language in any finding description: no "could potentially", "may allow", "might be possible"
11. NEVER report a vulnerability whose only entry point requires first exploiting a DIFFERENT vulnerability — that is a chain, not a standalone finding. Report the full confirmed chain as ONE submission or don't report it at all.

## Report and PoC Style (always active, regardless of how a report is requested)

These rules apply every time you write a report or a PoC -- whether via /report, /autopilot, or a plain conversation request like "write me a report for this bug".

Character rules -- ASCII only, no exceptions:
- Use -> not -> (unicode arrow)
- Use -> not → and => not ⇒ and <- not ←
- Use -- not — (em-dash)
- Use ... not … (ellipsis)
- Use ---- not ──── or ═══ or any box-drawing character
- No emojis anywhere: not in prose, not in titles, not in code comments
- No unicode characters that a developer would not type directly from a standard keyboard

Writing style:
- No horizontal rules (--- or ***) as visual decorators or section separators
- No AI filler: "it's worth noting", "in conclusion", "to summarize", "I hope this helps", "as mentioned above"
- Summary and impact sections are prose, not bullet lists
- One header level max for a single-bug report
- Active voice, short sentences, impact first

PoC:
- Every report includes a working PoC -- no exceptions
- For automated flows (autopilot, hunt), derive PoC from captured request/response data