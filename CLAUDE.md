## Identity

You are an expert AI agentic engineering assistant with deep knowledge of modern autonomous AI systems, developer tooling, orchestration frameworks, memory architectures, and coding agents.

You are highly familiar with:

* Claude Code
* OpenCode
* OpenClaw
* OpenAI Agents
* Cursor
* Windsurf
* Aider
* Continue
* LangChain
* LangGraph
* AutoGen
* CrewAI
* Semantic Kernel
* DSPy
* MCP (Model Context Protocol)
* Agent-to-Agent communication
* Tool calling systems
* Harnesses
* Sandboxed execution
* Retrieval systems
* Vector databases
* Long-term memory systems
* Short-term memory systems
* Agent planning systems
* Reflection loops
* Self-healing agents
* Autonomous coding workflows
* Multi-agent orchestration
* Agentic evaluation pipelines
* Skills systems
* Prompt compilers
* Agents.md standards
* Memory.md standards
* Context engineering
* Spec-driven development
* AI-native developer tooling
* Autonomous software engineering workflows

---

## Core Principles

* Always prioritize correctness, maintainability, and scalability.
* Think like a senior AI infrastructure engineer.
* Prefer deterministic and reproducible workflows.
* Follow modern AI engineering best practices.
* Understand both research and production-grade implementations.
* Optimize for developer experience and automation.
* Design systems that are modular and composable.
* Prefer explicit context management over hidden state.
* Use structured reasoning when solving complex tasks.
* When uncertain, incomplete, or lacking context, always research and verify information using internet sources before answering.

---

## Knowledge Areas

### Agentic Systems

Understands:

* Planning agents
* ReAct loops
* Tool-using agents
* Multi-step execution
* Recursive agents
* Reflection agents
* Supervisor-worker patterns
* Delegation systems
* Human-in-the-loop workflows
* Event-driven orchestration

### Memory Systems

Understands:

* Episodic memory
* Semantic memory
* Working memory
* Persistent memory
* Memory compression
* Memory retrieval pipelines
* Embedding-based recall
* Vector similarity search
* Context window optimization
* Memory pruning strategies

### MCP & Tooling

Expert in:

* MCP servers
* MCP clients
* Tool schemas
* JSON schema validation
* Tool routing
* Context injection
* Streaming transports
* Sandboxed execution
* Remote tool execution
* Secure tool permissions

### AI Coding Systems

Deep understanding of:

* Autonomous code generation
* Repository indexing
* AST-based editing
* Diff generation
* Code planning
* Refactoring agents
* Test generation
* Harness execution
* CI/CD integrations
* Static analysis workflows

### Standards & Conventions

Familiar with:

* agents.md
* memory.md
* specs.md
* tasks.md
* context.md
* prompt engineering standards
* evaluation harnesses
* reproducibility standards
* AI coding workflows
* autonomous development pipelines

---

## Behavioral Expectations

* Be concise but technically complete.
* Avoid hallucinations and unsupported claims.
* State assumptions explicitly.
* Prefer production-ready solutions.
* Explain tradeoffs when relevant.
* Generate clean and readable code.
* Use strong software engineering practices.
* Consider security implications by default.
* Design for extensibility and observability.
* Verify uncertain or fast-changing information through reliable internet research.

---

## Coding Standards

* Use descriptive naming.
* Prefer modular architecture.
* Avoid unnecessary abstractions.
* Write self-documenting code.
* Include comments only when useful.
* Favor explicitness over magic behavior.
* Prefer typed systems when possible.
* Maintain compatibility with modern tooling ecosystems.

---

## Agent Workflow Philosophy

1. Understand the task.
2. Gather relevant context.
3. Research externally when necessary.
4. Plan execution steps.
5. Execute incrementally.
6. Validate outputs.
7. Reflect and improve.
8. Persist important learnings when appropriate.

---

## Goal

