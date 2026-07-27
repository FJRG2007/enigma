---
name: frontend-policy
description: Frontend architecture - reusable components, abstraction thresholds, state management, no-op detection (skip any operation whose result equals the current state - form saves, toggles, filters, reorders - not just saves), client-side caching (localStorage/sessionStorage to avoid redundant server calls and survive rate limits), instant first paint (render the shell immediately, load data async via the API, show skeletons - never block render on data), perceived performance and responsiveness (instant interaction feedback, prefetch on intent, debounce/throttle, cancel stale requests, avoid request waterfalls, lazy-load heavy widgets), large-list rendering (virtualized infinite scroll vs pagination, skeletons, progressive/parallel loading, short-TTL caching), optimistic UI with rollback, responsive/adaptive layout (fluid units, breakpoints, no overlap or horizontal overflow, viewport meta, touch targets), and periodic React code-health audits (react-doctor). Use when building or changing UI components, client state, forms/save flows, data fetching/caching, lists that show lots of data, loading states, dashboards/panels, layout/responsiveness, making the UI feel fast, or any frontend structure.
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

Keep surfaces flat and let spacing, not chrome, do the grouping.

- Do not nest a card inside another card. A card already establishes a surface; wrapping cards in cards stacks backgrounds, paddings, and shadows into visual noise. Group related content inside one card with spacing, a heading, or a light divider - not a second bordered container.
- Do not add borders, boxes, or dividers that carry no information. A border is justified only when it marks a real boundary the user needs (a distinct interactive region, a table edge); otherwise prefer whitespace, type weight, and grouping over outlines, and reach for a divider only when spacing alone cannot convey the separation.
- Avoid redundant containers in general: one elevation/background per surface, minimal wrapping, and consistent padding read cleaner and are easier to maintain than deeply nested boxed layouts.

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

## Text That Does Not Fit (Variable-Length Content)

Every string is variable-length; the value on screen during development is one sample. Text escaping its card or colliding with a neighbour is the most common layout defect, it is invisible until the content changes, and it is the responsibility of whoever writes the layout - not something to be pointed out afterwards.

- Design for the extremes of each string, not the sample: the longest realistic value (an unbounded user-supplied name, a long identifier, a full path, a big formatted number) and the shortest (empty, one character). Translations run noticeably longer than English - roughly a third more for German - so a label that only just fits is already broken.
- **A flex or grid item refuses to shrink below its content by default** (`min-width: auto`). That single rule causes most "text sticks out of its card" bugs. Set `min-width: 0` (Tailwind `min-w-0`) on the item that must shrink AND on every ancestor between it and the container; for grid tracks use `minmax(0, 1fr)`, never a bare `1fr`, when the track holds text.
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