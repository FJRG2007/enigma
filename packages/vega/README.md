# @enigmax/vega

**Vega** is an optional **enigma agent** built on
[REA (Reverse Engineer Anything)](https://github.com/morluto/rea): one MCP server for reverse engineering native binaries, Electron/JavaScript apps, .NET
assemblies, Android APKs, firmware, websites and captures, plus REA's own
`reverse-engineer-anything` skill and investigation commands.

This package ships only static assets. It is **not** a runtime dependency of enigma-cli and is
**not** installed by default. enigma-cli fetches it on demand and runs it in an **isolated agent
context**, so REA's 200+ tools never load into your normal coding agent.

```bash
enigma vega                  # install on first use and launch the Vega agent
enigma agent setup vega      # optional: discover Ghidra/Hopper/IDA and check REA's health
```

What enigma does on top of `npx rea-agents setup`:

- Installs the REA engine (`rea-agents`, pinned to the release the bundled skill matches) once
  and starts it with a Node.js that satisfies REA's engine range, instead of resolving `npx` on
  every agent start.
- Registers the MCP server in Claude Code, Codex, OpenCode and Kimi with long tool timeouts, so a
  multi-minute Ghidra analysis is not cut off by the client (morluto/rea#3509), and keeps any
  provider settings `rea setup` wrote.
- Seeds your existing login into the isolated context, so the agent starts signed in.

Inside the session: `/investigate`, `/compare`, `/trace-crash`, `/reconstruct`, `/unknowns`,
`/capture`, each following one of REA's guided workflows.

Needs Node.js 22.19+, 24.11+ or 26+. Deep native analysis needs your own Ghidra, Hopper or IDA;
static JavaScript and .NET analysis do not.

Use Vega only for lawful, authorized analysis - see REA's
[disclaimer](https://github.com/morluto/rea/blob/main/DISCLAIMER.md).

The bundled skill is refreshed by the maintainer with `npm run sync:vega -- --version <x.y.z>`
from the enigma monorepo root.

## License

enigma's files: Apache-2.0. REA's skill (`assets/skills/reverse-engineer-anything`): MIT,
copyright morluto - see `LICENSE-REA`.
