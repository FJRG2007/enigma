# @enigmax/helio

The **Helio** bug-bounty harness packaged as an optional **enigma pack**: skills, slash commands,
sub-agents, MCP servers and tooling for offensive security and bug bounty work.

Created in collaboration with the **Dymo Intelligence Team**.

This package ships only static assets. It is **not** a runtime dependency of enigma-cli and is
**not** installed by default. enigma-cli fetches it on demand when you enable the Helio pack and
deploys it into an **isolated agent context** - so these security skills never load into your
normal coding agent.

```bash
enigma pack install helio   # fetch the pack
enigma helio                # launch an agent with ONLY Helio's skills/commands/MCP
```

## Contents

`skills/`, `commands/`, `agents/`, `mcp/`, `tools/`, `rules/`, `hooks/`, `wordlists/`, `memory/`,
`web3/`.

The bundled copy is refreshed by the maintainer with `node scripts/sync-helio.mjs --commit <sha>`
from the enigma monorepo root.

## License

Apache-2.0. Created in collaboration with the Dymo Intelligence Team.
