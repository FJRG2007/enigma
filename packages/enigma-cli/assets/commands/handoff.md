---
description: Hand the current work to a fresh session - write a one-page handoff (goal, state, next step, how to verify) so the context can be cleared without losing anything, and the next session continues from it on its own. Use before /clear, when the conversation has grown long, or when switching to an unrelated task.
argument-hint: [what the next session should focus on]
---

# /handoff

Write the handoff for this project so the context can be cleared. Extra direction from the user: **$ARGUMENTS**

Every model call re-reads the whole conversation, so a long one costs more on every step. A handoff carries the work across a `/clear` (or `/new`) at a fraction of the size: the next session in this project receives it once, at start, and continues from it without being asked - unless that session opens on a different request, in which case it does that instead and just mentions the handoff is kept.

## Write it

Save it with `enigma handoff save`, the page on stdin:

```bash
enigma handoff save <<'EOF'
# <the goal, one line>

## Done
- <what is finished and verified, with file:line or commit where it helps>

## Next
1. <the very next action, concrete enough to start without re-reading anything>
2. <then>

## Decisions
- <a choice already made and why, so the next session does not reopen it>

## Verify
- <the commands that prove it works>

## Files
- <the files that matter, and what each is for>
EOF
```

Rules for the page:

- It is everything the next session gets. Name exact paths, symbols, commands and the user's own requirements; do not paste transcript, diffs or file contents - the next session can open files.
- Keep it to one page (the store refuses over 32 KB).
- Unfinished or unverified items go under Next, never under Done.
- If the work is finished and nothing is left to resume, add the line `STATUS: done`; it is then kept but not delivered.
- If the user named a different next task, the handoff is for that task: put it as the goal and keep only what it needs from this one.

## Then

Tell the user in one line that the handoff is saved and that `/clear` (Kimi, Codex, OpenCode: `/new` or `/clear`) starts the next session from it. In Claude Code with `enigma config relay on`, enigma clears and continues on its own, so say nothing about clearing there.
