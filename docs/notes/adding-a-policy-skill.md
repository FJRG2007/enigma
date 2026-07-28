# Adding a new policy skill (checklist)

- Create `packages/enigma-cli/assets/skills/<name>/SKILL.md` (YAML frontmatter `name` + `description`) and `skill.json` (`name`, `version`, `provider: FJRG2007`, `description`; `sha` is filled by seal).
- Wire it into the harness in `.../assets/skills/core-engineering-policy/SKILL.md`: add a trigger line under "Skill Activation Discipline" AND an ownership line under "Harness Map". Bump core's `version`.
- Restate it in BOTH memory files (`.../assets/memory/AGENTS.md`, `.../assets/memory/CLAUDE.md`) under "Policy Skills" so it survives even when skills do not auto-load.
- Reference sibling skills instead of duplicating their rules (e.g. security-policy defers input validation to validation-policy, encryption to database-expert, secret-in-commit to git-policy).
- Run `npm run seal`, then `node --check` and the `--dry-run` preview. Current count: 17 skills (15 policy skills + the vendored Anthropic `frontend-design` and `skill-creator` skills; the vendored ones carry only `name`/`description`/`version` and are re-provider'd to FJRG2007/enigma by seal, and their LICENSE.txt is intentionally not bundled).
