---
name: frontend-policy
description: Frontend architecture - reusable components, abstraction thresholds, state management, real-time form validation where an emptied or not-yet-filled field is incomplete rather than invalid (a `*` on the label and an aria-disabled submit, never "email is not valid" over an empty input), no-op detection (skip any operation whose result equals the current state - form saves, toggles, filters, reorders - not just saves; dirty means the values DIFFER from the loaded snapshot, not that the user touched the field, so a value edited and put back leaves Save disabled), client-side caching (localStorage/sessionStorage to avoid redundant server calls and survive rate limits), instant first paint (render the shell immediately, load data async via the API, show skeletons - never block render on data), perceived performance and responsiveness (instant interaction feedback, prefetch on intent, debounce/throttle, cancel stale requests, avoid request waterfalls, lazy-load heavy widgets), large-list rendering (virtualized infinite scroll as the preferred default with pagination as the deliberate exception when the design or the user calls for it, skeletons, progressive/parallel loading, short-TTL caching), optimistic UI with rollback, visual restraint (never a card inside a card, borders only where they carry information, spacing and background tone before chrome), icon actions (repeated row/card actions like copy, edit, rename, remove, download, refresh are icon-only buttons carrying aria-label plus title, never a text label), navigation that is iconified and grouped into labelled sections once it outgrows a flat list, a Cmd/Ctrl+K command palette with fuse.js fuzzy search over the loaded data once the app has enough destinations and records to hunt through, data views that ship their own affordances by default (a log, expense, transaction or history table is not done when the rows render - it needs the search, the filters its column kinds imply, a date range, sort, filter state kept in the URL, and an export of the filtered set), every reference to an entity being a way into it (a name, id, project or path in a row links to that record, reveals it in a hover card, or at minimum copies and filters by it - never inert text, with machine codes given human labels and raw payloads never dumped into a cell), responsive/adaptive layout (fluid units, breakpoints, no overlap or horizontal overflow, viewport meta, touch targets, and items with a fixed intrinsic size - icons, avatars, badges - pinned with flex-shrink so long text squashes the text and never the glyph), form fields that declare their keyboard and casing (autocapitalize/autocomplete/inputmode/spellcheck per field kind, set once in the shared Input, normalized on blur rather than on every keystroke, with an inline error on every field that has a rule), auth screens (breached-password feedback, strength meter, cookie consent answered before login/register, and a fixed-length 2FA or emailed code that verifies itself when the last digit lands, once per distinct value and never re-firing into the attempt cap), AI chat/assistant/agent interfaces (use Vercel's AI Elements registry for message threads, streaming, reasoning and tool-call panels, prompt inputs - never hand-roll chat UI in React), and periodic React code-health audits (react-doctor). Use when building or changing UI components, client state, forms/save flows, data fetching/caching, lists that show lots of data, a log/activity/expenses/transactions/history table, loading states, dashboards/panels, layout/responsiveness, making the UI feel fast, building a chat/AI/agent/LLM interface, or any frontend structure.
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

## Headless Primitives Before Hand-Rolled Interaction

- Interaction logic - looping/draggable rows, momentum, focus traps, virtualized lists, dismiss timers, read caches - is BEHAVIOR, and behavior that has already been measured and tested is a dependency, not a snippet to rewrite. Check the catalogue before writing it: `enigma add` lists it and `enigma add <name>` adds it as a DEPENDENCY, which is how you use these - the package keeps getting fixes and a dependency is how they reach the project. `--copy` vendors the source and freezes it at that version; reach for it to EDIT a component, never as the normal way to add one.
- These primitives ship NO visual styles. They apply only what the behavior requires (overflow, touch-action, user-select, will-change, transform) and publish their state as `data-*` attributes, so the look stays entirely yours.
- Do not hand-roll one of them "just for this page". The hand-rolled version is where the measured bugs come back: a duration-driven marquee that accelerates as items are added, a `setPointerCapture` drag that silently stops every link in the row from opening, a hover slowdown that sticks forever after the first tap because touch never fires `pointerleave`.
- THE CATALOGUE, so you never have to guess whether one exists. `enigma add <name>` adds it as a dependency:
  - `input` - one field for every `type`: password (reveal, generator, strength meter, breach check), search (debounce, ranking, clear), color (swatch, saturation square, hue and alpha rails, presets, eyedropper), and everything else as a plain field with native props.
  - `select` - a listbox that replaces the native one: typeahead, disabled rows the arrows walk past, one highlight shared by pointer and keyboard, a panel that measures before it opens, multi-select tags, a hidden input so the form can submit it.
  - `palette` - the Ctrl/Cmd+K panel: one flat keyboard sequence across groups, a highlight that wraps and that a shorter list pulls back, `aria-activedescendant` so the caret never leaves the field, recents guarded against a storage that throws.
  - `toast` - notifications whose timer pauses on hover, on focus and on a hidden tab, with promise toasts and actions.
  - `context-menu` - the right-click menu with the desktop's behaviour: submenus on a beat, a panel that flips at the window edge, Escape, arrows, Shift+F10, shortcuts printed for the reader's platform.
  - `selection` - Explorer's selection model: anchor and cursor, Shift, Ctrl, Ctrl+Shift, a rubber band, arrow keys, and delete/rename/open reported as commands.
  - `button` - press states, async pending, cooldowns, and a shortcut badge; `marquee` and `logo-marquee` - a looping row that takes px/s and measures its own lap; `search` - the engine behind a field or a page; `flags` - a country flag as an image, never an emoji; `relative-time` - "3 minutes ago" that updates itself; `network` - online/offline and connection quality; `notifications` - the queue under the toast, for a renderer of your own.
- Five of them are already deterministic: `fe-select-hand-rolled`, `fe-toast-hand-rolled`, `fe-palette-hand-rolled`, `fe-context-menu-hand-rolled` and `fe-selection-hand-rolled` block the hand-rolled version at the moment it is written, and each message names the defects the primitive fixed. Reading the message is faster than rediscovering them.
- If the catalogue has no primitive for what you need, write it as one (core + adapter + registry entry + test) rather than inline in a page, so the next screen reuses it instead of rewriting it.

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

## Navigation Is Structured, Not A Growing List

A sidebar gets one more entry per feature and nobody ever goes back to reorganize it, so it ends as a flat column of a dozen similar words that has to be read top to bottom every time. Structure it as it grows, by default and without being asked: the icons, the grouping and the ordering below are part of building the nav, not a redesign to propose afterwards.

**Every entry carries an icon.** One icon set for the whole nav, one size, aligned in a single column so the labels line up. The glyph is what the eye aims at once the user knows the app, and it is what makes a collapsed rail possible later. Choose it for what the destination IS, not for the word in the label: a gauge for a dashboard, a key for credentials, sliders for settings. When no glyph reads for an abstract destination, take the set's neutral placeholder rather than a loose near-match - a wrong icon is read as a different feature.

**The label stays.** This is the opposite call from Icon Actions above, and the difference is repetition: a row action repeats per row and its glyph is conventional, while a nav entry appears once and names a place the user may never have visited. Icon plus word, and the icon takes `aria-hidden="true"` because the label is already the accessible name.

**Group once the list passes about seven entries.** Labelled sections of related destinations, with the label a quiet uppercase or muted heading rather than another bordered box (Visual Hierarchy above). Order the groups and the entries inside them by how often they are used, never alphabetically - alphabetical order is the one arrangement that guarantees the daily destination is somewhere in the middle. Account, billing and sign out sit apart at the bottom, separated by space.

**Mark the active entry with more than colour**: a filled background or a leading bar plus `aria-current="page"`, so it survives a colourblind user and a screen reader. A group holding the active entry stays expanded.

**Collapsible groups persist their state.** If a section can be collapsed, remember the choice per user (localStorage is enough) and restore it on the next visit; a nav that reopens every group on every navigation is worse than one that never collapsed.

**Nav is not the only way in.** Past roughly a dozen destinations, grouping stops being enough and the user starts hunting: add the command palette from Search & Filtering below. Structure narrows the hunt; search ends it.

---

## Links In Copy Are Links

When UI copy names a destination - a URL, a doc page, a dashboard, a settings screen, an external service - make it reachable from where it is written. Printing a bare URL as plain text in a hint, description, empty state or error message leaves the user to select and copy it by hand, which is exactly the work the interface exists to remove.

- A URL inside a sentence becomes an inline anchor on the words that name it, not a raw address dropped mid-paragraph: "Leave empty to use the [deployment default](https://example.com)" reads better than repeating the URL. Show the bare address only when the exact value is the information (a host to whitelist, an endpoint to paste elsewhere) - and then pair it with a copy button rather than expecting a manual selection.
- External links carry `target="_blank"` with `rel="noopener noreferrer"`, and say where they go when the destination is not obvious from the text. In-app destinations use the router, never a full page reload.
- Choose the affordance by weight, not by habit: an inline anchor for a reference inside a sentence, a button for the primary action of a panel or empty state ("Open dashboard"), an icon button where it repeats per row (Icon Actions above). A whole sentence is never a link - link the noun.
- The same applies to anything else with a natural affordance: a file path gets a copy button, an email gets `mailto:`, a referenced setting gets a link to that settings screen. If the copy tells the user to go somewhere, take them there.

---

## Every Reference To An Entity Is A Way Into It

A table, log, activity feed or detail panel is full of values that NAME something the app already knows about: the user who performed the action, the project it happened in, the run it belongs to, the file it touched, the account it was billed to. Rendered as inert text, each one is a dead end - the reader now knows a name and can do nothing with it, so they go hunting through the nav for that same record by hand. That is precisely the work the screen existed to save. Wire the affordance while building the view; waiting to be asked for it costs the user a round trip for something that was always obviously needed.

- **If the app has a page for it, the value is a link to that page.** An actor column showing a person's name opens that user; a project name opens the project; a run id opens the run; a file path opens the file.
- **If there is no page but there is more to know, reveal it in place**: a hover card or popover with the essentials (full name, avatar, role, last seen), a click-to-expand row for the underlying payload, a tooltip carrying the full value behind a truncated one. Not every reference deserves a route, but none deserves to be inert.
- **If there is genuinely nothing behind it, make it operable anyway**: a copy button on an id, hash, IP or path, and a click that filters the view to that value ("everything this user did"), which is where this meets the filters above.
- **Translate machine values.** A code like `enrollment.cancel` or `runner.pool.delete` gets a human label, and a raw JSON payload is rendered as fields or collapsed behind a toggle - never dumped as a blob into a cell where it wrecks the row height and tells the reader nothing.
- **A timestamp is both forms**: relative for reading ("2 hours ago") with the exact localized value available on hover, per Dates & Timestamps above.

The check to run while building, not afterwards: go column by column and ask what the reader wants to do NEXT with that value. If the answer is "find out more about that thing" or "see the others like it", the cell needs an affordance now.

---

## Text That Does Not Fit (Variable-Length Content)

Every string is variable-length; the value on screen during development is one sample. Text escaping its card or colliding with a neighbour is the most common layout defect, it is invisible until the content changes, and it is the responsibility of whoever writes the layout - not something to be pointed out afterwards.

- Design for the extremes of each string, not the sample: the longest realistic value (an unbounded user-supplied name, a long identifier, a full path, a big formatted number) and the shortest (empty, one character). Translations run noticeably longer than English - roughly a third more for German - so a label that only just fits is already broken.
- **Ask both questions before laying anything out, not after the bug report.** (1) Is this string translated? If the project has i18n, every label is variable-length by definition, and the English sample is usually the shortest one it will ever be - so a fixed-width column, a `whitespace-nowrap` label or a button sized to its current text is already a defect in the other locales. (2) Is this value data? A name, email, title, description, path, URL, filename or anything else a user or an API supplies has no length limit worth trusting, and it is exactly the value that runs long in production and never in the sample. Those two answers decide the layout: what wraps, what clips, what gets `shrink-0`, and what needs a minimum width.
- Fixed copy you wrote yourself is the only text you may size a box around. Everything else gets room to grow, a place to wrap, or a clip with the full value kept reachable.
- **A flex or grid item whose overflow is visible refuses to shrink below its content** (its automatic minimum size, `min-width: auto`). This causes most "text sticks out of its card" bugs, but not where people look for it: an element that truncates has already set `overflow: hidden`, which resolves that minimum to 0, so it shrinks by itself and does NOT need `min-width: 0`. The culprit is nearly always an **ancestor** - a flex or grid item with default overflow wrapping the truncating element. Put `min-width: 0` (Tailwind `min-w-0`) on those ancestors, and use `minmax(0, 1fr)` rather than a bare `1fr` for a grid track holding text. Confirm by measuring which box actually overflows rather than scattering `min-w-0` until it looks right.
- Decide per string whether it wraps or truncates. Truncation needs `overflow: hidden` - `text-overflow: ellipsis` does nothing without it - and the full value must stay reachable via `title`, a tooltip, or an accessible label. Never truncate a value the user has no way to recover. Clipping and hiding are one keystroke apart: `<span className="truncate">{user.email}</span>` shows `alberto.rodriguez@lo...` and offers no way to ever see the rest. Add `title={user.email}` in the same edit, or reach for the design system's tooltip where it has one.
- Long unbroken strings (URLs, tokens, hashes, ids, file paths) have no spaces to wrap at and will push their container wide. Use `overflow-wrap: anywhere` on those. Prefer it over `word-break: break-word`: it also lowers the element's min-content width, which is what actually stops the track being forced wider.
- Content whose width changes as it updates (counters, timers, prices) reflows its row on every tick. Use tabular numerals (`font-variant-numeric: tabular-nums`) or reserve the space.
- Absolutely positioned or overlaid text is where collisions happen, because it is outside normal flow and cannot push anything away. Constrain it with a `max-width` and check it at the narrowest breakpoint.
- Do not "fix" an overflow by clipping the parent. `overflow: hidden` on the container hides the symptom, and clips focus rings, tooltips and menus with it. Fix the sizing that caused it.
- **The other half of the same rule: some flex items must NOT shrink.** `flex-shrink: 1` is the default, so in a row of icon plus text the browser takes width from BOTH when the text runs long - and the icon, having no content to reflow, is simply squashed. The result is the 14px chevron or external-link glyph rendered 4px wide next to a long product name, which nobody notices while the sample text is short. Anything with a fixed intrinsic size - icon, avatar, badge, status dot, spinner, checkbox, the action button at the end of a row - takes `flex-shrink: 0` (Tailwind `shrink-0`, or `flex: none`). The TEXT is the element that gives up width, and it truncates or wraps as decided above.
- An explicit `width`/`height` on the icon does not protect it: those set the base size, not the minimum, and flex shrinks below it. An `<svg>` scales with its viewBox rather than clipping, which is exactly why it deforms silently instead of overflowing visibly. Set the guard where the icons are defined - one `svg { flex-shrink: 0 }` in the base stylesheet, or `shrink-0` inside the shared Icon component - rather than remembering it per row.
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
- **A blocked Save must say why.** Keep it visible and blocked rather than hidden, and put the reason within reach (a `title` or one line of helper text, "No changes to save"), so the form does not read as broken. Block it with `aria-disabled="true"` rather than the `disabled` attribute - a `disabled` button is out of the tab order, so the very `title` carrying the reason is unreachable by keyboard - and short-circuit in the handler. Never leave it looking enabled while it silently does nothing.
- On load the form is not dirty, so Save starts blocked; after a successful save the snapshot becomes the saved values and Save returns to blocked.
- **Autosave, blur-save and inline edits obey the same check.** On blur or after the debounce, compare against the snapshot and send nothing when the value came back to where it started.
- When the form is not dirty, Save must never hit the network. Two acceptable UX options:
  - Preferred: neutralize the Save button (`aria-disabled`, per the rule above) while the edited values equal the snapshot, so there is nothing to submit until a real change exists.
  - Or keep Save enabled but short-circuit on click: show the normal "saved" confirmation instantly and send NO request. Never open a spinner or fire a call for a no-op.
  - Example: the user opens their account settings and presses Save without changing the name. The name still equals the loaded value, so the form is not dirty - the button is blocked, or the click just confirms success without a request.

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

## Every Field Declares Its Keyboard And Its Casing

A text input is not generic. What it holds decides the keyboard a phone opens, whether the first letter arrives capitalized, and whether autocorrect rewrites it. Left unset, the mobile defaults produce "juan perez" in a name field and a spell-checked handle in the next one.

- Person name (full name, first, last): `autocapitalize="words"`, the matching `autocomplete` token (`name`, `given-name`, `family-name`), `spellcheck="false"`, `autocorrect="off"`. Phone keyboards capitalize SENTENCES by default, which capitalizes only the first word of the name.
- Email: `type="email"`, `autocomplete="email"`, `inputmode="email"`, `autocapitalize="none"`, `spellcheck="false"`.
- Username, handle, slug, coupon, licence key: `autocapitalize="none"`, `autocorrect="off"`, `spellcheck="false"`.
- URL or profile link: `inputmode="url"`, `autocapitalize="none"`, `autocorrect="off"`.
- Phone: `type="tel"`, `inputmode="tel"`, `autocomplete="tel"`. Numeric code: `inputmode="numeric"`, `autocomplete="one-time-code"`.
- Free prose (bio, message, description): `autocapitalize="sentences"` with spellcheck left on.
- Set `enterkeyhint` where the key does something specific (`search`, `send`, `done`), and mark the search field `type="search"`.
- `type="search"` brings a clear cross that only WebKit draws. Kill it (`::-webkit-search-cancel-button { appearance: none; }`) in the shared stylesheet and render your own clear button if you want one: left in, Safari and Chrome users get two crosses side by side and everyone else gets one, which is a control that exists on some machines and not others.

Where this lives and when it runs:

- Put the whole matrix in the shared Input/TextField component, chosen by one prop (`kind="name" | "email" | "handle" | ...`), so a new form gets it by construction. A form that spells out attributes per field will forget them; that is how the defect ships.
- The attribute only shapes what the keyboard offers. Normalize the value as well - trim, collapse inner spaces, capitalize each word of a name, lowercase an email - using the shared normalizer from validation-policy, and let the server apply the same one.
- Normalize on BLUR and before save, never on every keystroke: rewriting the value under the caret moves the cursor and breaks IME composition mid-word. While the field has focus, show what the user typed; on blur, show what will be stored.
- Validate the normalized value, so a trailing space the user has not finished typing never renders as an error.
- Show the error inline as the user types, from the first blur onward, on EVERY field that has a rule, and keep Save blocked while any field is invalid. Validating the email and leaving the link, the phone and the handle next to it silent is the usual half-built form.
- An EMPTY field is incomplete, not invalid: clearing an input drops its error instead of turning it into "Email is not valid". Requiredness is shown structurally - a `*` on the label, a legend for the marker, and a submit that refuses to send until the required fields hold a value (`aria-disabled`, not the `disabled` attribute, so it keeps its place in the tab order and can announce what is missing; the type-to-confirm step of an irreversible destroy is the one exception and stays on native `disabled`, per the destructive-action tiers below) - and the format error appears only once there is a value to be wrong. The states, the transitions and the schema shape behind them are validation-policy's "Empty is not invalid".

---

## A Textarea Is Bounded At Both Ends

A textarea is the only input the user can resize, so it is the only one whose size can break a layout after the page has rendered. Give every textarea a floor and a ceiling; the `fe-textarea-size-bounds` guardrail blocks a new one that has neither.

- Floor: `rows` (or a `min-height`) so it never collapses to a line and a half. A bare `<textarea>` defaults to about two rows and can be dragged smaller than the text it holds.
- Ceiling: a `max-height`, so dragging the handle cannot push the rest of the page off the screen. Past the ceiling the textarea scrolls its own content; the page does not grow.
- Prefer `resize: vertical` over free resize: horizontal dragging escapes the column and breaks a form grid that everything else respects. `resize: none` is acceptable only when the size is genuinely fixed, and it removes an affordance the user expects, so do not reach for it first.
- An autosizing textarea (`field-sizing: content`, a `scrollHeight` assignment, an autosize package) MUST carry the ceiling: growing with content is exactly the case where a long paste otherwise pushes the submit button out of reach.
- Put the bounds on the shared Textarea component or one base rule, not on each usage. A per-usage fix is one component away from being forgotten, and the rule is cleared by any bound in the file precisely so the base fix is the one that scales.
- The exceptions, and they are real: a surface that owns its viewport (a full-page editor, a code or log pane sized to its container) and any case the design deliberately calls otherwise. Mark that line `enigma:allow-unbounded-textarea` so the intent is recorded rather than re-litigated.

---

## Sign-In, Sign-Up and Recovery Screens

Auth is the first screen a user meets and the one most often shipped half-built. Treat the four screens as one flow: sign in, sign up, forgot password, set a new password. The server-side rules (token lifetime, rate limits, what an answer may reveal) are owned by security-policy; what follows is the UI half.

- Every sign-in form with a password field carries a visible "Forgot your password?" link next to that field, leading to a real reset flow. Building the login screen without it is shipping a dead end.
- The reset request screen confirms in the same words whether or not the address is registered ("If that address has an account, we have sent a link"). Never render "no account with that email" - the screen would be an account-existence oracle.
- The new-password screen validates in real time against the same schema the server uses, uses the shared Input (which brings the show/hide toggle), and compares the confirmation field as the user types. Keep Submit blocked with `aria-disabled` until both are valid, with the reason visible.
- Wherever a password is created (sign-up, reset, change), check it against Have I Been Pwned's Pwned Passwords range API as the user types - debounced, request aborted when the value changes - and refuse a breached one with "This password appeared in a data breach. Choose a different one." Free, no key, and the password never leaves the browser: only the first 5 characters of its SHA-1 do (mechanics and the server-side half in security-policy).
- The same screens refuse a password built out of the identity it protects: the email, its local part, the username, the display name, the site name. Compare normalized values (lowercased, accent-stripped, punctuation dropped) so `F.J.R.G_2007` and `fjrg2007` are one string, and check containment and near-matches, not just equality (the rule and the server half are security-policy's). The form already holds the email and the name the user just typed, so run it on every keystroke and name the reason inline: "Your password cannot contain your email address or username."
- Next to it, a strength meter: a row of segments that fills and shifts colour (red, amber, green) with a one-line verdict. Drive it from an entropy estimator (`@zxcvbn-ts/core`), fed the user's own email and name as context, not from a regex counting character classes - "Passw0rd!" satisfies every class rule and is guessed instantly. The meter is advisory; the length floor and the breach check are the gate.
- The consent banner is answered before either form submits (security-policy owns the cookie rules). Blocking the account on a "reject" is not the ask: record the choice, then continue.
- After sign-up the user lands inside the app, already signed in. If the account still needs email verification, say so in the app with a way to resend, and block only the actions that need it.
- Surface throttling honestly. On a `429`, show how long the wait is (from `Retry-After`), keep the button `aria-disabled` with a countdown - not the `disabled` attribute, which drops the button out of the tab order and takes the countdown next to it out of reach of the keyboard and screen-reader user who has to wait, and who then needs that same control to retry - and let the handler refuse the call until the wait elapses. Never swallow the response into a generic "something went wrong".
- A one-time-code field is one input with `autocomplete="one-time-code"`, `inputmode="numeric"`, paste of the whole code, and no clearing of what the user typed on a wrong attempt. Say how many attempts are left only if the server chose to reveal it.
- **When the code has a known fixed length, the form submits itself the moment the last character lands.** A 6-digit 2FA or emailed code is complete the instant the sixth digit arrives - typed, pasted, or filled by the OS from an SMS or the authenticator - and asking for a click after that is a step the UI can take on the user's behalf. Take the length from the ONE constant the generator uses, not from a `6` hardcoded in the component, so a change to 8 does not silently break the trigger.
- Auto-submit needs three guards, and without them it burns the user's attempt budget:
  - **Once per distinct complete value.** Remember the value already sent and submit only when the current one is complete AND different. A re-render, a blur, a paste that lands as two events, or an autofill that rewrites the field must not each fire a request.
  - **Do not re-fire after a failure until the user edits the code.** A wrong code that resubmits on every keystroke can exhaust a five-attempt cap before the user finishes correcting it. Mark the field invalid, keep what they typed, and wait for a change.
  - **Never auto-retry a `429` or a network error.** Show the wait from `Retry-After` with a countdown, and let the user trigger the next attempt (server-side limits are security-policy's).
- Keep the submit button, `aria-disabled` while the code is incomplete - not the `disabled` attribute, which would drop the one control that can say what is missing out of the tab order. It is the affordance for anyone who does not see the field complete itself, the retry control after a failure, and the fallback when autofill misbehaves. Announce the transition in an `aria-live="polite"` region ("Verifying code...", then the result), because a form that submits with no click gives a screen-reader user nothing to go on.
- Do not auto-submit when the length is not fixed: a backup or recovery code of variable length, or one the user may paste with separators, has no reliable "complete" moment - normalize the value (strip spaces and dashes) and let the button be the trigger.
- Never keep a password, token, or code in `localStorage`, a query string, or an analytics payload. A reset token in the URL stays out of logs and out of any third-party script on the page.

---

## Cookie Consent Banner

A site that loads analytics, ads, A/B testing or session replay ships a consent surface. What may be set and when is security-policy's; this is the UI half.

- Reject is as reachable as Accept: same level, same weight, one click. Hiding refusal behind an extra screen is a dark pattern, and in the EU it is not consent at all.
- Three actions: accept all, reject all, and per-category choices with the strictly necessary group shown as always-on and not togglable. Nothing in the other categories loads until one of them is chosen.
- It is a dialog over the page, not a layout shift: focus moves into it, Escape and the keyboard work, it does not sit on top of the primary action, and closing it does not reflow the page.
- Persist the decision so it is asked once, and leave a permanent way back in (a footer link or a settings row) to change or withdraw it.
- The login and sign-up screens do not submit while the banner is unanswered. Answer it, record the choice, then continue - including when the choice was to reject.

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

### Show the last snapshot, then patch only what changed

The strongest version of stale-while-revalidate: persist the last response and render it on entry, so a returning user sees the screen already populated while the real request is still in flight. It is what makes a view backed by something slow (a NAS, a device on the LAN, a third-party API, anything you do not control) feel loaded instantly, because between two visits almost nothing usually changed.

- On mount, render from the persisted snapshot and fire the request at the same time. No spinner over content you can already show; a small "refreshing" marker is enough. Skeletons are for the first ever load, when there is no snapshot.
- When the response lands, RECONCILE, do not replace. Diff against what is on screen and apply only the differences: rows added, rows removed, fields whose value actually changed. Wholesale replacement is what produces the flash, the scroll jump, and the lost selection, and it is exactly what the snapshot was meant to avoid.
- Keep identity stable. Key rows by their real id (never the array index), and reuse the existing object for an unchanged row instead of a fresh one, so the framework re-renders the rows that changed and nothing else. Preserve scroll position, selection, expanded rows, in-progress edits, and focus across the refresh.
- If the whole response is equal to the snapshot, do nothing at all: no state write, no re-render. This is No-Op Detection applied to reads, and it is the common case.
- Detect "nothing changed" as cheaply as the backend allows: an `ETag` with `If-None-Match` (a `304` costs you a header exchange and no body), a `Last-Modified`/`updatedAt` cursor, or a content hash of the payload. Falling back to comparing the parsed objects is fine for small payloads, and hashing is fine for large ones - just do not deep-compare a huge tree on every poll.
- Stamp the snapshot with the time it was taken and show it ("updated 2 minutes ago"). A stale number no one can date is worse than a spinner.
- Never let the snapshot outlive its usefulness: version the stored shape (drop it when the app's schema changes), give it a TTL, cap what you store, and clear it on sign-out. localStorage is small, synchronous, and shared with every script on the page.
- Sensitive or fast-moving data does not get this treatment: money, permissions, live status, anything that would mislead if it were a minute old. Showing an old value is a correctness decision, not just a UX one.

### Caching is not free

- Every cache is a second copy of the truth, and the cost is invalidation, staleness bugs, and the memory or storage it occupies. Add one when there is a measured round-trip to save, not by default.
- Prefer the client cache: it removes the request entirely, so it costs the server nothing and scales with the number of users rather than against it. A server cache (Redis, see backend-policy) is for what the client cannot hold - expensive shared computations, data too large or too sensitive to sit on a device - and it is one more thing to size, evict, and invalidate.
- Cache the response, not the render. Storing derived UI state means re-deriving it on every schema change and getting it wrong when the derivation does.
- Coalesce and throttle rather than cache harder: one in-flight request per resource, no refetch on every focus event, and no polling loop that runs while the tab is hidden.

---

## Instant First Paint (Shell First, Data Async)

Render the page shell immediately; never block the first paint on data. A view that fetches everything before it renders anything looks frozen until the slowest request returns - the user stares at a blank screen. Paint the static structure (nav, headings, card frames, table chrome, stat-tile outlines) on the first tick, then fill each region as its data arrives.

- Load data asynchronously via the API AFTER the shell renders (client fetch on mount, or streaming/Suspense on server components) - do not gate the component's first render on the awaited data. The layout is static and free to render now; only the contents wait.
- Show skeleton placeholders shaped like the real content in every region still loading (cards, rows, charts, stat tiles), not one full-page spinner. Reserve the final dimensions so nothing shifts when data lands (no layout shift / CLS).
- **The skeleton covers the data that is missing, and nothing else.** Most of a screen does not depend on the response and must render as itself immediately: the nav, the page title, section headings, column headers, tab bars, filter and search controls, buttons, the card frames, and any value already in hand - a name from the route, a count from the cache, anything the parent already loaded. If the only thing waiting is the table rows, only the rows are skeletons and the rest of the table is real. Blanking a region you could have rendered is the same defect as blanking the page, just smaller.
- The test is per element, not per screen: "does this need the response to be drawn?" If no, draw it now. A loader is what you show when there is genuinely nothing to show yet, which is rarer than it looks.
- Regions do not wait for each other. Independent widgets each own their request and resolve on their own, so one slow endpoint never holds back the four that already answered.
- This applies to ANY data-driven view - dashboards, panels, detail pages, settings screens - not only long lists. A dashboard of independent widgets renders its grid instantly and lets each widget resolve on its own (see Progressive / parallel rendering below).
- For an instant first paint with REAL content, read the client cache first (per Client-Side Caching) and render it immediately, then revalidate in the background (stale-while-revalidate); fall back to skeletons only on a cold cache.
- Keep empty and error states per region, so a single failed or slow widget shows its own inline state without blanking the whole page.

### A whole-view skeleton is a full-page loader

A skeleton is not compliance by itself. `if (!data) return <PageSkeleton />` at the top of a component returns from the WHOLE component, so every heading, tab, filter and card frame it renders disappears too. Replacing a full-page spinner with a full-page skeleton changes the colour of the defect, not the defect.

- The guard belongs INSIDE the waiting region, not at the top of the view. Render the shell unconditionally and put the placeholder where the data goes: `{rows ? <Rows rows={rows}/> : <RowsSkeleton/>}` inside a table that already drew its header, filters and toolbar.
- The alternative is to push the request down: give the data-dependent region its own child component that owns the fetch, so the parent never has a reason to return early. A component whose entire output is built from the response may early-return, because there the component and the region are the same thing.
- Check what survives the guard before writing it: if the body below it draws a title, a tab bar, a button or any literal copy, that markup could have painted on the first tick and the guard is blanking it.
- The same applies to a detail view: the record's name from the route, breadcrumbs, the action buttons and the section headings render immediately, and only the fields wait.

### A tracked value paints its last sample, not a skeleton

A cold client cache is not an empty screen when the application already stores the value's history. If a view charts, logs or samples a metric over time - container CPU and memory, queue depth, disk usage, request rate, a device's last reading - then the most recent stored sample is a real, dated value the app can paint on the first tick, and the live reading replaces it when it lands. Skeletoning that tile throws away data already sitting in the same store the chart reads.

- Reach for it whenever the live read is slower than the stored one, which is the normal case: polling a container runtime, an agent on a host, a device or a third-party status API takes seconds, while the last row of the history table is one indexed query on data the view was already loading for its chart.
- The stored sample and the live one are the same shape, so this is a swap and not a second code path: render from `latest ?? lastTracked`, and let the live value overwrite it.
- Date it, and never let the two look identical - "12% - 40s ago" going to "18% - now". An undated stale number is worse than a skeleton, because the user acts on it believing it is current (Client-Side Caching says the same about a cached snapshot).
- Mark the tile as reconnecting rather than blanking it when the live read FAILS. The last known value plus "no reading since 14:02" is the useful screen; a skeleton that never resolves says nothing at all.
- The exception is a value that is meaningless when stale: a lock or availability state a user is about to act on, a balance before a payment, anything under the "never serve stale for money, security or correctness" rule. Wait for the live read there and say what it is waiting for.

### The shell ships first, the data follows

Data that arrives inside the first HTML document is data the navigation waited for. In a server-rendered route (Next App Router, Remix, Nuxt), an awaited query in the route component blocks the whole transition: the router has nothing to commit until it resolves, so the previous page stays on screen and the app feels stuck on every link click.

- An async route component that awaits a query declares a streaming boundary: a `loading.tsx` for the segment, or `<Suspense>` around just the data-dependent part with the awaited call inside it. Then the shell commits at once and the data streams in.
- Where the view is interactive anyway, let the client component own the request and render from the cache first (see Client-Side Caching). The server route stays a thin shell that carries the chrome: title, nav, tabs and layout.
- Server-render the data only where it must be in the document: SEO-indexable content, the above-the-fold content of a public page, or a value the page is meaningless without. Those are worth the wait; a dashboard table is not.
- Never make it a waterfall: a server route that awaits, then hands props to a client component that fetches again on mount, pays both costs.

---

## Large Lists & Progressive Loading

Never render an unbounded or large dataset in one shot (no fetch-everything then map over thousands of rows). Lists of products, feeds, search results, logs, etc. must load incrementally and keep the rendered DOM bounded.

### Choose a load strategy per case

- Infinite scroll (the default - feeds, large or unknown-size sets, exploratory browsing, and most data views): fetch one page at a time as the user nears the end, using keyset/cursor paging (per backend-policy / database-expert), not offset for deep lists.
  - It MUST be virtualized/windowed once the list grows: render only the viewport plus a small buffer and recycle offscreen rows so a long session (a user scrolling for an hour) does not accumulate thousands of nodes and lag. Drop far-offscreen items from the DOM and restore them on scroll-back, preserving scroll position (the TikTok model: only a handful of items live in the DOM at once).
  - Only start dropping/recycling once there is genuinely a lot rendered or the context demands it; do not over-engineer it for a small list.
- Pagination (when users need to jump to or deep-link a specific page, the set is bounded, totals/position matter, or results must be SEO-indexable): classic page controls backed by efficient server paging.
- **Infinite scroll is the preferred default; pagination is the deliberate exception.** Continuous scrolling is what most lists want and what most users now expect, so reach for it first and switch to pages only when one of the reasons above genuinely applies, when the design has nowhere to scroll (a fixed-height panel, a print or export layout, a table meant to be read position by position), or when the user asks for pages. The design and the user's request outrank the default; what does not is skipping the choice and rendering the whole set.
- Do not infinite-scroll a 30-row admin table or paginate a social feed. A short, bounded list needs neither - just render it (anti-overengineering-policy).
- A guardrail enforces the part of this that a file can prove: a collection bound from a query or a fetch and then mapped whole, with nothing in the file bounding its size, is blocked (`fe-unbounded-remote-list`). When the collection genuinely is bounded by construction, say so on the line - `enigma:allow-unbounded-list - at most three payment methods per account` - rather than adding paging you do not need. The rule only sees a fetch and a render in the SAME file; a list arriving through a custom hook or a prop is invisible to it and stays your call.

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

For a reversible user action, optimistic is the DEFAULT and not an enhancement to add later. The order is: apply the change to local state, then send the request, then reconcile - never request, await, and only then touch the UI.

- The defect has a name and a shape: a handler that awaits the mutation and updates state afterwards (`await fetch(...)` then `setItems(prev => prev.filter(...))`, or `await api.patch(...)` then a refetch). The user pays the whole round trip for an action whose outcome was never in doubt. The `fe-server-first-mutation` guardrail catches the clearest form of this on the lines a change adds; the rest is on you, because the rule cannot see a handler that hides the wait behind a parent refetch (`await onChanged()`, `await load()`, `router.refresh()`) - that is the same defect and it is the most common one.
- Which actions: toggle a flag, remove a row, rename, reorder, mark read, add a tag, favourite, vote - anything the client can compute the result of. Optimistic is wrong when only the server knows the outcome: a payment or charge, a server-assigned identifier the UI must display, a uniqueness check, a long job whose result IS the response, anything irreversible.
- Rollback is part of the feature, not a follow-up. Capture the previous value BEFORE mutating (`const previous = items`), restore it on failure, and say what failed - a silent revert reads as a UI bug and is worse than the wait. Do not roll back a value the user has since edited: reconcile against the server's response rather than blindly restoring.
- Reconcile optimistic state with the server response; never leave the UI in a divergent state, and keep the optimistic update and any client cache consistent with each other (invalidate or patch the cache, do not leave a stale list beside a fresh one).
- Where a delete is reversible, the optimistic update plus an Undo affordance replaces the confirmation prompt entirely (see Destructive & Irreversible Actions).
- Guard against the double-apply: an in-flight mutation that the user triggers again must not stack two optimistic updates, and a re-render must not re-apply one.
- With a data layer that owns this (TanStack Query `onMutate` + `onError` rollback + `onSettled` invalidate, SWR `optimisticData` + `rollbackOnError`, React `useOptimistic`), use it instead of hand-rolling local state - it already solves the cache reconciliation.
- Surface failures to the user clearly without exposing internal error details (see validation-policy).

---

## Destructive & Irreversible Actions (Confirm Before Doing)

Guard every destructive action behind friction proportional to how bad an accidental trigger would be. Never wire a permanent destroy straight to a button's `onClick` with no confirmation - a one-click "delete forever" is a footgun.

- Reversible / low-stakes destroy (remove a row, delete a draft, clear a field): prefer acting immediately with an Undo affordance over a confirmation prompt - soft-delete and show a "Deleted - Undo" toast (optimistic, with rollback per Optimistic UI). The common case gets zero friction and a mistake is one click to recover. Reach for undo before a confirm whenever the delete can actually be reversed.
- Standard destructive action (delete an item, remove a member, revoke a key): show a confirmation dialog that NAMES the exact thing being deleted ("Delete project 'Acme'?"), states the consequence, and uses a destructive-styled confirm button. It must be a real dialog/modal component, never the native `confirm()` (see the No-Op / native-dialog rules and the `fe-no-native-dialog` guardrail); default focus to Cancel and let Escape dismiss.
- Critical / irreversible action (delete a repository, organization, account, or workspace; drop a database; transfer ownership; wipe production data): require a type-to-confirm step. The user must type the exact resource identifier (the repo/org name, or an explicit phrase like "delete my account") into an input, and the confirm button stays blocked until the typed value matches EXACTLY (trimmed, case-sensitive comparison against the real name). This tier is the one place in this policy that blocks with the native `disabled` attribute instead of `aria-disabled`, and it keeps the handler guard as well - both, not either. The a11y cost that motivates `aria-disabled` elsewhere is not paid here: the reason the button is blocked is already carried by the confirm input's own label and helper text ("Type `acme-prod` to confirm"), not by a `title` on the button, so nothing becomes unreachable by taking it out of the tab order. Against an unrecoverable destroy, a browser-level block that holds whatever the JS state is worth more than a handler guard that a race, a re-render, or a mis-wired condition can defeat. This is the GitHub / Vercel / Stripe "danger zone" pattern: it forces the user to read what they are about to destroy and makes an accidental click impossible.

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

- Configure it where the data is: `keys` naming every field the user would expect to search (a row's name AND its id, owner, tag), `threshold` around 0.3 as the starting point, and `ignoreLocation` on so a match late in a long string still counts.
- Run it over the data already in memory, re-matching per keystroke. Debouncing belongs to the request that fetches the data, not to the match itself - an in-memory search of a loaded page is instant, and delaying it only makes the field feel broken.
- The exception is a filter over values the user PICKS rather than types - an id, a status, a tag, a date range, a facet from a dropdown. There the exact value is the requirement and fuzzy matching would be wrong; a plain comparison is correct, and it is not the case this rule is about.
- Server-backed search is the other half: once the list outgrows what the client holds, the query goes to the server (which does its own matching) and fuse.js narrows only what came back. Reuse the loaded list first (per Client-Side Caching) before falling back to a server query, and say which one is running, so an empty result reads as "no matches" and not as a broken field.

### A Data View Ships Its Own Search, Filters And Export

A list, table, log or history view is not finished when the rows render. Anything the user comes back to - expenses, activity logs, HTTP requests, transactions, audit trails, sessions, runs - is something they will need to find one row in, narrow to a slice of, and take away. Build those affordances WITH the view, by default and without being asked; shipping a bare table of a few hundred rows leaves the user scrolling and reading.

**Read the affordances off the data.** Each column kind implies its own control, so pick them from what the view actually shows rather than adding a generic search box and stopping:

- Free text (message, path, description, merchant, user agent): one fuse.js box over the meaningful text columns, not one per column.
- Bounded set (status, level, method, category, account, tag): multi-select filters listing the values actually present with a count each, not a hardcoded enum.
- Numeric, currency or duration (amount, latency, size): a min/max range plus whatever presets the domain reads by.
- Timestamp: a date range with relative presets (today, 7 days, 30 days, this month) and a custom range. A view whose data accumulates is read through this filter first, so it is the one that must exist.
- Identifier (IP, request id, hash, user id): exact match, never fuzzy - half an IP address means nothing.

An HTTP log table therefore gets: search over path and user agent, filters for status code, method and host, a date range, a duration range, and an export. An expense list gets: search over merchant and description, filters for category and account, an amount range, a date range, and an export.

**The rest of the contract:**

- Filters compose - AND across kinds, OR within one kind - and stack with the search rather than replacing it.
- The active filter set is visible and individually removable: a row of chips with a "Clear all", never state that only exists inside a closed dropdown.
- Keep the search, filters, sort and page in the URL query string. That is what makes a filtered view shareable, bookmarkable, and able to survive a reload and the back button, so "look at yesterday's failing requests" is one link instead of a screenshot.
- Show what is displayed against the total ("128 of 4,391"), and give the filtered-to-nothing case its own empty state that names the active filters and offers to clear them - not the same empty state as "no data yet".
- Sort by the columns that have a natural order (time, amount, duration, status) with the sensible default already applied: newest first for a log, not insertion order.
- Filter and sort over the loaded rows with no request while the client holds the whole set; move both server-side once it outgrows that (per Large Lists above), keeping the same URL contract.
- The rows themselves load incrementally - infinite scroll by default, pagination where the design or the user calls for it (Large Lists above). A view like this accumulates, so it never renders the full set in one shot.
- Export what is currently filtered, not the whole table, and label it so. CSV covers the spreadsheet case; add JSON where rows are nested or machine-read. Name the file for the view and its range (`http-logs-2026-07-01_2026-07-31.csv`). Generate it client-side from the loaded rows, and hand it to the server only when the filtered set is bigger than the client holds.

**Scale it to the view.** A settings screen with six rows, or a list read once and abandoned, needs none of this (anti-overengineering-policy). The trigger is a view that grows unbounded or that the user returns to. When unsure, ask whether the data accumulates over time: if it does, it needs at least the date range and the export.

### Ctrl+K Opens A Command Palette Once There Is Enough To Hunt For

When an app has more destinations and records than fit comfortably in the nav - roughly a dozen sidebar entries, or any list the user scrolls to find a known item - the fastest path stops being pointing and becomes typing. Ship the palette then, by default and without being asked. Before that, a three-screen app does not need one (anti-overengineering-policy).

- **The shortcut is Cmd+K on macOS and Ctrl+K elsewhere**, bound once on the document and `preventDefault`ed (Ctrl+K focuses the browser's own search bar otherwise). The same handler answers `/` where the app has no text input focused, and Escape always closes.
- **It must also be clickable.** A shortcut nobody discovers is not an entry point: put the search field in the header or at the top of the sidebar showing the shortcut hint inside it ("Search  Ctrl K"), and open the palette when it is clicked. Detect the platform for the hint rather than printing both.
- **It opens centred over the page as a modal dialog**, near the top third so the results grow downwards without moving the input. It is a real dialog: `role="dialog"` with `aria-modal`, focus into the field, focus trapped while open, focus restored to the trigger on close, page scroll locked. Reuse the project's Modal - the palette is a variant of it, not a second dialog implementation (Component Reuse above).
- **Search the data the client already holds**, fuzzy-matched with fuse.js in TS/JS, re-run on every keystroke - the in-memory pass is cheap and debouncing it only adds lag. Debounce only the part that reaches the server (~200-300ms) and abort the in-flight request when the query changes.
- **Index everything the user thinks of as a thing**, not just pages: navigation destinations, records (projects, accounts, files), and actions ("Create project", "Sign out", "Toggle theme"). Group the results by kind with a heading per group, and show the destination path or a second line so two similarly named records are distinguishable.
- **Empty query is not an empty panel.** Show recent items and the handful of most likely destinations, so opening it is useful before anything is typed.
- **Full keyboard contract**: Up/Down move through results across group boundaries, Enter opens the highlighted one, Cmd/Ctrl+Enter opens it in a new tab where that makes sense, and the highlighted row is tracked with `aria-activedescendant` on a `role="listbox"`. The mouse hovering a row moves the highlight so the two never disagree.
- **A no-results state names the query** and offers the nearest useful action ("No match for 'billling' - search all records"), rather than rendering nothing.

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