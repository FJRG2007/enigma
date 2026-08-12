# Kimi Code support

Kimi Code CLI (Moonshot AI, `kimi`) is the fourth supported agent. This note records what its
surfaces actually are, why each piece of enigma is wired the way it is, and what deliberately is
not wired. Facts here come from the official docs (`MoonshotAI/kimi-code`, `docs/en/`) or from the
shipped client itself; anything read off the client names the version it was read from.

## The client

- Node/native CLI, installed as a single binary. On this machine the installer put it at
  `~/.kimi-code/bin/kimi.exe` and did NOT put it on PATH - which is why `tool-path.ts` has
  `~/.kimi-code/bin` in its candidate dirs. Also distributed as `@moonshot-ai/kimi-code` on npm.
- Predecessor: the Python `kimi-cli` under `~/.kimi`. Different product, different data root;
  enigma detects `~/.kimi-code` only.

## Data root

Everything lives under `~/.kimi-code`, relocatable with `KIMI_CODE_HOME` - config, credentials,
sessions, logs, the global `AGENTS.md` and the Kimi-specific skills dir all move with it. That one
variable is what makes multi-account work exactly like Claude's `CLAUDE_CONFIG_DIR`.

| What | Where |
| --- | --- |
| Runtime config | `config.toml` (TOML, snake_case) |
| TUI prefs | `tui.toml` (theme, editor, notifications, `[status_line]`) |
| Global instructions | `AGENTS.md` (project scope: `<root>/AGENTS.md`, which `/init` writes) |
| MCP servers | `mcp.json` (project scope: `<root>/.kimi-code/mcp.json`) |
| User skills | `skills/` (project: `.kimi-code/skills/`), plus the shared `~/.agents/skills` |
| Sub-agents | `agents/` (project: `.kimi-code/agents/`), plus `~/.agents/agents` |
| Credentials | `credentials/<provider>.json`, `credentials/mcp/` |
| Sessions | `sessions/<workDirKey>/<sessionId>/`, index `session_index.jsonl` |
| Workspace trust | `workspace-trust/<workDirKey>` |
| Plugins | `plugins/installed.json`, `plugins/managed/<id>/` |

Project-local `.kimi-code/local.toml` holds `[workspace] additional_dir` only - there is no
project-local permission mode or hook list, which is why the bypass is global-only for Kimi
(`BYPASS_GLOBAL_ONLY` in permissions.ts).

## What enigma wires

- **Skills + memory** (`agents.ts`): skills to `~/.kimi-code/skills` and `.kimi-code/skills`,
  memory to `~/.kimi-code/AGENTS.md` and `<project>/AGENTS.md`. Kimi also scans the shared
  `~/.agents/skills` that codex uses, but deploying there would put two agents in one directory
  and make the per-agent skill opt-out (`skillAgentsOff`) flip-flop between them on every sync.
  Kimi-specific dirs also move with `KIMI_CODE_HOME`, so an account gets its own skills.
- **Commands**: none. Kimi has no user-level command directory - custom slash commands only ship
  inside an installed plugin (`/plugins install`, recorded in an undocumented `installed.json`).
  The deployed skills cover it: an external skill is registered as `/skill:<name>`.
- **MCP** (`mcp-deploy.ts`): `mcpServers.enigma` in `mcp.json`, stdio inferred from `command`.
  Nothing outside Kimi's documented per-server schema is written - an unknown field fails the
  whole config load.
- **Accounts** (`accounts.ts`): `KIMI_CODE_HOME` per account; `kimi login` for the device-code
  flow; the identity shown is the set of provider names under `credentials/` (the token file's
  shape is undocumented, so no field is read out of it).
- **Permission bypass** (`permissions.ts`): `default_permission_mode = "yolo"` in `config.toml`.
  `yolo` rather than `auto` on purpose - `auto` also stops the agent asking the user questions,
  which is a behavior change beyond skipping approvals.
- **Workspace trust** (`kimi.ts`): Kimi asks "Trust this folder?" and refuses project MCP servers
  until answered. Trust is a document at `workspace-trust/<workDirKey>` whose presence is the
  whole answer. Unlike Claude, trust is NOT inherited from parent directories, so there is no
  blanket entry: enigma writes the document for the directory being opened, on every launch and
  sync. `encodeWorkDirKey` is a port of the client's own `workdir-slug.ts` (kimi 0.35.0) and the
  test pins it against a key Kimi itself wrote - a document under any other name is one Kimi
  never reads, which would be a pre-answer that silently does nothing.
- **Hooks** (`trim-deploy.ts`, `lint.ts` via `kimi-hooks.ts`): `[[hooks]]` entries in
  `config.toml` with `event`/`matcher`/`command`/`timeout` (those four only). The EOF trimmer and
  the auto-lint fixer run on `PostToolUse` with matcher `Write|Edit`.
- **Local API** (`api-agents.ts`): `kimi -p <prompt> --output-format stream-json`, with `-m` and
  `--session`. The line schema is OpenAI-shaped (`role: assistant|tool|meta`); the session id
  arrives in the `session.resume_hint` meta line written at the end of a run. Flags and schema
  were read off the shipped client's print writer, not guessed, but the adapter has not been run
  end to end.

## What is NOT wired, and why

- **Guardrails feedback**. Kimi's `PostToolUse` is observation-only ("fire and forget; the main
  flow is unaffected regardless of what the script returns"), so findings would reach nothing, and
  the only blockable per-tool event (`PreToolUse`) fires before the write, when the file on disk is
  still the old one. Trim and auto-lint are wired because their value is the side effect, not the
  feedback. The same limit means auto-lint's leftover findings are silent on Kimi.
- **The completion gate (`enigma verify`)**. `Stop` IS blockable on Kimi (exit 2, stderr becomes
  the reason), but the documented Stop payload carries no final assistant message and no transcript
  path, and `runVerifyHook` needs one of them. Wiring it would print "the check did not run" at
  every turn end. Revisit if Kimi documents either field.
- **A gate backend**. `kimi -p` takes the prompt only through argv - there is no stdin form - and a
  gate step's prompt (instructions plus a diff) exceeds the OS argv budget. The documented
  `kimi web` REST/WebSocket server is the path to a real backend, in the shape of the opencode one.
- **Usage reading**. `sessions/.../agents/main/wire.jsonl` is the per-session record, but its
  schema is undocumented, so no token figures are read from it. Kimi is reported as "no local
  token-usage store" rather than faked, like Codex and OpenCode.
- **Recall ingestion**. Same reason: recall reads transcripts, and this one has no documented
  record shape.

## Gotchas

- `--prompt` cannot be combined with `--yolo`, `--auto` or `--plan`; print mode already runs under
  the `auto` permission policy, and static deny rules still apply.
- `[[hooks]]` rejects any field outside the four allowed ones, and a rejected field fails the
  whole `config.toml` load - so the writer in `kimi-hooks.ts` emits nothing else.
- Kimi reads Claude's project `.mcp.json` too, alongside its own `.kimi-code/mcp.json`.
- Like Codex with `CODEX_HOME`, enigma deploys to the default `~/.kimi-code` and does not follow an
  ambient `KIMI_CODE_HOME` set in the user's shell.
