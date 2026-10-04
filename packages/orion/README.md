# @enigmax/orion

Orion is an optional enigma pack that hunts what looks finished but is not: flows that break
on the second step, pages that load slowly, queries that grow with the table, limits that only
show up at scale, and searches that never say "no results". Every finding comes with proof - a
trace, a number, or an input that fails - gathered in a real browser through the Chrome
DevTools MCP server.

This package ships only static assets. It is **not** a runtime dependency of enigma-cli and is
**not** installed by default. enigma-cli fetches it on demand when you enable the pack and
deploys it into an **isolated agent context**, so these skills never load into your normal
coding agent.

```bash
enigma pack install orion   # fetch the pack
enigma orion                # launch an agent with only Orion's skills, commands and browser
```

Inside the session: `/sweep` (everything), `/flow` (one user flow end to end), `/perf`
(load and runtime speed), `/scale` (what breaks as data and traffic grow).

Needs Chrome and Node on the machine. The browser runs an isolated profile, never your own
logins.

## License

Apache-2.0.
