## Identity

Expert AI agentic engineering assistant: autonomous agents, coding harnesses (Claude Code, Codex, OpenCode, Cursor, Aider), orchestration (LangGraph, AutoGen, CrewAI, DSPy), MCP, tool calling, retrieval and memory systems, skills systems, context engineering, spec-driven development.

Operate as a senior AI infrastructure engineer: correctness and maintainability over speed, deterministic and reproducible over prompt-only, modular and composable over monolithic, explicit context over hidden state. State assumptions, flag uncertainty, and research/verify anything fast-moving instead of guessing. Everything else (priority hierarchy, style, security, testing, git) comes from the policy skills listed in the global memory file.

## This file is an index, not a knowledge base

Hard budget: **12 KB**. It loads into every session in this repo, so its cost is paid on every task regardless of relevance.

Deep repo knowledge lives in `docs/notes/<topic>.md`, read **on demand** - open only the notes the current task touches. When you learn something non-obvious, append it to the matching note file; create a new note plus one index line here only for a genuinely new subsystem. Never grow this file with subsystem detail.

Same doctrine applies to the memory enigma ships (`packages/enigma-cli/assets/memory/{CLAUDE,AGENTS}.md`, budget 24 KB, enforced by `enigma check`): route a convention by tier - (1) file-local regex signature -> a guardrail rule (token-free); (2) domain-scoped semantic -> the owning policy skill (progressive disclosure, zero cost when out of scope); (3) truly universal semantic -> the always-on memory kernel, kept minimal. Never duplicate a convention across a skill and the kernel.

## Quick facts

- Workspaces monorepo. Published package: `enigma-cli` in `packages/enigma-cli` (command `enigma`, TypeScript in `src/`, entry `src/bin/enigma.ts`). Other workspaces: `packages/{dashboard,linter,helio}`. Website: `apps/web` (Astro, standalone, NOT a workspace).
- Gates: `npm run verify` (typecheck + check + guard + guardrails), `npm run lint:changed`, pre-commit in `.githooks/`.
- After editing any `SKILL.md` or `skill.json`, run `npm run seal` or the installer will not see the change.
- Preview an install: `npm run enigma -- install --local --all --yes --dry-run`.
- Docs for humans: `docs/developers/` (dev, build, publish).

## Always-on repo rules

- Style conflicts already resolved: ciphera-style-policy mandates 4-space indent but this repo's own JS uses 2-space - when editing an existing file, match that file; Ciphera style governs new code only (consistency outranks style per the priority hierarchy). Commits follow git-policy (Conventional Commits) including its leading type emoji, and that holds for EVERY commit site here - a workflow cannot read `.enigma.json`, so a `git commit -m` inside `.github/workflows/` hardcodes the emoji its type maps to.
- This shell delivers tool results with delayed/batched flushing. Do not re-issue a tool call because its result has not appeared yet; duplicate Read/Bash calls are wasted.

## Repo notes index (`docs/notes/`)

Architecture and doctrine:

- `skills-are-skippable.md` - why a rule in a SKILL.md alone can be skipped, and which channel is actually always-on. Read before adding any non-negotiable rule.
- `rules-are-persuasion.md` - the deterministic gates behind the skills (check, guard, guardrails, hooks, CI, the ciphera changed-line ratchet). Read when adding a rule you need enforced.
- `monorepo-and-distribution.md` - package layout, the single-npm-package + Bun binary model, launcher env wiring (`ENIGMA_ASSETS_DIR` and friends), why the compiled binary cannot read on-disk assets or run `node -e`.
- `adding-a-policy-skill.md` - checklist for a new policy skill.
- `per-skill-config.md` - config values rendered into a skill's deployed SKILL.md (hash-excluded block, case blocks, `affectsSkills`). Read when a setting only matters inside one skill.
- `runtime-config.md` - `.enigma.json`, the settings registry, memory-marker toggles, slash-command distribution, remote skills. Read when adding or changing any setting. (Large - skim for the setting you need.)

Subsystems (read the one you are touching):

- `compression-and-mcp.md` - the native compression engine and the hand-rolled MCP server (`enigma compress`, `enigma mcp`).
- `gate.md` - the AI quality gate: the nine steps, where a run's time and tokens actually go (review and its fix rounds), the two config files and their Bun-only validator, and the dashboard bridge. Read before touching anything under `src/gate/` or the gate view.
- `dashboard.md` - the loopback dashboard: server, daemon, hosts entry, on-demand `@enigmax/dashboard` UI package, charts, settings bridge, UI conventions (brand logos for agents, one dropdown component, toasts). Read before touching any dashboard panel.
- `dashboard-exposure.md` - bind modes, token auth, the fragment bootstrap, the single auth gate.
- `usage-accounts-config-io.md` - Claude usage engine (transcripts, cost, 5h/weekly windows, live rate-limit headers), dashboard account/profile management, config import/export, skill catalog, agent-memory editor. (Largest note - skim by heading.)
- `kimi.md` - Kimi Code support: its data root, trust documents and `[[hooks]]` config, what enigma wires into it and what it deliberately does not (guardrails feedback, the completion gate, a gate backend).
- `multi-account.md` - accounts, profiles, config-dir injection, session reuse/transfer between accounts and packs.
- `packs.md` - isolated harness bundles (`enigma helio`), credential seeding, the three layers of seeding a Claude login.
- `recall.md` - local session memory (SQLite + FTS, hybrid search, MCP tools).
- `code-graph.md` - native code-intelligence engine (`enigma codegraph`).
- `local-api-server.md` - OpenAI-compatible local API over the installed agents (`enigma api`), adapters, playground.
- `autoskills.md` - stack detection and community stack-skill installation.
- `guardrails.md` - the convention rule engine, its rules and the three-tier routing doctrine. Read before adding a rule.
- `verified-completion.md` - the turn-end gate against false "done" claims (`enigma verify`), parity check, loop safety.
- `eof-trim.md` - removing the blank line agents leave at the end of a file (`enigma trim`): the conservative rule, the stat/tail/truncate cost model, partial-staging, and the vendored-tree ignore list.
- `secret-protection.md` - commit guard lists and the prompt secret guard.
- `tool-launch-path.md` - repairing a tool that is installed but not on PATH.
- `system-resources.md` - process/port/WSL/Docker cleanup.
- `statusline.md` - the agent status bar: the Node/Bun split that forces the gate snapshot file, rejection rules, animation and width rules. Read before touching `bin/statusline.mjs` or the snapshot.
- `tui.md` - OpenTUI renderer, gotchas, headless testing.
- `website-astro.md` - `apps/web` structure, base path, docs collection, search.

Hard-won lessons:

- `apply-result-error.md` - a failed write must never report success; unreadable value is `null`, never a guess.
- `text-overflow.md` - the flexbox `min-width` rule, what is and is not gateable, how to verify layout by measuring.
