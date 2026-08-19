---
name: technical-writing-policy
description: Concise, realistic technical copy - UI microcopy, labels, descriptions, setting hints, empty/error states, and README/doc prose that informs without over-explaining, restating the obvious, or leaking implementation detail, and that never uses an em dash. Use whenever writing or reviewing user-facing text: a dashboard/app label or description, a settings hint, a panel intro, a button, a skill/package description, a README section, or any doc copy. Also use when the user complains that descriptions are too long, over-explained, obvious, or "cutre".
---

# Technical Writing Policy (Concise, Realistic Copy)

User-facing text is design material, not decoration. Every word must earn its place.
Give the reader exactly what they need to act - not less, not more. This policy owns
descriptive copy: labels, descriptions, hints, empty/error states, panel intros, and
README/doc prose. Commit/PR prose is owned by git-policy; visual design by frontend-design.

## Core Principle

A description says, in plain terms, WHAT a thing is or does and why the reader should
care - from the reader's side of the screen. It is not a tutorial, not a changelog, not
a spec, and not a place to show your work.

The test for every sentence: **would removing it lose information the reader needs to act
or decide?** If not, cut it. If you can't remember a button's exact label, it's good
microcopy - the reader shouldn't have to study it.

## The Cardinal Sins (cut these)

1. **Narrating the obvious.** Do not describe the controls the reader can already see.
   "Edit a skill's content, disable/enable or remove it" next to Edit/Disable/Remove
   buttons tells the reader nothing - they can see the buttons. Describe the *thing*, not
   the toolbar around it.
2. **Leaking implementation detail.** The reader does not need the internals. A password
   form does not say "hashed with SHA-256"; a sync feature does not list its diff
   algorithm. Surface mechanism only when the reader must act on it (a security warning, a
   destructive-action caveat, a real constraint they hit).
3. **Redundant cross-references and meta-commentary.** "...the same as the terminal UI",
   "as mentioned above", "this section explains..." - filler that orients nothing. State
   the thing directly.
4. **Hedging and marketing.** "powerful", "simply", "just", "seamless", "robust", "in
   order to". Plain verbs and concrete nouns instead.
5. **Restating the heading.** A panel titled "Accounts" whose intro begins "Manage your
   accounts" wastes the first line. Add information the title does not already carry.
6. **Over-explaining a feature.** A feature card or list item sells the outcome in one or
   two lines, then stops. Cut the mechanism, config internals, every flag, and the edge
   cases out of the pitch - lead with what the reader gets, name the command or show the
   one example that proves it, and leave the rest for the docs. A landing/README feature
   list whose job is to make the reader *want* it still obeys this: punchy beats thorough.
   Three padded sentences hide the hook that one tight sentence would land.

## Rules

- Name things by what the reader controls and recognizes, not by how the system is built
  (a person manages *notifications*, not *webhook config*).
- Be specific over clever: "Resets Monday 11:00" beats "Resets soon".
- Match length to the slot: a setting hint is one line; a panel/page intro is one sentence
  of orientation plus, only if needed, one of consequence (a caveat, a default, a cost).
  An empty state is one line that invites the next action. A feature card leads with the
  benefit in the first clause, runs one or two sentences, and lets the command or example
  carry the proof - never a how-it-works paragraph.
- Active voice, present tense, sentence case. The control names the exact action ("Save
  changes", not "Submit"); the same verb survives the whole flow (Publish -> "Published").
- Errors say what went wrong and how to fix it, in the interface's voice - never vague,
  never an apology, never a raw stack trace or internal error to the user.
- Be realistic, not aspirational: describe what it actually does today, not the roadmap.
- Examples use placeholders, never the operator's real environment: `example.com`,
  `your-domain.tld`, `<project-root>`, `user@example.com`, a relative path. A domain, host,
  IP, or `C:\Users\<name>\...` path that reached you through the chat or a local file does
  not belong in a README, a code sample, a comment, or a UI string unless the user asked for
  that exact value (security-policy, git-policy).
- READMEs: assume a competent reader. Explain what is non-obvious or load-bearing (how to
  run it, the one surprising constraint, why a choice was made) and skip what the audience
  already knows or can infer from the code. Lead with the point; cut the throat-clearing.
- Never use a typographic dash in user-facing copy. The em dash (`—`) and en dash (`–`) are
  the single most recognizable tell of AI-written text in an interface, and no product's UI
  needs them: use a plain hyphen "-", a comma, a colon, or two sentences, and write a range
  as "5 to 10". This applies to every string a person reads - labels, hints, empty and error
  states, tooltips, toasts, docs and README prose. Keep one only when the dash is the
  subject (a typography guide, a punctuation rule) or when quoting text verbatim, and, as
  with every rule here, when the user explicitly asks for it.
- Do NOT volunteer a "Project Structure" section with an ASCII/box-drawing file tree and a
  folder-by-folder explanation ("src/ contains the files of the application", "public/:
  contains static files") on your own initiative. It is the hallmark of an AI-written README:
  it rots the instant a file moves, is usually misaligned, and restates what the reader sees in
  the file browser - real project READMEs rarely ship one. If the user explicitly asks for a
  project-structure tree, generate it (well-formed and accurate); just never add one unprompted.
  Otherwise document a directory only when its purpose is non-obvious and load-bearing, in one
  line of prose, never a whole tree.

## Reviewing existing copy

When asked to fix "bad"/over-explained descriptions: read each line and delete what fails
the test above. Prefer one tight sentence over three padded ones. Keep every load-bearing
fact (a real constraint, a default, a cost, a security caveat); cut everything that only
restates the obvious or narrates the UI. Report what you cut and why in one line.

## Boundaries

- Respond in the user's language; copy itself is written in the project's language
  (English here) per core-engineering-policy.
- Commit messages and PR text: git-policy. Visual/typographic design: frontend-design.
  Validation/error-handling logic: validation-policy. This policy governs the words.
