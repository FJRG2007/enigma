---
name: technical-writing-policy
description: Concise, realistic technical copy - UI microcopy, labels, descriptions, setting hints, empty/error states, landing/sales and SEO copy, emails, and README/doc prose that describes the user's outcome instead of the mechanism, never enumerates everything or names its lineage ("powered by X"), avoids the recognizable AI-writing tells (delve/seamless/robust vocabulary, "It's not X, it's Y", forced triads, throat-clearing, chat residue), and never uses an em dash. Use whenever writing or reviewing user-facing text: a dashboard/app label or description, a settings hint, a panel intro, a button, a landing page, a marketing or SEO page, an email body, a skill/package description, a README section, or any doc copy. Also use when the user complains that copy is too long, over-explained, obvious, generic, reads as AI-written ("AI slop"), or "cutre".
---

# Technical Writing Policy (Concise, Realistic Copy)

User-facing text is design material, not decoration. Every word must earn its place.
Give the reader exactly what they need to act - not less, not more. This policy owns
every word a person reads: UI labels, descriptions, hints, empty/error states, panel intros,
landing and sales pages, SEO copy (titles, meta descriptions, headings), email subjects and
bodies, and README/doc prose. Commit/PR prose is owned by git-policy; visual design by frontend-design.

## Core Principle

A description says, in plain terms, WHAT a thing is or does and why the reader should
care - from the reader's side of the screen. It is not a tutorial, not a changelog, not
a spec, and not a place to show your work.

The test for every sentence: **would removing it lose information the reader needs to act
or decide?** If not, cut it. If you can't remember a button's exact label, it's good
microcopy - the reader shouldn't have to study it.

**Outcome, not mechanism.** Copy describes the user's outcome or the decision in front of
them, never how the system produces it. Name only what the user must act on. Per clause,
ask: **would a user act differently knowing this?** If not, delete the clause.

- Password hint: "Hashed with Argon2id" -> "At least 12 characters".
- Search box: a hint listing the 20 data types it covers -> "Search everything", with a
  filter control that holds the types.
- Sync status: "Diffed via Merkle tree every 30s" -> "Synced 2 minutes ago".

## The Cardinal Sins (cut these)

1. **Narrating the obvious.** Do not describe the controls the reader can already see.
   "Edit a skill's content, disable/enable or remove it" next to Edit/Disable/Remove
   buttons tells the reader nothing - they can see the buttons. Describe the *thing*, not
   the toolbar around it.
2. **Leaking implementation detail.** The reader does not need the internals. A password
   form does not say "hashed with SHA-256" (it says "At least 12 characters"); a sync feature does not list its diff
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
7. **Enumerating everything.** Give one or two representative examples, never the full list
   of supported formats, providers, languages or data types. The complete list belongs in a
   filter, a picker, or the docs, where the reader can scan it when they need it. Concise,
   scannable copy measurably outperforms the exhaustive version (NN/g: +58% usability).
8. **Naming the lineage.** No "inspired by", "powered by", "built with" or "based on X" in
   product copy. It sells the tool's ingredients instead of the reader's result. Credit a
   dependency where attribution is required (a license notice, an about page, docs), not in
   a hero, a feature card, or a hint.
9. **Writing in the AI register.** The tells below mark copy as generated and cost the
   reader's trust in everything around them. See "AI Tells" for the catalogue.

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

## AI Tells (cut on sight)

Each tell with the fix. One tell is noise; several together make the page read as generated.

- **AI vocabulary.** delve, tapestry, testament, underscore, pivotal, intricate, meticulous,
  vibrant, showcase, foster, garner, interplay, abstract "landscape", boasts, crucial,
  enhance, robust, seamless, elevate, unlock, leverage. "Leverage robust tooling to unlock
  seamless deploys" -> "Deploy with one command".
- **Inflated significance.** "stands as a testament to", "plays a pivotal role in", "in the
  evolving landscape of". Say what it does: "Handles 40% of our traffic".
- **Shallow -ing riders.** A clause tacked on with ", highlighting / underscoring / ensuring /
  showcasing ...". "Retries failed jobs, ensuring reliability" -> "Retries failed jobs up to
  3 times".
- **Negative parallelism.** "It's not X, it's Y", "Not only X but Y", "No X, no Y, just Z".
  State Y.
- **Forced triads.** "fast, reliable, and scalable". Keep the one adjective you can prove, or
  give the number.
- **Copula avoidance.** "serves as", "boasts", "stands as". Use "is" and "has".
- **Chat residue.** "I hope this helps", "Certainly!", "Great question", "[Your Company]",
  `utm_source=chatgpt` in a link. Delete it; fill every placeholder.
- **Throat-clearing.** "Let's dive in", "It's worth noting that", "At its core", "In today's
  fast-paced world". Start with the point.
- **Condescending filler.** simply, just, easy, obviously. What is easy for you is the step
  the reader is stuck on.
- **Structure tells.** Title Case Headings -> sentence case. A run of bullets that each open
  with a bold label and a colon -> plain sentences or a table. Emoji as bullets or icons ->
  none. A heading the next line restates, or meta-commentary ("This section covers") -> cut.
- **Closers.** A "Challenges and future outlook" section, or a pithy one-line moral at the
  end ("The future is bright.") -> end on the last useful fact.
- **Errors.** "Oops! Something went wrong (ERR_502)" -> "Couldn't save your changes. Check
  your connection and try again." Say what happened and how to fix it; no "Oops", no raw
  codes, no apology.
- **Labels.** "Click here", "Submit", "Learn more" -> the verb and its object: "Download the
  invoice", "Create project".
- **Marketing claims.** Benefit first, one real attributed number, never an invented one.
  "10x faster" with no source -> the measured figure with its source ("Builds in <N>s on
  <benchmark>, measured on <where>"), or cut the claim.
- Typographic dashes are covered by the dash rule above.

## Reviewing existing copy

When asked to fix "bad"/over-explained descriptions: read each line and delete what fails
the test above. Prefer one tight sentence over three padded ones. Keep every load-bearing
fact (a real constraint, a default, a cost, a security caveat); cut everything that only
restates the obvious or narrates the UI. Report what you cut and why in one line.

## Boundaries

- Respond in the user's language; copy itself is written in the project's language
  (English here) per core-engineering-policy.
- Commit messages and PR text: git-policy. Visual/typographic design: frontend-design.
  Validation/error-handling logic: validation-policy. Email templating and deliverability:
  email-policy. This policy governs the words, wherever they ship.
