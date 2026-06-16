---
name: anti-overengineering-review
description: On-demand review that hunts ONLY over-engineering and reports what to delete - reinvented standard library, unneeded dependencies, speculative abstractions, dead flexibility. Three one-shot modes, none apply fixes: diff review, whole-repo audit, and an enigma: debt-marker ledger. Use when the user says "review for over-engineering", "what can we delete", "is this over-engineered", "simplify review", "audit this codebase", "find bloat", "what did we defer", "list the shortcuts", or "what did we mark to do later". Complements code-review-policy (which owns correctness, security, and performance); this one only cuts complexity.
---

# Anti-Overengineering Review

On-demand complexity hunting. This skill finds what to delete and reports it;
it never applies the fixes. Correctness bugs, security holes, and performance go
to a normal review pass (code-review-policy owns those) - this one only cuts
complexity. The build-time discipline that prevents the bloat in the first place
lives in anti-overengineering-policy.

Pick the mode from the request:

- **Review** - a diff or set of changes (default).
- **Audit** - the whole repository.
- **Debt** - harvest the `enigma:` shortcut markers into a ledger.

## Tags (Review and Audit)

One line per finding. Each is tagged by what kind of cut it is:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Review (diff)

Format: `L<line>: <tag> <what>. <replacement>.`, or `<file>:L<line>: ...` for
multi-file diffs. The diff's best outcome is getting shorter.

Bad: "This EmailValidator class might be more complex than necessary; have you
considered whether all these rules are needed?"

Good:

- `L12-38: stdlib: 27-line email validator class. "@" check in one line; real validation is the confirmation mail.`
- `L4: native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.`
- `repo.py:L88: yagni: AbstractRepository with one implementation. Inline it until a second one exists.`
- `L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.`
- `L30-44: shrink: manual loop builds a dict. dict(zip(keys, values)), 1 line.`

End with the only metric that matters: `net: -<N> lines possible.` Nothing to
cut: `Lean already. Ship.`

## Audit (repo-wide)

Review, applied to the whole tree instead of a diff. Same tags, ranked biggest
cut first. Hunt: dependencies the stdlib or platform already ships,
single-implementation interfaces, factories with one product, wrappers that only
delegate, files exporting one thing, dead flags and config, hand-rolled stdlib.

Format: `<tag> <what to cut>. <replacement>. [path]`, ranked. End with
`net: -<N> lines, -<M> deps possible.` Nothing to cut: `Lean already. Ship.`

## Debt (marker ledger)

Every deliberate shortcut left by anti-overengineering-policy is marked with an
`enigma:` comment naming its ceiling and upgrade path. Collect them so a
deferral cannot quietly become permanent.

Scan the repo for the markers, skipping `node_modules`, `.git`, and build output:

```
grep -rnE '(#|//) ?enigma:' .
```

(Add other comment prefixes if the stack uses them.) The comment prefix keeps
prose that merely mentions the convention out of the ledger.

One row per marker, grouped by file:

`<file>:<line> - <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

Pull the ceiling and the trigger straight from the comment (the convention is
`enigma: <ceiling>, <upgrade path>`). Any marker that names no upgrade path or
trigger gets a `no-trigger` tag - those are the ones that silently rot. End with
`<N> markers, <M> with no trigger.` Nothing found: `No enigma: debt. Clean ledger.`

## Boundaries

- Complexity only. Correctness, security, and performance go to code-review-policy.
- A single smoke test or assert-based self-check is the anti-overengineering minimum, not bloat - never flag it for deletion.
- Lists findings; applies nothing. One-shot report. Ask before writing a ledger to a file (e.g. `OVERENGINEERING-DEBT.md`).
