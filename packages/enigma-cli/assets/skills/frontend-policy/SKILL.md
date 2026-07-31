---
name: frontend-policy
description: Frontend architecture - reusable components, abstraction thresholds, state management, no-op detection (skip any operation whose result equals the current state - form saves, toggles, filters, reorders - not just saves; dirty means the values DIFFER from the loaded snapshot, not that the user touched the field, so a value edited and put back leaves Save disabled), client-side caching (localStorage/sessionStorage to avoid redundant server calls and survive rate limits), instant first paint (render the shell immediately, load data async via the API, show skeletons - never block render on data), perceived performance and responsiveness (instant interaction feedback, prefetch on intent, debounce/throttle, cancel stale requests, avoid request waterfalls, lazy-load heavy widgets), large-list rendering (virtualized infinite scroll vs pagination, skeletons, progressive/parallel loading, short-TTL caching), optimistic UI with rollback, visual restraint (never a card inside a card, borders only where they carry information, spacing and background tone before chrome), icon actions (repeated row/card actions like copy, edit, rename, remove, download, refresh are icon-only buttons carrying aria-label plus title, never a text label), responsive/adaptive layout (fluid units, breakpoints, no overlap or horizontal overflow, viewport meta, touch targets), AI chat/assistant/agent interfaces (use Vercel's AI Elements registry for message threads, streaming, reasoning and tool-call panels, prompt inputs - never hand-roll chat UI in React), and periodic React code-health audits (react-doctor). Use when building or changing UI components, client state, forms/save flows, data fetching/caching, lists that show lots of data, loading states, dashboards/panels, layout/responsiveness, making the UI feel fast, building a chat/AI/agent/LLM interface, or any frontend structure.
---

# Frontend Architecture Policy

## Activation Scope

- Apply whenever the task involves UI components, client-side state, data fetching, or frontend structure.
- Owns component design, reuse thresholds, client-side caching, and optimistic UI. Input validation rules live in validation-policy; global architecture rules live in core-engineering-policy; server-side caching lives in backend-policy.

---

## Frontend Structure

- Build reusable UI components instead of page-specific implementations.
- Use composition and props for variants instead of duplication.
- Avoid one-off components when a reusable abstraction is possible.
- Separate presentation, state, and side effects; keep data fetching out of pure render logic.

---

## Component Reuse (Mandatory)

- ALWAYS reuse a single base component and drive its behavior with props; NEVER create separate components for variants of the same element.
- One component per UI primitive (Input, Button, Modal, Select, ...). Variants and behaviors are configuration of that one component, not new components.
- The base component encapsulates all variant logic internally; callers only pass props.

### Input Example (one Input component, behavior via props)

- A single Input component must support every input behavior through configuration, not separate components.
- The behavior lives INSIDE the Input component, switched by its `type`/`variant` props:
  - type "password": renders a show/hide eye toggle inside the field.
  - type "phone": renders an in-field country selector/search and formats the number.
  - type "email", "text", "search", etc.: standard text behavior with the matching adornments.
- Do NOT create PasswordInput, PhoneInput, EmailInput as separate components - it is one Input that branches internally on its props.

### Button Example (one Button component, variants via props)

- A single Button component handles all variants via props (e.g. `variant`: primary/secondary/ghost/destructive; `size`; `loading`; `icon`).
- Do NOT create PrimaryButton, DangerButton, etc. as separate components - pass `variant`.

- Apply the same rule to every primitive (Modal, Card, Select, Badge, ...): one component, configurable behavior.
- This keeps the design system small, consistent, and scalable: a change to the primitive propagates everywhere automatically.

### Select with icons / rich options

- A native HTML `<select>`/`<option>` renders option content as PLAIN TEXT only: it cannot show an icon, image, or any markup inside an option. Putting an icon next to the `<select>` is not the same as an icon inside each option.
- When options need per-option icons/logos or rich content, build a custom accessible dropdown: a trigger button (showing the selected option's icon + label) plus a popup `role="listbox"` of `role="option"` items, each carrying its icon. Keep full keyboard support (Up/Down to move, Enter/Space to choose, Escape to close, focus returns to the trigger) and close on outside click - the keyboard/ARIA behavior is the part a native select gives you for free and must be re-implemented.
- Make it ONE reusable component driven by an options array (`{ value, label, icon }`) plus value/onChange, not a bespoke dropdown per use. The experimental customizable `<select>` (`appearance: base-select`) is not yet cross-browser, so do not rely on it.

---

## Frontend Abstraction Threshold

- Create reusable components only when:
  - They are used in multiple places, OR
  - They contain meaningful reusable logic, OR
  - They reduce duplication significantly

- Do not abstract single-use UI elements unless future reuse is highly likely.
- Prefer simple, local components for simple, local problems.

---

## Visual Hierarchy & Layout Restraint

Less is more. Chrome - borders, boxes, cards, shadows, dividers - is the most overused tool in generated UI, and every extra layer of it makes the screen harder to read, not more organized. Grouping is done with space first; a container is the last resort, not the default wrapper.

**One surface level.** A card already IS a surface. Do not put a card inside a card, and never nest a third: stacked backgrounds, paddings and shadows read as visual noise and shrink the usable content width at every level. Related content inside a card is grouped with spacing, a heading, or at most a light divider - not with a second bordered box. If a block genuinely needs its own container, promote it to a sibling card rather than nesting it.

**Separate with space before you separate with lines.** There are three ways to show that two blocks are distinct, in order of preference:

1. Spacing - more space between groups than within them. This is almost always enough, and it is what a border is usually compensating for.
2. A second background tone - the same neutral one step lighter or darker. Use it for a genuinely different surface (a sidebar, a highlighted panel), not for every block.
3. A border or divider - only when the two blocks must sit flush with no room for space, such as a table edge or a list of rows.

Never apply more than one of the three to the same boundary. A block with a border AND a shadow AND a background tint is three solutions to one problem.

**A border must carry information.** It is justified when it marks a real boundary the user acts on (an input, a distinct interactive region, a table edge). A border drawn around content just to make it "look contained" carries none, so remove it. The same goes for a divider between two blocks that already have space between them.

**Shadows imply one light source.** Pick a small elevation scale (two or three levels) and use it consistently, with the light always coming from the same direction - a soft shadow offset downwards, larger and softer the higher the element sits. Never ring an element with shadow on all sides, stack several shadows on one element, or use elevation decoratively on something that is not raised above the page.

**Fewer, larger, quieter.** Prefer one padded region over four nested ones; consistent padding over per-block variation; and type weight, size and colour over outlines when establishing hierarchy. If a screen looks busy, the fix is almost always to delete containers, not to restyle them.

---

## Icon Actions (Words Only Where No Glyph Speaks)

Text in the chrome is the same problem as an extra border: it costs width, it repeats on every row, and it makes the screen slower to scan. An action that has a universally read glyph is an ICON button, not a word. Apply this by default, without being asked.

**Iconify the repeated actions.** Copy, edit, rename, duplicate, remove, delete, download/export, upload/import, refresh, share, open externally, expand/collapse, close: one icon, no label. These appear once per row or per card, so a word there is paid N times over. Take every glyph from the project's ONE icon set (never emoji, never a second library for one icon), and keep paired directions mirrored: export/download is a downward arrow, import/upload an upward one.

**An icon button is not done until it has a name.** Removing the visible word removes the meaning for anyone who cannot see or does not recognize the glyph, so replace it in the accessibility layer, always:

- `aria-label` naming the action AND what it acts on ("Remove account Work", not "Remove"). This is what a screen reader announces, and what makes a list of identical buttons distinguishable.
- `title` with the short action ("Remove") so pointer users get the hover tooltip.
- `aria-hidden="true"` on the inline SVG, so the icon is not announced twice. An `<img>` icon carries the same text as its `alt` instead.
- Keep the touch target at ~44px with padding even though the glyph is 15-16px, and keep the press state (Perceived Performance): an icon button gives less visible feedback than a labelled one, so it needs the `:active` shade more, not less.

**Keep the word when the word is doing the work.** This is a default, not an absolute. A written label stays when:

- No conventional glyph exists for the action ("Reuse session", "Log in", "Provider", "Inherit global"). An invented glyph is worse than a word, because a tooltip does not exist on touch.
- It is the primary action of a form, dialog or page ("Save changes", "Publish", "Send"), including the destructive confirm, which must name what it destroys ("Delete project 'Acme'").
- It reports state rather than triggering an action (an Enabled/Disabled toggle reads its own value).
- The design, the brief, or the user asks for a label. Their call wins.

The guardrail `fe-icon-action-button` blocks a button whose entire content is a bare action verb. For a deliberate exception, mark the line with an `enigma:` note or add `enigma:allow-text-actions` to the file.

---

## Responsive & Adaptive Layout

Build every UI to adapt to the viewport; never assume a desktop width. A layout that looks right on your screen but overlaps, overflows, or clips at another size is NOT done - responsiveness is part of the task, not a follow-up.

- Design fluid / mobile-first: use responsive units and constraints (%, rem, `fr`, `min`/`max`/`clamp`, flexbox/grid) over fixed pixel widths and absolute positioning, and let content reflow. Reserve fixed sizes for things that are genuinely fixed (icons, avatars).
- Verify at real breakpoints - narrow phone, tablet, desktop, and very wide - not only the current window. At every size: nothing overlaps, collides, or sits on top of other content, and nothing is cut off, clipped, or hidden behind another element ("no se pisan las cosas").
- No horizontal page scroll: constrain widths (`max-width: 100%`), wrap or truncate long text, and give wide content (tables, code blocks, charts, diagrams) its OWN horizontal scroll container so the page body never scrolls sideways.
- Every HTML document needs the responsive viewport meta (`<meta name="viewport" content="width=device-width, initial-scale=1">`), or it renders at desktop width on mobile.
- Media scales: images/video use `max-width: 100%` with appropriate `object-fit`; never a hardcoded width that breaks small screens.
- Touch-friendly: tap targets are large enough (~44px) with spacing that prevents mis-taps, and any hover-only affordance has a tap/focus equivalent.

---

## Persistent Chrome Stays Put (Sidebars, Nav, Panels)

Navigation and any other persistent chrome must stay where the user left it while the CONTENT scrolls. A sidebar that scrolls up and off the top with the page is one of the most common generated-layout defects, and it makes a long page unnavigable: the user has to scroll back up to reach any other link.

- Put the scroll on the content, not on the page. The reliable shape is a viewport-height shell whose sidebar and main are siblings, each owning its own overflow: `position: sticky` with a `top` offset (simplest - the sidebar stays in the grid and needs no width duplication), or a `position: fixed` sidebar with matching padding on the content. Tailwind's `sticky top-0` / `h-screen sticky` do the same thing.
- **Pinning alone is not enough, and this is the part that gets missed.** `position: sticky` only pins the element's TOP edge: as soon as the sidebar's own content is taller than the viewport, the rest keeps scrolling away with the page and the last entries can never be reached. A pinned sidebar therefore needs BOTH a height bounded by the viewport (`max-height: calc(100vh - <header height>)`, or `h-screen`) AND its own `overflow-y: auto`. A sidebar with a content-sized height (`height: max-content`, `fit-content`, or none at all) plus `overflow: visible` is the broken pattern, even though it looks correct until the list grows.
- Add `overscroll-behavior: contain` to the sidebar's scroll container so reaching its end does not start scrolling the page behind it.
- Undo it where the layout stacks. At the mobile breakpoint the sidebar usually returns to normal flow (`position: static`), and the viewport height cap has to be lifted with it (`max-height: none; overflow-y: visible`) or it turns into a small scrolling box inside the page.
- The same rule covers a sticky header, toolbar, filter rail or side panel: pinned, bounded, and independently scrollable. Keep pinned chrome shallow - it eats vertical space on small screens, so collapse it into a drawer or a top bar there rather than pinning it over half the viewport.
- Verify by scrolling to the BOTTOM of a long page and confirming the sidebar is still on screen with its last entry reachable. Mechanically: the sidebar's `getBoundingClientRect().top` stays at its offset as the page scrolls, and `scrollHeight <= clientHeight` holds for it, or it can scroll itself.

### On a phone the sidebar takes the whole screen

A sidebar keeps its desktop width only while there is a desktop to put it in. On a phone it becomes a full-screen surface, unless the design or the user says otherwise. Apply this by default to any off-canvas chrome: the nav sidebar, a filter rail, a details drawer, a settings panel.

- Full width AND full height: `w-full` (`100%`, `100vw`) with the desktop width added at a breakpoint (`w-full md:w-80`) or capped by `max-w-*`. Prefer `100dvh` over `100vh` for the height so the mobile browser's collapsing toolbar does not cut the panel off.
- A fixed width on a phone is the defect either way it lands: 320px on a 360px screen leaves a useless sliver of dead content, and anything wider than the viewport is simply cut off.
- The stacked variant counts as full width: when the layout collapses to one column and the sidebar returns to normal flow, it already spans the screen. Nothing more to do there.
- Being full screen makes it modal, so treat it as one: a visible close control, dismissal by backdrop tap and Escape, focus moved into the panel and trapped while it is open, focus restored to the trigger on close, and the page behind it locked from scrolling.
- The exceptions are real but explicit: a design that deliberately keeps a peek of the content behind, and a panel that is hidden on phones entirely because a different component serves that size. Say so in the code rather than leaving it to be read as an oversight.

---

## Links In Copy Are Links

When UI copy names a destination - a URL, a doc page, a dashboard, a settings screen, an external service - make it reachable from where it is written. Printing a bare URL as plain text in a hint, description, empty state or error message leaves the user to select and copy it by hand, which is exactly the work the interface exists to remove.

- A URL inside a sentence becomes an inline anchor on the words that name it, not a raw address dropped mid-paragraph: "Leave empty to use the [deployment default](https://example.com)" reads better than repeating the URL. Show the bare address only when the exact value is the information (a host to whitelist, an endpoint to paste elsewhere) - and then pair it with a copy button rather than expecting a manual selection.
- External links carry `target="_blank"` with `rel="noopener noreferrer"`, and say where they go when the destination is not obvious from the text. In-app destinations use the router, never a full page reload.
- Choose the affordance by weight, not by habit: an inline anchor for a reference inside a sentence, a button for the primary action of a panel or empty state ("Open dashboard"), an icon button where it repeats per row (Icon Actions above). A whole sentence is never a link - link the noun.
- The same applies to anything else with a natural affordance: a file path gets a copy button, an email gets `mailto:`, a referenced setting gets a link to that settings screen. If the copy tells the user to go somewhere, take them there.

---

## Text That Does Not Fit (Variable-Length Content)

Every string is variable-length; the value on screen during development is one sample. Text escaping its card or colliding with a neighbour is the most common layout defect, it is invisible until the content changes, and it is the responsibility of whoever writes the layout - not something to be pointed out afterwards.

- Design for the extremes of each string, not the sample: the longest realistic value (an unbounded user-supplied name, a long identifier, a full path, a big formatted number) and the shortest (empty, one character). Translations run noticeably longer than English - roughly a third more for German - so a label that only just fits is already broken.
- **A flex or grid item whose overflow is visible refuses to shrink below its content** (its automatic minimum size, `min-width: auto`). This causes most "text sticks out of its card" bugs, but not where people look for it: an element that truncates has already set `overflow: hidden`, which resolves that minimum to 0, so it shrinks by itself and does NOT need `min-width: 0`. The culprit is nearly always an **ancestor** - a flex or grid item with default overflow wrapping the truncating element. Put `min-width: 0` (Tailwind `min-w-0`) on those ancestors, and use `minmax(0, 1fr)` rather than a bare `1fr` for a grid track holding text. Confirm by measuring which box actually overflows rather than scattering `min-w-0` until it looks right.
- Decide per string whether it wraps or truncates. Truncation needs `overflow: hidden` - `text-overflow: ellipsis` does nothing without it - and the full value must stay reachable via `title`, a tooltip, or an accessible label. Never truncate a value the user has no way to recover.
- Long unbroken strings (URLs, tokens, hashes, ids, file paths) have no spaces to wrap at and will push their container wide. Use `overflow-wrap: anywhere` on those. Prefer it over `word-break: break-word`: it also lowers the element's min-content width, which is what actually stops the track being forced wider.
- Content whose width changes as it updates (counters, timers, prices) reflows its row on every tick. Use tabular numerals (`font-variant-numeric: tabular-nums`) or reserve the space.
- Absolutely positioned or overlaid text is where collisions happen, because it is outside normal flow and cannot push anything away. Constrain it with a `max-width` and check it at the narrowest breakpoint.
- Do not "fix" an overflow by clipping the parent. `overflow: hidden` on the container hides the symptom, and clips focus rings, tooltips and menus with it. Fix the sizing that caused it.
- Verify with worst-case content before calling it done: render the longest value you expect and confirm nothing spills out of its box or over a neighbour. The mechanical check is `element.scrollWidth <= element.clientWidth` for the box, and comparing bounding rectangles against the container for the collision - cheaper and more reliable than eyeballing it at one window size.

---

## State Management

- Keep state as local as possible; lift it only when genuinely shared.
- Derive values during render instead of duplicating state.
- Avoid redundant client state that mirrors server state without a reason.

---

## No-Op Detection (Skip Operations That Change Nothing)

The general rule: before running any operation, check whether its result would equal the current state. If the outcome is identical to what already exists, the operation is a no-op - skip it entirely: no request, no mutation, no event, no side effect. A form save is just the most common instance of this.

### The general rule

- Hold the current (pristine) state as a snapshot, and before acting decide whether the operation would actually change it - by comparing the resulting values against the current ones (deep/structural equality on the affected fields), not by whether the user interacted.
- If nothing would change, do not perform the operation: send no request, run no mutation, emit no event, write nothing.
- Common no-ops to skip: saving a form whose values equal the loaded ones; toggling a flag to the value it already holds; selecting the filter/sort/tab that is already active; dropping an item back into its original position; re-applying a value that is already set; a PATCH whose fields already hold those values.
- When only part changed, act on the diff, not the whole object (send only the changed fields). After a successful operation, replace the snapshot with the new state so the next comparison is correct.

### Forms & Save (the common case)

- Track the saved snapshot when the form/settings loads or after a successful save; compute dirtiness by comparing the edited values against it.
  - Example: a value goes x -> z -> back to x before saving. The net change is zero - the form is NOT dirty, and Save must send nothing to the backend.
- **Dirty means different, not touched.** Recompute the comparison on every change. Never raise a `dirty` flag from an onChange/onInput handler: a flag set by interaction stays raised after the user types a character and deletes it again, which is the exact case this rule exists for.
- **Valid is not dirty.** A Save gated only on validity ("the name is not empty", "there are no errors") still fires a no-op on a form nobody edited. Both conditions have to hold: the values differ AND they are valid.
- **Normalize before comparing**, using the same rules the field itself applies: trim surrounding whitespace, and case-fold only where the value is case-insensitive (a username usually is, a display name is not). Leading whitespace is not an edit; a different letter case may be.
- **A disabled Save must say why.** Keep it visible and disabled rather than hidden, and put the reason within reach (a `title` or one line of helper text, "No changes to save"), so the form does not read as broken. Never leave it looking enabled while it silently does nothing.
- On load the form is not dirty, so Save starts disabled; after a successful save the snapshot becomes the saved values and Save returns to disabled.
- **Autosave, blur-save and inline edits obey the same check.** On blur or after the debounce, compare against the snapshot and send nothing when the value came back to where it started.
- When the form is not dirty, Save must never hit the network. Two acceptable UX options:
  - Preferred: disable / neutralize the Save button while the edited values equal the snapshot, so there is nothing to submit until a real change exists.
  - Or keep Save enabled but short-circuit on click: show the normal "saved" confirmation instantly and send NO request. Never open a spinner or fire a call for a no-op.
  - Example: the user opens their account settings and presses Save without changing the name. The name still equals the loaded value, so the form is not dirty - the button is disabled, or the click just confirms success without a request.

### Enforce it server-side too

- The client no-op check is a UX/latency win, not the authority. The server should also short-circuit an idempotent no-op: if a mutation would set fields to the values they already hold, skip the write, the domain event, and the cache invalidation, and return the unchanged resource (the server-side rule is owned by backend-policy).

### When NOT to apply it (judgment call)

This is the default, not an absolute. Skip the no-op check and let the operation through when performing it has value on its own:

- The resource is edited concurrently by many users or updated constantly server-side, and an explicit save is meant to assert/overwrite the user's view ("last write wins" by intent).
- The operation has intentional side effects beyond persisting values: bumping `updatedAt`, re-triggering a pipeline/deploy, re-validating, or acknowledging a state.
- The client snapshot cannot be trusted to match the server (long-lived stale forms) and the save doubles as a sync.

Decide per case which mode fits; when in doubt for simple single-user forms and settings panels, apply the no-op check.

---

## Real-Time Uniqueness Against Loaded Data

When the user edits a value that must be unique within a set the client already holds in memory (the list of names, slugs, tags, emails it just rendered), validate uniqueness against that loaded data on every change instead of waiting for a server round-trip to report "already taken". The set is already loaded - reuse it (per Client-Side Caching): the user gets instant inline feedback as they type, and a redundant request (and its downstream DB query) is skipped. This is a default to apply without being asked, not a feature to wait for the user to request.

- Apply whenever duplicates are disallowed (unique names, slugs, one-per-parent constraints, "already in use", reserved values). Skip it when repeats are legitimate - never gate a value the model has no basis to treat as unique.
- Check on every change/blur and block submission while a conflict stands; surface the conflict inline, not only on submit.
- The cross-record rule itself - mirror the server's exact check (trim, case-fold, scope, reserved values), exclude the edited record's own value, and keep the server as the authority since client data can be stale - is owned by validation-policy. This client check is a UX and request-saving accelerator, never the sole validation layer.

---

## Sign-In, Sign-Up and Recovery Screens

Auth is the first screen a user meets and the one most often shipped half-built. Treat the four screens as one flow: sign in, sign up, forgot password, set a new password. The server-side rules (token lifetime, rate limits, what an answer may reveal) are owned by security-policy; what follows is the UI half.

- Every sign-in form with a password field carries a visible "Forgot your password?" link next to that field, leading to a real reset flow. Building the login screen without it is shipping a dead end.
- The reset request screen confirms in the same words whether or not the address is registered ("If that address has an account, we have sent a link"). Never render "no account with that email" - the screen would be an account-existence oracle.
- The new-password screen validates in real time against the same schema the server uses, uses the shared Input (which brings the show/hide toggle), and compares the confirmation field as the user types. Keep Submit disabled until both are valid, with the reason visible.
- After sign-up the user lands inside the app, already signed in. If the account still needs email verification, say so in the app with a way to resend, and block only the actions that need it.
- Surface throttling honestly. On a `429`, show how long the wait is (from `Retry-After`), keep the button disabled with a countdown, and never swallow the response into a generic "something went wrong".
- A one-time-code field is one input with `autocomplete="one-time-code"`, `inputmode="numeric"`, paste of the whole code, and no clearing of what the user typed on a wrong attempt. Say how many attempts are left only if the server chose to reveal it.
- Never keep a password, token, or code in `localStorage`, a query string, or an analytics payload. A reset token in the URL stays out of logs and out of any third-party script on the page.

---

## Client-Side Caching (Reduce Server Load)

Cache on the client to avoid redundant server round-trips and to keep the app usable under rate limits. The goal is to reach the backend (and therefore Redis/DB) as rarely as correctness allows.

### What and where to cache

- Cache responses that are stable, read-heavy, and not highly sensitive.
- Use the storage tier that matches the data lifetime:
  - In-memory (component/store): per-session, hot data.
  - sessionStorage: per-tab, cleared on close.
  - localStorage: cross-session data that is safe to persist on the device.
- Never store secrets, tokens, or personal/sensitive data in localStorage; treat client storage as untrusted and readable.

### Cache-first with server fallback

- Read from the client cache first. On a fresh hit, serve it and skip the network call entirely - this avoids a backend request and the downstream Redis/DB query.
- On miss or expiry, call the server, then store the response in the client cache with an explicit TTL.
- This layered model means: client cache absorbs most reads, the server cache (Redis) absorbs the rest, and the database is queried least.

### Rate-limit resilience

- When the server returns 429 / rate-limit errors, fall back to the last cached value instead of failing the UI, and back off before retrying.
- Honor Retry-After / rate-limit headers; do not hammer the server in a retry loop.
- Coalesce duplicate concurrent requests for the same resource into a single in-flight call (request deduplication).

### Invalidation (mandatory)

- Every cached entry must have an explicit TTL and/or invalidation trigger; never cache without an invalidation plan.
- Invalidate or update the client cache immediately after a mutation that changes the cached data.
- Prefer stale-while-revalidate for non-critical data: serve cached, refresh in the background.
- Never serve stale data for security-, money-, or correctness-critical reads.

---

## Instant First Paint (Shell First, Data Async)

Render the page shell immediately; never block the first paint on data. A view that fetches everything before it renders anything looks frozen until the slowest request returns - the user stares at a blank screen. Paint the static structure (nav, headings, card frames, table chrome, stat-tile outlines) on the first tick, then fill each region as its data arrives.

- Load data asynchronously via the API AFTER the shell renders (client fetch on mount, or streaming/Suspense on server components) - do not gate the component's first render on the awaited data. The layout is static and free to render now; only the contents wait.
- Show skeleton placeholders shaped like the real content in every region still loading (cards, rows, charts, stat tiles), not one full-page spinner. Reserve the final dimensions so nothing shifts when data lands (no layout shift / CLS).
- This applies to ANY data-driven view - dashboards, panels, detail pages, settings screens - not only long lists. A dashboard of independent widgets renders its grid instantly and lets each widget resolve on its own (see Progressive / parallel rendering below).
- For an instant first paint with REAL content, read the client cache first (per Client-Side Caching) and render it immediately, then revalidate in the background (stale-while-revalidate); fall back to skeletons only on a cold cache.
- Keep empty and error states per region, so a single failed or slow widget shows its own inline state without blanking the whole page.

---

## Large Lists & Progressive Loading

Never render an unbounded or large dataset in one shot (no fetch-everything then map over thousands of rows). Lists of products, feeds, search results, logs, etc. must load incrementally and keep the rendered DOM bounded.

### Choose a load strategy per case

- Infinite scroll (default for feeds, large or unknown-size sets, and exploratory browsing): fetch one page at a time as the user nears the end, using keyset/cursor paging (per backend-policy / database-expert), not offset for deep lists.
  - It MUST be virtualized/windowed once the list grows: render only the viewport plus a small buffer and recycle offscreen rows so a long session (a user scrolling for an hour) does not accumulate thousands of nodes and lag. Drop far-offscreen items from the DOM and restore them on scroll-back, preserving scroll position (the TikTok model: only a handful of items live in the DOM at once).
  - Only start dropping/recycling once there is genuinely a lot rendered or the context demands it; do not over-engineer it for a small list.
- Pagination (when users need to jump to or deep-link a specific page, the set is bounded, totals/position matter, or results must be SEO-indexable): classic page controls backed by efficient server paging.
- Pick whichever fits; do not infinite-scroll a 30-row admin table or paginate a social feed. A short, bounded list needs neither - just render it (anti-overengineering-policy).

### Skeletons while loading

- Show skeleton placeholders that mirror the final layout while data loads, not bare spinners for content areas, and reserve the space so content does not shift in (avoid layout shift / CLS).
- Empty and error states are still handled explicitly for every async view (see Accessibility & Resilience).
- To avoid hand-drawing and re-maintaining skeleton markup, you can generate skeletons automatically from the real rendered UI with `boneyard-js` (supports React, Preact, React Native, Svelte, Vue, Angular). Wrap a region in its `<Skeleton name="..." loading={...}>` component, run `npx boneyard-js build` once to capture the live DOM into responsive JSON "bones" (committed under `src/bones/`), and import the generated registry at the app entry. It produces pixel-perfect, zero-CLS placeholders with a small runtime (~7.5KB for React) and stays in sync with the layout via re-builds - preferable to bespoke skeleton components when a view's markup changes often. A hand-built skeleton is still fine for a one-off or tiny placeholder (anti-overengineering-policy); reach for the generator when there are many regions or the layout churns.

### Progressive / parallel rendering

- Never block the whole view on one slow aggregate request. Fetch independent sections in parallel and render each the moment its own data arrives (per-section skeletons; streaming/Suspense where the framework supports it), so the page becomes useful incrementally instead of waiting on the slowest query. Splitting the server work is owned by backend-policy.

### Short-TTL caching for fetched pages

- Cache fetched lists/pages briefly so quick navigations, the back button, and tab switches do not refetch. Tune the TTL to how fast the data changes - on the order of ~30s for typical lists, longer for stable catalogs, near-zero for fast-moving or correctness-critical data. Use the Client-Side Caching rules above (explicit TTL, stale-while-revalidate, invalidate on mutation, never serve stale money/security/correctness reads).

---

## Optimistic UI & Rollback

- Use optimistic UI updates when the operation is safe and likely to succeed.
- Always implement rollback handling for failed operations.
- Reconcile optimistic state with the server response; never leave the UI in a divergent state.
- Keep the optimistic update and any client cache consistent with each other.
- Surface failures to the user clearly without exposing internal error details (see validation-policy).

---

## Destructive & Irreversible Actions (Confirm Before Doing)

Guard every destructive action behind friction proportional to how bad an accidental trigger would be. Never wire a permanent destroy straight to a button's `onClick` with no confirmation - a one-click "delete forever" is a footgun.

- Reversible / low-stakes destroy (remove a row, delete a draft, clear a field): prefer acting immediately with an Undo affordance over a confirmation prompt - soft-delete and show a "Deleted - Undo" toast (optimistic, with rollback per Optimistic UI). The common case gets zero friction and a mistake is one click to recover. Reach for undo before a confirm whenever the delete can actually be reversed.
- Standard destructive action (delete an item, remove a member, revoke a key): show a confirmation dialog that NAMES the exact thing being deleted ("Delete project 'Acme'?"), states the consequence, and uses a destructive-styled confirm button. It must be a real dialog/modal component, never the native `confirm()` (see the No-Op / native-dialog rules and the `fe-no-native-dialog` guardrail); default focus to Cancel and let Escape dismiss.
- Critical / irreversible action (delete a repository, organization, account, or workspace; drop a database; transfer ownership; wipe production data): require a type-to-confirm step. The user must type the exact resource identifier (the repo/org name, or an explicit phrase like "delete my account") into an input, and the confirm button stays disabled until the typed value matches EXACTLY (trimmed, case-sensitive comparison against the real name). This is the GitHub / Vercel / Stripe "danger zone" pattern: it forces the user to read what they are about to destroy and makes an accidental click impossible.

Scale the friction to the blast radius: do NOT make a trivial single-item delete demand typing a name (that is needless friction, anti-overengineering-policy), and NEVER leave an account-, repo-, or data-destroying action behind a single unconfirmed click. A named confirmation dialog is the floor; type-to-confirm is the ceiling for the truly unrecoverable. When in doubt about which tier applies, ask how recoverable the action is: recoverable -> undo, destructive-but-scoped -> confirm dialog, irreversible/high-blast-radius -> type-to-confirm.

---

## Perceived Performance & Responsiveness

Make the dashboard FEEL instant: acknowledge every interaction immediately and push the slow work off the critical path. Combine these with Instant First Paint, Client-Side Caching, and Optimistic UI above.

- Instant interaction feedback: respond to every click/keystroke in under ~100ms (button press state, inline value change, row highlight) even while the real work is still running. A control must never feel dead while a request is in flight; keep expensive updates off the main thread (e.g. React's `startTransition`/`useTransition`) so typing and clicking stay smooth.
- Prefetch on intent: warm the data for the next likely view before the user commits - on hover/focus of a nav item or row, when a tab becomes visible, or as a row scrolls into view. Prefetch into the client cache (per Client-Side Caching) so the actual navigation reads a warm cache and paints instantly. Do not prefetch everything eagerly - only the high-probability next step.
- Debounce and throttle user-driven work: debounce inputs that trigger a query (search, filter, autosave) so a request fires only after the user pauses (~200-300ms), not per keystroke; throttle high-frequency events (scroll, resize, pointer-move, drag) to at most one run per frame. This cuts redundant requests and the re-renders that make the UI stutter.
- Cancel stale in-flight requests: when inputs change or the component unmounts, abort the previous request (AbortController, or the data library's cancellation) so a slow earlier response cannot land after - and overwrite - a newer one (an out-of-order race that shows stale data). Guard async results by the request they belong to before applying them.
- Avoid request waterfalls: start independent requests in parallel, never one-after-another. Do not fetch in a child that only renders after a parent's fetch resolves when both could start at once - hoist and fire them together (`Promise.all`, parallel queries, route loaders). Reserve sequential awaits for genuinely dependent data. (Splitting the server work is backend-policy; per-section streaming is Instant First Paint.)
- Defer heavy, offscreen widgets: code-split and lazy-load large or below-the-fold dashboard pieces (charts, editors, rarely-opened panels) so the initial bundle and first paint stay small; load them on demand or as they near the viewport.

---

## Dates & Timestamps

Render dates and timestamps as localized, auto-updating values. Do not hand-roll formatting (`new Date().toLocaleString`, ad-hoc "X ago" math) scattered across components, and do not pull in a heavy date library just to display a time.

- On the web, use the `<relative-time>` element (`@github/relative-time-element`, MIT, dependency-light): `<relative-time datetime="<ISO-8601>">fallback text</relative-time>`. It renders relative phrasing that updates itself ("3 minutes ago" -> "4 minutes ago"), localizes to the user's timezone and locale via `Intl`, is accessible, and works server-rendered with a graceful no-JS fallback (the slotted text is what the server caches). Switch relative vs. absolute with `format`, `tense`, `precision`, and `threshold`, and style it through `::part(root)`.
- Keep the raw ISO-8601 / UTC value in data and state; localize only at the render boundary. Never store or compare pre-formatted date strings.
- Where a custom element is not available (React Native, non-web surfaces), centralize formatting in one shared helper built on the platform `Intl` APIs rather than repeating format calls, and keep the same "store UTC, localize at render" rule.

---

## Search & Filtering

For a user-facing search box or finder over a list, use fuse.js (fuzzy search) rather than a hand-rolled `.toLowerCase().includes()` filter. Fuzzy matching tolerates typos and partial or transposed input and ranks results by relevance - which is what users expect from a search field; a raw substring filter misses "usnig" for "using" and cannot rank. Apply it by default without being asked whenever the input is a free-text search.

- Reach for fuse.js whenever the input is a search/filter box the user types free text into. Keep a plain equality/predicate filter only for exact, structured filtering (a status dropdown, a tag toggle) where fuzziness would be wrong.
- Configure the searched `keys` and a sensible `threshold`, and run the search over the already-loaded client list where possible (reuse the data, per Client-Side Caching) before falling back to a server query.

---

## AI Chat & Agent Interfaces

When building a chat, assistant, or agent UI in React, use **AI Elements** (Vercel, Apache-2.0 - https://elements.ai-sdk.dev/components) instead of hand-rolling the surface. Chat UI has a long tail of details that look trivial and are not: sticking the scroll to the bottom only while the user has not scrolled away, rendering markdown whose code fence is still unclosed mid-stream, message parts that arrive out of order, reasoning and tool-call panels, citation rendering, and an input that handles attachments, submit-vs-newline, and a streaming stop button. Rebuilding that per project is where the time goes, and the hand-rolled version is usually the janky part of the product.

- It is a **shadcn/ui registry, not a runtime dependency**: `npx ai-elements@latest add <component>` copies the component SOURCE into `@/components/ai-elements/`, so it is yours to edit and restyle with no version lock-in. This is the vendoring preference in dependency-policy, not a new dependency to justify.
- Prerequisites: React with Tailwind CSS in CSS-variables mode, shadcn/ui initialized (`npx shadcn@latest init`), and the AI SDK. The components are typed against AI SDK message parts and pair with `useChat`.
- Add only the components actually used. Bare `npx ai-elements@latest` installs the whole registry and drags in every peer dependency (shiki, `@xyflow/react`, media-chrome, rive, ...) - do not pull 40+ components in for one message list (anti-overengineering-policy).

### What already exists (do not rebuild these)

- Chat shell: `conversation`, `message`, `prompt-input`, `suggestion`, `attachments`, `context`, `persona`, `panel`, `toolbar`, `controls`, `queue`, `checkpoint`, `confirmation`, `open-in-chat`.
- Model work: `reasoning`, `chain-of-thought`, `tool`, `task`, `plan`, `agent`, `artifact`, `shimmer`.
- Rendered content: `code-block`, `snippet`, `image`, `jsx-preview`, `schema-display`, `file-tree`, `terminal`, `stack-trace`, `test-results`, `web-preview`, `sandbox`, `commit`, `package-info`, `environment-variables`.
- Citations: `sources`, `inline-citation`. Voice: `speech-input`, `transcription`, `audio-player`, `mic-selector`, `voice-selector`. Models: `model-selector`. Graph: `canvas`, `node`, `edge`, `connection`.

### Boundaries

- This is a React + Tailwind + shadcn library. If the project is Vue, Svelte, Angular, React Native, or plain HTML, or has no Tailwind/shadcn, do NOT bolt that toolchain on to get it - build natively and borrow the composition model instead (a container owning scroll-stick-to-bottom, a message that renders parts by type, a separate prompt input, streaming state held outside the bubble).
- Once installed they are ordinary project components: the Component Reuse rules above still apply - configure variants through props, and never fork a second copy per screen.
- A single static message list with no streaming does not need the library. Match the tool to the problem.

---

## Accessibility & Resilience

- Use semantic markup and accessible interactive elements by default.
- Handle loading, empty, and error states explicitly for every async view.
- Validate user input in real time per validation-policy; never rely on the UI as the only validation layer.
- When a select/dropdown/radio group (or any single-choice control) resolves to exactly one option, preselect it by default so the user is not forced to open a menu to pick the only possibility; disable the control when that single option is fixed. This applies whenever the set narrows to one, including after filtering or an async load.

---

## React Code Health Audit (react-doctor)

- Periodically audit React code with React Doctor, a fast static analyzer that scores the codebase across performance, security, correctness, accessibility, bundle size, and architecture (60+ rules, framework-aware: Next.js, Vite, React Native, Expo, ...). It is purpose-built to catch the bad React that agents tend to write.
- Run it from the project root; no install needed:
  - `npx -y react-doctor@latest .`
- When to run it:
  - Occasionally during React work, and as a final sanity check before committing a non-trivial React change.
  - After large refactors, or when touching performance-sensitive components.
- It is an advisory audit, not a gate: read the findings, fix the high-value issues (real performance, correctness, or accessibility problems), and skip noise that does not apply. Never block delivery on the score alone.
- Review anything it proposes to auto-fix as a normal diff before keeping it; do not apply changes blindly (treat tool output as untrusted per security-policy).
- It runs locally and analyzes read-only by default. Rules for wiring it into CI as a deterministic gate live in dependency-policy and testing-policy.