# Convention checks (`enigma checks`)

The many small conventions a user keeps repeating to agents ("validate that name against the data
already loaded", "highlight code wherever it is shown", "icons, not a bare Remove button") cannot
all live in the always-on memory: every line there is paid on every turn, and a rule in a SKILL.md
alone is skippable (`skills-are-skippable.md`). Checks are the tier for conventions that need
JUDGMENT (no regex can tell "this list shows code" from "this list shows names") but must still be
enforced, at near-zero cost in the main agent's context.

## Shape

- A check is a Continue-compatible markdown file: frontmatter `name`, `description`, `files`
  (globs, missing = every file), `exclude`, `when` (regex on ADDED lines, a cheap prefilter),
  `severity` (`block` | `warn`), `enabled: false` to turn an inherited one off; body = the rule,
  what passes, what fails. 8 KB cap, strict name, a bad regex drops the file (`src/checks.ts`).
- Layered by name: built-in (`assets/checks/`) -> user (`~/.enigma/checks/`) -> project
  (`.agents/checks/`). A later layer replaces or disables an earlier one.
- Built-ins: code-highlighting, live-validation, icon-actions, data-view-affordances, live-state, forms-on-demand
  (optimistic mutations, and derived views - order, counts, previews - recomputed on every change
  source; the stale chat-list order bug), scale-security-privacy.
- The `when` prefilter is the deterministic lever against judge false positives: a small model
  ignored a written exception (a chat sidebar asked for pagination) until the prefilter stopped
  sending non-table lists to the table check at all.
- CLI: `enigma checks list|show|run|pending|approve <name|--all>|reject|learn` (`checks-cli.ts`).

## Why it is fast (the design constraint)

The user's complaint that shaped this: enigma made Claude slower even for trivial things. So:

1. Nothing runs in the agent's turn. The post-edit hook only SCHEDULES a detached runner
   (`checks-judge.ts`, its own bundle `dist/checks-run.js`, started through the launcher's Node
   fast path, `windowsHide: true`). The runner waits 1.5s for the edit burst to settle.
2. Only changed files, only applicable checks: `git diff HEAD -U6` plus small untracked files,
   filtered by globs and the `when` prefilter. A file no check applies to is never sent.
3. A small model over direct HTTPS (the recall provider: Claude OAuth with Haiku, an Anthropic
   key, or any OpenAI-compatible endpoint, `llm.ts`), concurrency 4, strict JSON verdicts.
4. Verdicts cached by sha1(model, file, diff, check bodies): the same diff is never judged twice.
   Measured: 35s cold on a 2-file repo, 2.6s cached.
5. The Stop hook (`verify.ts`) reads the verdicts, waits at most 20s for pending ones, and FAILS
   OPEN: an unreachable judge or an unparseable reply never blocks or delays the turn.
6. Block-severity findings go back to the agent once per distinct finding set (mayBlock channel
   `checks`), with file:line and the reason.

Related speed fixes shipped with it: the self-audit is skipped on a trivial turn (`trivialTurn`),
and the gate treats a copy-only change (string literals, tag text, prose, translations, up to 400
lines, nothing sensitive) as trivial (`copyOnlyDiff`, see `gate.md`).

## Learning from corrections

`checks-learn.ts` reads the last 14 days of the user's prompts, keeps the ones that read as
corrections, and asks the model for at most 5 GENERAL rules (a named example is a sample of a
class). A proposal is kept only when it cites two or more distinct messages as evidence, is not
`covered_by` an existing check, and is not a content-word Jaccard >= 0.25 duplicate of one. It
lands in `~/.enigma/checks/pending/` and is never active until the user approves it; a session-start
notice says when proposals are waiting (once a day). Runs daily in the background (`checksLearn`).

## What was not adopted, and why

- ast-grep / Semgrep rules: precise for structural shapes, but the conventions here are semantic;
  the structural ones already live in guardrails (deterministic, token-free).
- A per-turn headless browser QA pass: the strongest evidence for UI rules, but it costs minutes
  per turn. It stays on demand (`/qa`).
- More always-on prompt text: the cost the whole design exists to avoid.

## Sources (research, 2026-11)

- Continue checks format and practice: https://docs.continue.dev/checks/reference ,
  https://docs.continue.dev/checks/best-practices , https://docs.continue.dev/checks/running-in-ci
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Instructions fail, deterministic gates win:
  https://dev.to/tamizuddin/taming-ai-coding-agents-why-markdown-instructions-fail-and-deterministic-scripts-win-3kc5 ,
  https://evilmartians.com/chronicles/stop-writing-rules-in-agents-md-use-agent-hooks-and-nano-staged-instead ,
  https://www.mindstudio.ai/blog/ai-coding-agent-hooks-explained ,
  https://www.sitepoint.com/claude-code-hooks-enforce-project-conventions/
- LLM judgment inside hooks: https://youmind.com/landing/x-viral-articles/llm-judgment-coding-agent-hooks ,
  https://openrouter.ai/docs/cookbook/coding-agents/automatic-code-review ,
  https://zackproser.com/blog/codex-reviews-claudes-diffs , https://mesa.dev/review-cli/docs/claude-code
- Structural rules for agents: https://ast-grep.github.io/blog/ast-grep-agent.html ,
  https://ast-grep.github.io/advanced/prompting.html
- Learning from corrections: https://github.com/TerenceBristol/claude-improve ,
  https://www.mintlify.com/rohitg00/pro-workflow/concepts/self-correction-loop
- Workflow references: https://github.com/philippe-ths/ai-coding-workflow , https://github.com/owayo/claw-hooks ,
  https://thoughtbot.com/blog/enforcing-your-ruby-style-guide-on-ai-generated-code
- Browser verification (not adopted per turn): https://www.freecodecamp.org/news/how-to-make-your-coding-agent-check-its-work-in-the-browser/ ,
  https://thoughtbot.com/blog/building-programmable-qa-with-ai
