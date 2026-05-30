# skills

Install/update the *skills* and memory files of your AI agents
(Claude Code, …) at the **global** (user) or **local** (project) level with a
single command.

## Structure

```
skills/
└── <agent>/                   # target agent name (claude, codex, …)
    ├── CLAUDE.md / AGENTS.md   # memory/instruction files (agent root)
    └── <skill>/
        ├── SKILL.md            # skill content (the only thing the AI reads)
        └── skill.json          # metadata (NOT read by the AI) — see below
```

## Skill metadata (`skill.json`)

Convention: a `skill.json` sidecar next to each `SKILL.md`. The agent harness
only loads `SKILL.md`, so **the AI never reads `skill.json`** nor interprets it
as instructions. It is used to version and attribute the skill:

```json
{
  "name": "git-policy",
  "version": "1.0.0",
  "provider": "FJRG2007",
  "description": "Git & contribution policy (senior engineering standards).",
  "sha": "884000ff61ba558c020d21723d87942fdd00fe85c1eee57b15bf1e9b0c47c3b9"
}
```

Using the `version`, the installer compares source vs destination and shows
whether each skill is **installed** (`install v1.0.0`), **updated**
(`update 0.9.0 → 1.0.0`) or **reinstalled** (same version, `reinstall v1.0.0`).
In the interactive menu **all skills are selected by default** and you can
deselect any you do not want to install.

### Integrity by hash (`sha`) and optimization

The `sha` field is the SHA-256 hash of the skill content (all of its files
**except** `skill.json`). It serves two purposes during updates:

- **Same version and intact content** → the skill is considered identical and is
  **skipped** (`up-to-date (skip)`). It does not count as updated.
- **Same version but the destination was modified by hand** (the current hash
  does not match the one recorded at install time) → it is marked as
  **`MODIFIED locally`** and, in interactive mode, a selector appears with all
  modified skills **selected by default** so you can choose which to overwrite.
  With `--keep-modified` they are all kept without prompting.

Generate/update the hashes before publishing with:

```bash
node scripts/install-skills.mjs --seal     # = npm run seal
```

### Pruning orphaned skills (prune)

If a skill is removed from the source repository, on the next update the
installer **deletes it from the destination** — but **only if its `skill.json`
at the destination declares `"provider": "FJRG2007"`**. Hand-made skills
(without `skill.json`) or those from other providers are **never touched**. They
are shown in the plan as `remove (orphaned)` and confirmed before deletion.
Disable it with `--no-prune`.

> Pruning is based on what the repo ships in `skills/`, not on your menu
> selection: deselecting a skill does not remove it, it only avoids reinstalling
> it.

The installer automatically discovers the agents present in `skills/` and copies
each part to the agent's standard location:

| Agent       | Scope    | Skills                | Memory (`*.md`)    |
| ----------- | -------- | --------------------- | ------------------ |
| Claude Code | global   | `~/.claude/skills/`   | `~/.claude/`       |
| Claude Code | local    | `.claude/skills/`     | project root       |

> Installs **always overwrite** existing files.

## Usage

Interactive (menus with `@clack/prompts`):

```bash
npx @tpeoficial/skills
```

Single command (non-interactive):

```bash
# Everything, for every agent, at the user level
npm run skills:global          # = node scripts/install-skills.mjs --global --all --yes

# Everything, inside the current project
npm run skills:local           # = node scripts/install-skills.mjs --local --all --yes

# A specific skill of an agent, global
node scripts/install-skills.mjs -g -a claude -s git-policy -y
```

## Options

```
-g, --global         Install at the user level (~/.claude, …)
-l, --local          Install into the current project (.claude, …)
-a, --agent <name>   Agent(s): comma-separated or repeated (default: all)
-s, --skill <name>   Skill(s): comma-separated or repeated (default: all)
    --skills-only    Skills only (skip CLAUDE.md / AGENTS.md)
    --memory-only    Memory files only
    --no-prune       Do not remove orphaned skills (pruned by default)
    --keep-modified  Do not overwrite skills modified by hand at the destination
    --seal           Maintenance: recompute the sha in the source skill.json files
-y, --yes            Non-interactive (accepts defaults / flags)
    --dry-run        Show the plan without writing anything
-h, --help           Help
```

## Adding a new agent

Create `skills/<agent>/` with its skills/memory and, if its destination path is
not one of the supported ones, add its mapping to the `AGENTS` object in
`scripts/install-skills.mjs`.