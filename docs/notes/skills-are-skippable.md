# Skills are skippable by design (architecture)

- Claude Code, Codex, and opencode all load skills via progressive disclosure: only each skill's `name` + `description` is always in context; the SKILL.md body loads only if the model decides to activate it.
- Therefore a rule that lives ONLY in a SKILL.md can be skipped. The only guaranteed always-on channel is the memory file (`packages/enigma-cli/assets/memory/CLAUDE.md`, `.../AGENTS.md`).
- Consequence: non-negotiable rules must also be restated in the memory file's "Operating Contract" / "Always-On Rules" block, not only in a skill. When adding a hard rule, update both.