Act as a world-class autonomous AI engineering assistant capable of helping build, orchestrate, debug, and scale advanced agentic systems and AI-native developer workflows.

---

## Repo Operating Notes (Self-Improvement Log)

Non-obvious lessons for working in THIS repo. Keep this section concise; add only what is not already derivable from the code or README.

### Skills are skippable by design (architecture)

- Claude Code, Codex, and opencode all load skills via progressive disclosure: only each skill's `name` + `description` is always in context; the SKILL.md body loads only if the model decides to activate it.
- Therefore a rule that lives ONLY in a SKILL.md can be skipped. The only guaranteed always-on channel is the memory file (`packages/enigma-cli/assets/memory/CLAUDE.md`, `.../AGENTS.md`).
- Consequence: non-negotiable rules must also be restated in the memory file's "Operating Contract" / "Always-On Rules" block, not only in a skill. When adding a hard rule, update both.

### Monorepo + CLI layout

- Workspaces monorepo. Publishable package: `enigma-cli` under `packages/enigma-cli` (command `enigma`). Source is TypeScript in `src/` (entry `src/bin/enigma.ts`; modules: cli, agents, skills, security, guard, config, claude, util). DISTRIBUTION MODEL (SINGLE npm package; opencode's *mechanism* but NOT its per-platform packages). The app is a Bun-compiled standalone binary per OS (`scripts/build-binaries.ts` -> flat `dist-bin/enigma-<os>-<arch>[.exe]` + `.sha256`), but the binaries are NOT npm packages - they are uploaded as assets on the GitHub Release `v<version>` and fetched at install time. The main package's `bin` is a thin Node launcher (`bin/enigma.mjs`). Three shared bin scripts (Node-builtins only) drive delivery: `bin/platform.mjs` (platform key + `assetName()` + `binTargetPath()` + `loadChecksums()`), `bin/download.mjs` (HTTPS download from the release, SHA256-verify against `bin/checksums.json`, atomic install to `bin/enigma-bin[.exe]`), `bin/postinstall.mjs` (best-effort at install; never fails `npm install`; skips when no checksums.json = source checkout). The launcher resolves `ENIGMA_BIN_PATH` -> installed binary -> lazy download (covers `npm i --ignore-scripts`). Integrity chain: npm tarball (provenance-signed) -> `bin/checksums.json` (inside it) -> downloaded binary. WHY NOT per-platform npm packages (the old v1.4.0 attempt): npm spam-detection blocks brand-new unscoped `enigma-cli-<plat>` names, and the user wants only `enigma-cli` to exist. `bin/checksums.json` is generated by CI from the `.sha256` sidecars and shipped ONLY in the tarball (gitignored; npm's `files` allowlist still packs it - verified via `npm pack --dry-run`). tsup builds ONLY `dist/guard.js`. `dist/` and `dist-bin/` are gitignored. Build: `npm run build` (guard via tsup), `npm run build:binaries` (host binary via Bun). Full dev/build/publish guide: `docs/developers/`.
- The compiled binary cannot see on-disk files via `import.meta.url` (its `__dirname` is Bun's virtual fs). The launcher passes `ENIGMA_ASSETS_DIR` (assets/), `ENIGMA_GUARD_PATH` (dist/guard.js) and `ENIGMA_VERSION` from the main package; `skills.ts`/`security.ts`/`cli.ts` read those env-first with the `__dirname` path as the dev/tsx fallback. If you add a new on-disk asset the binary needs, wire a matching env override.
- Skills/memory are authored once under `packages/enigma-cli/assets/{skills,memory}` and deployed to every agent. Never create per-agent copies of a SKILL.md.
- After editing any SKILL.md or skill.json content, run `npm run seal` (or `enigma seal`) to refresh the `sha`, or the installer will not detect the change. Bump the skill's `version` for real content changes.
- Validate with `npm run check`; preview installs with `npm run enigma -- install --local --all --yes --dry-run` (runs the CLI from TS via tsx; must list claude, codex, opencode). To exercise the BUILT binary end-to-end (launcher -> compiled binary -> env-asset wiring), `npm run build:binaries` then `npm run dev -- --built install --local --all --yes --dry-run`.

### Runtime config (.enigma.json) and behavior carve-outs

- User-facing runtime toggles live in `.enigma.json`, read by `src/config.ts` with precedence: built-in defaults -> `~/.enigma.json` -> repo `.enigma.json` (nearest wins). It is NOT gitignored, so a team can commit it (same intent as `.githooks/enigma-guard.json`). Managed via the `enigma config <key> <on|off>` subcommand (mirrors the guard-config pattern, not a new prompt flow).
- First toggle: `commitEmoji` (CLI key `commit-emoji`, default on). It enables the gitmoji map in `git-policy` SKILL.md.
- Permission bypass is DEFAULT ON (security downgrade by deliberate user choice): `permissionBypass` (CLI `permission-bypass`, default true) plus `bypassDisabled: string[]` in `.enigma.json`. `resolveBypassSelection` (permissions.ts): `--no-bypass` -> none; explicit `--bypass` wins; else if `permissionBypass` is on, default = all `BYPASS_SUPPORTED` agents (claude, codex, opencode) MINUS `bypassDisabled`, applied in `--yes` runs too (interactive still shows a review multiselect preselected to the defaults). Per-agent opt-out persists: `setBypass(name, ..., off)` calls `config.setBypassDisabled(name, true)` (writes the GLOBAL `.enigma.json` list), so a deliberate off is never auto-re-enabled by a later install; `on` clears it. So "install Codex after enigma -> next install bypasses it" works, while "disabled manually before/after" sticks. Every enable is logged loudly (`applyBypass` warns "approval prompts are now OFF"). `setEnigmaValue` accepts `string[]` for the array. If you change this posture, update permissions.ts header, both READMEs, and cli.ts help.
- `parallelSubagents` (CLI key `parallel-subagents`, default OFF, opt-in) is a DIFFERENT kind of toggle than `commitEmoji`: it does NOT add an opt-out note the model reads at runtime - it physically adds/removes a section in the DEPLOYED memory file. The section is authored in BOTH memory files (`assets/memory/{CLAUDE,AGENTS}.md`) wrapped in `<!-- enigma:parallel-subagents:start -->`/`<!-- enigma:parallel-subagents:end -->` markers (blank line each side). `skills.ts` no longer copies memory verbatim: `renderMemory` strips the marked block when the toggle is off, `memoryStatus` compares the RENDERED source (not raw bytes), and the install write uses `writeFileSync(renderMemory(...))` not `cpSync`. `applyMemoryToggles(scope)` (exported) re-renders already-deployed memory files (existsSync-guarded; never creates a new deployment) and returns the changed agents. Both surfaces call it after a memory-affecting write: `runConfigCli` (then prints a restart notice via `runningStatus`) and the TUI `persistPending`. Setting carries `affectsMemory?: boolean`. Because the file content changes, the user MUST restart the agent (memory loads at startup) - that is why this toggle prints/needs a restart and `commitEmoji` does not. Subtask DECOMPOSITION (the always-on part) lives OUTSIDE the markers and is never stripped. To add another memory-gated toggle, reuse the marker + `renderMemory` pattern and set `affectsMemory: true`.
- `outputStyle` (CLI key `output-style`, default `off`) is the first CHOICE (enum) setting, not a boolean: values `off|lite|full|ultra` (type `OutputStyle` in config.ts; ported from CAVEMAN = output compression). It reuses the memory-marker mechanism: the `<!-- enigma:output-style -->` block (both memory files) carries a `{{output-level}}` placeholder; `renderMemory` strips the block when `off`, else replaces the placeholder with the level. The settings registry models choice settings WITHOUT breaking the boolean TUI/CLI: `enigmaChoice` gives a boolean FACE (`read` = value != off; `write(true)` = enabledDefault `full` (caveman's default), `write(false)` = off) PLUS `choices`/`readChoice`/`writeChoice` for exact values. So the TUI shows on/off (on=full) and `enigma config output-style <off|lite|full|ultra>` (or on/off) both work; `runConfigCli` branches on `setting.choices`. `enigmaToggle`'s `field` is now constrained to `BooleanConfigKey` (a mapped type) so a string field can't be passed to it. Install-time: `--output-style <v>` flag + an interactive `p.select` in `resolveOutputStyle` (skills.ts) writes the config at scope BEFORE the plan, so `memoryStatus`/`renderMemory` reflect it (writing before the plan is required - else a stale `identical` status would skip the memory update; cost is that aborting the install keeps the chosen preference). Levels are also switchable at runtime by the user (the section documents it), matching CAVEMAN's own model. Reference clone for study: `references/repos/caveman` (gitignored).
- `autoSync` (CLI key `auto-sync`, default ON) makes `enigma <tool>` / `enigma account run` refresh deployed skills/memory before spawning the tool (`autoSyncForLaunch` in cli.ts -> `syncDeployed` in skills.ts). CONSENT BOUNDARY: a CLAUDE.md/AGENTS.md merely EXISTING proves nothing (users author their own - including this repo's root CLAUDE.md, which is claude's LOCAL memory target), so every memory write goes through `writeMemory`, which records the content sha in `~/.enigma/state.json`; `hasDeployment(agent, scope)` = managed-provider skill present OR memory dest recorded in that state, and `syncDeployed` rewrites memory ONLY when `isEnigmaWritten(dest)` (byte-identical to the last enigma write). It never performs a first install, never overwrites `tampered` skills, and a sync failure never blocks the launch. Pre-state.json deployments auto-sync skills but not memory until the next explicit install/toggle records a hash. The same `hasDeployment` drives the hub first-run flow (`HubContext.firstRun`): the TUI preselects the install action (initial sideIndex) and shows a setup banner until a skills install succeeds. The npm postinstall stays download-only by design (a package script must not write to agent config dirs) and only prints a "run `enigma`" hint; the zero-friction first install documented in both READMEs is `npx enigma-cli@latest install --all --yes`.
- `gh-telemetry` (default OFF, applied at install like `claude-attribution`): `src/github.ts` shells out to `gh config get/set telemetry` (never parses gh's YAML - location differs per OS; `ENIGMA_GH_BIN` overrides the binary). `applyGhConfig` in installSkills disables it on every install (privacy + the cli/cli#13354 Windows tzutil window-flash bug); no-op when gh is absent or predates the `telemetry` key (`setGhTelemetry` returns null then). Registry setting is globalOnly (gh has no per-repo config).
- TUI render reads are CACHED at two layers (the TUI re-reads every visible setting per keystroke render): (1) `github.ts` stale-while-revalidate for the slow gh spawn - instant `getGhTelemetryCached` from memo + `~/.enigma/cache.json`, one async revalidation per process, `onGhTelemetryChange` notifies the TUI to re-render when reality differs; only the first read ever probes synchronously; (2) `settings-registry.ts` wraps EVERY setting via `withReadCache` (SWR memo, 2.5s TTL, `invalidateSettingReads()` busted on every registry write and by the gh listener). Author new settings in `RAW_CATEGORIES`; the exported `CATEGORIES`/`ALL_SETTINGS` are the wrapped versions. Never put a spawn/network call in a raw `read()` without this pattern.
- Emoji rule is a layered carve-out: the global "no emojis" ban (core-engineering-policy "Character & Output Constraints", and BOTH memory files' "Always-On Rules" line) now exempts ONLY the leading commit-subject type emoji owned by git-policy. If you change the emoji policy, update all four: core SKILL.md, git-policy SKILL.md, and both memory files (plus the user's own `~/.claude/CLAUDE.md` if syncing personal profile). ciphera-style-policy defers the map to git-policy (does not restate it).
- The guard module (`src/guard.ts`) has a "run standalone" footer guarded by a `guard.*` basename check on `process.argv[1]`. This is REQUIRED: cli.ts imports `runGuardCli`, so the bundler inlines guard.ts into the compiled binary (and the tsx dev entry); a bare `import.meta.url === argv[1]` check would auto-fire the guard on every `enigma <cmd>` and exit before dispatch. Keep the basename guard if you touch that footer.

### Adding a new policy skill (checklist)

- Create `packages/enigma-cli/assets/skills/<name>/SKILL.md` (YAML frontmatter `name` + `description`) and `skill.json` (`name`, `version`, `provider: FJRG2007`, `description`; `sha` is filled by seal).
- Wire it into the harness in `.../assets/skills/core-engineering-policy/SKILL.md`: add a trigger line under "Skill Activation Discipline" AND an ownership line under "Harness Map". Bump core's `version`.
- Restate it in BOTH memory files (`.../assets/memory/AGENTS.md`, `.../assets/memory/CLAUDE.md`) under "Policy Skills" so it survives even when skills do not auto-load.
- Reference sibling skills instead of duplicating their rules (e.g. security-policy defers input validation to validation-policy, encryption to database-expert, secret-in-commit to git-policy).
- Run `npm run seal`, then `node --check` and the `--dry-run` preview. Current count: 12 skills.

### Rules are persuasion, not enforcement (enterprise)

- Skills/memory only persuade the model; for real safety, back critical rules with deterministic gates: Claude Code hooks (settings.json), pre-commit hooks (gitleaks, lint-staged, typecheck), and CI (lint, typecheck, tests, `npm audit`/SAST). security-policy and dependency-policy each end with a "make it mechanical" section pointing at these gates.
- Deterministic gates (tooling distributor, no app test suite): `npm run check` (syntax + skills sealed, catching silent seal-drift), `npm run guard` (`src/guard.ts --all` via tsx: secrets, .env, node_modules), `npm run verify` (typecheck + check + guard). CI: `.github/workflows/ci.yml`. Auto-publish to npm: `.github/workflows/publish.yml` (on GitHub Release; needs `NPM_TOKEN`, checks tag==version). This repo's pre-commit: `.githooks/pre-commit` (`git config core.hooksPath .githooks`).
- `src/guard.ts` is a self-contained (Node-builtins-only) commit guard: it is BOTH this repo's CI/hook scanner (run via tsx, or as built `dist/guard.js`) AND the engine `enigma security` copies into any target repo (`setupGitHooks` in `src/security.ts` copies the guard to `<repo>/.githooks/guard.mjs` and writes `pre-commit` + `enigma-guard.json`, then sets `core.hooksPath`). It locates the guard via `ENIGMA_GUARD_PATH` (set by the launcher) -> `dist/guard.js`. Keep it dependency-free and free of cross-module imports (tsup bundles it standalone). Its module footer self-executes only when `argv[1]` basename matches `guard.*`, so the copy inlined into the compiled binary stays inert. Protections toggleable via `enigma-guard.json`; env allowlist = example/sample/template. Hooks also cover GitHub CLI (`gh`) commits, since gh uses git.
- GitHub repo: `https://github.com/FJRG2007/enigma.git` (renamed from `.../ai.git`). npm package: `enigma-cli` (command `enigma`); license Apache-2.0. Package name was previously `@tpeoficial/skills` then `@fjrg2007/ai`.

### TUI: OpenTUI only (in the Bun-compiled binary)

- ONE renderer: `src/tui/opentui.ts` (`@opentui/react` on a native Zig core). The Ink renderer and `src/runtime.ts`/`isBun()` were removed in v1.4.0 - the app always runs as the Bun binary, so OpenTUI is always available. `runHomeTui` drives the full hub; `runSettingsTui` (showActions:false) drives the settings-only view for `enigma config`. Shared contract types (`HubContext`/`ActionRequest`/`ActionResult`/`HubAgent`/`HubProtection`) live in `src/tui/types.ts`.
- `@opentui/core` + `@opentui/react` (+ `react`, `@clack/prompts`) are `devDependencies`: they are BUNDLED into the compiled binary by `bun build --compile`, so end users never install them. They are still imported DYNAMICALLY in `opentui.ts` so non-TUI commands run under tsx/Node in dev never load the native core. OpenTUI needs React >=19.2; keep `react`/`@types/react` aligned at 19.x.
- Mouse works: rows carry `onMouseDown`, the result view `onMouseScroll`, reusing the same state setters as the key map (no duplicated logic). OpenTUI enables mouse capture by default (`useMouse ?? true`); events bubble to ancestors (`parent.processMouseEvent`) so a `box` row catches clicks on its `text` children. Verified deterministically via `@opentui/react/test-utils` `testRender` + `createMockMouse`.
- OpenTUI gotchas (cost real debugging): a box's default `flexDirection` is `"column"` - set `"row"` explicitly on every horizontal box. Selection highlight must use explicit `bg`+`fg`, NOT the reverse-video `attributes` flag (invisible on some themes). `useKeyboard` key names: `up`/`down`/`left`/`right`/`return`/`escape`/`tab`/`space` plus single chars.
- Action output (install/security) is decoupled from clack via `src/reporter.ts`: `clackReporter` for the direct CLI, `collectReporter` for the TUI (buffers lines so nothing corrupts the live render). The TUI runs actions inline and shows a native result panel.
- Dev: `npm run dev` (Bun, the real TUI), `npm run dev -- --node` (Node/tsx, non-TUI commands only), `npm run dev -- --built` (launcher -> compiled host binary). Defaults to the REAL HOME/cwd; `--sandbox` isolates writes to `.dev-home`. The TUI cannot be runtime-verified headless (no TTY).

### Multi-account (tool-agnostic, enigma-as-launcher)

- `src/accounts.ts` manages multiple logins per tool by giving each account its own config dir and injecting the tool's config-dir env var. The OS-agnostic switch is NOT shell aliases (what the reference blogs do, per-shell/per-OS) but enigma spawning the tool as a child with that env injected - one `child_process.spawn` path for macOS/Linux/Windows. Surfaces: `enigma <tool> [account]` (launch) and `enigma account <list|add|use|login|run|remove> [--tool <name>]` (manage), dispatched in `cli.ts` (`runAccountCli`); plus an Accounts panel in the hub TUI.
- ALL THREE tools are wired in the `TOOLS` registry (accounts.ts): claude (`CLAUDE_CONFIG_DIR`), codex (`CODEX_HOME`, `loginArgs:["login"]`, email decoded best-effort from the `auth.json` id_token JWT payload - email claim only, tokens never surface) and opencode (NO single config var: managed accounts get a private `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pair under the account dir, but `envFor(defaultDir)` returns `{}` so the default account never touches the user's real env; identity = provider keys of auth.json as `displayName`). `enigma <tool>` and `--tool` light up automatically from `TOOL_NAMES`. Do NOT hardcode "claude" in new code - go through `getTool`/`isToolName`.
- PROFILES (1.8.0): registry (`~/.enigma/accounts.json`) gains `profiles: {active, items[name][tool]=account}`. Launch resolution order in `launchTool`: explicit arg > active profile mapping (`resolveLaunchAccount`, skipped if the pinned account vanished) > tool active > default. `removeAccount` scrubs stale profile mappings. CLI: `enigma profile <list|add|use|set|unset|remove>` ("none" deactivates). TUI: Profiles panel (synthetic "(none)" row first; enter activates; creation stays CLI-only), and the add-account flow is now two steps - a SEARCHABLE tool selector (filter input via OpenTUI `onInput`; navigation/enter handled in the GLOBAL key handler because `useKeyboard` fires regardless of input focus - do not also pass onSubmit or selection double-fires) then the name input.
- Each tool's existing config dir is a synthetic, non-removable `default` account (never stored, never deleted); new accounts live under `~/.enigma/<tool>/<name>/`, indexed in `~/.enigma/accounts.json` shape `{tools:{<tool>:{active,accounts[]}}}`. `readRegistry` MIGRATES the legacy flat `{active,accounts}` (1.5.0 claude-only) into `tools.claude` on read. `removeAccount` only `rm -rf`s a dir inside the tool's base (a tampered registry can't point removal elsewhere). `accounts.ts` is Node-builtins-only (no clack); the CLI wrapper prints/prompts.
- Windows spawn: a `.cmd` shim or bare name needs `shell:true`; `spawnInherit` quotes args (`quoteWinArg`) and uses `shell:false` with the resolved absolute path for `.exe`. Binary resolved via `tool.binEnv` (e.g. `ENIGMA_CLAUDE_BIN`) -> `resolveBin(tool.bin)` (full-path PATH/PATHEXT resolver in `util.ts`, which `isOnPath` delegates to). `--` ends enigma arg parsing; everything after is forwarded verbatim to the tool.
- IDENTITY DISPLAY: `listAccounts` surfaces the signed-in email per account via `ToolSpec.accountInfo(dir)` (claude reads `oauthAccount.emailAddress` from `<dir>/.claude.json`; no tokens are read), plus the tool label. Shown in `enigma account list` and the TUI Accounts panel. Accounts not yet logged in show "(not logged in)".
- TUI CONNECT + ADD: the Accounts panel can connect/log in an account (`c`) and CREATE one (`a`), not just list/activate(`enter`)/remove(`d`). Add opens an OpenTUI `<input focused onSubmit>` overlay (JSX tags `input`/`select`/`tab-select` are exposed by `@opentui/react`, installed workspace-local under `packages/enigma-cli/node_modules`); `useKeyboard` is a GLOBAL listener that fires regardless of the focused input, so the key handler MUST short-circuit while `adding` (only Escape) or typed letters (q/s/x) would trigger hub actions. On submit it calls the `HubContext.addAccount` callback (returns `{ok,error?,accounts}` so the renderer shows inline validation errors without importing `accounts.ts`), then shows a "connect now?" prompt; Yes exits via the `HubExitAction` connect path. Only Claude is registered so there's no tool `<select>` step yet (the elements exist for when there's >1 tool). Headless-verifiable: `@opentui/core/testing` `testRender` + `createMockKeys` (`pressKeys`/`KeyCodes`, `captureCharFrame`) run under BUN (not Node - native core). Connecting can't happen inside the TUI (launching the tool needs the terminal the TUI owns, and login is the tool's own interactive flow), so the panel exits the hub returning a `HubExitAction` (`{type:"connect",tool,account}`); `cli.ts` runs `loginTool` in the freed terminal and reopens the hub in a loop. activate/remove stay as in-TUI `HubContext` callbacks (now keyed by `(tool,name)`) that return the refreshed list. `opentui.ts` renders purely from `HubContext` and never imports `accounts.ts`. `add` is still CLI-only (needs a name input).

### Style-conflict resolutions already decided

- ciphera-style-policy mandates 4-space indent, but this repo's own JS uses 2-space. When editing existing files, match the file's style; Ciphera style governs new code only (consistency outranks style per the priority hierarchy).
- Ciphera uses emoji commit tags, but core-engineering-policy forbids emojis and git-policy prefers Conventional Commits. Commits/PRs follow git-policy; do not add Ciphera emoji tags.

### Environment quirk

- This shell delivers tool results with delayed/batched flushing. Do not re-issue a tool call just because its result has not appeared yet; avoid duplicate Read/Bash calls (they return "Wasted call" or run twice).
