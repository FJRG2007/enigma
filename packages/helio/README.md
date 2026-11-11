# @enigmax/helio

The **Helio** bug-bounty harness packaged as an optional **enigma agent**: skills, slash commands,
sub-agents, MCP servers and tooling for offensive security and bug bounty work.

Created in collaboration with the **Dymo Intelligence Team**.

This package ships only static assets. It is **not** a runtime dependency of enigma-cli and is
**not** installed by default. enigma-cli fetches it on demand when you enable the Helio agent and
deploys it into an **isolated agent context** - so these security skills never load into your
normal coding agent.

```bash
enigma agent install helio  # fetch the agent
enigma helio                # launch an agent with ONLY Helio's skills/commands/MCP
```

## Contents

`skills/`, `commands/`, `agents/`, `mcp/`, `tools/`, `rules/`, `hooks/`, `wordlists/`, `memory/`,
`web3/`.

`skills/security-audit/` is a separate vendor: Cloudflare's white-box codebase audit skill,
wired up through the `/audit` command and natural-language routing in `AGENTS.md`. It is
preserved across a Helio refresh and refreshed on its own schedule - see License below.

The bundled copy is refreshed by the maintainer with `node scripts/sync-helio.mjs --commit <sha>`
from the enigma monorepo root; `skills/security-audit/` and the three `audit.md` commands are
preserved across that refresh and refreshed independently with
`node scripts/sync-security-audit.mjs --commit <sha> --force`.

## License

Apache-2.0, created in collaboration with the Dymo Intelligence Team, except
`skills/security-audit/`, which is vendored from `cloudflare/security-audit-skill` under MIT
(see that directory's own `LICENSE` and `VENDOR.md`).
