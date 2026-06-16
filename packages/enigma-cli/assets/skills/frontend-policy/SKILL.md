---
name: frontend-policy
description: Frontend architecture - reusable components, abstraction thresholds, state management, no-op save detection (skip mutations when the edited state equals the saved state), client-side caching (localStorage/sessionStorage to avoid redundant server calls and survive rate limits), large-list rendering (virtualized infinite scroll vs pagination, skeletons, progressive/parallel loading, short-TTL caching), optimistic UI with rollback, and periodic React code-health audits (react-doctor). Use when building or changing UI components, client state, forms/save flows, data fetching/caching, lists that show lots of data, loading states, or any frontend structure.
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

---

## Frontend Abstraction Threshold

- Create reusable components only when:
  - They are used in multiple places, OR
  - They contain meaningful reusable logic, OR
  - They reduce duplication significantly

- Do not abstract single-use UI elements unless future reuse is highly likely.
- Prefer simple, local components for simple, local problems.

---

## State Management

- Keep state as local as possible; lift it only when genuinely shared.
- Derive values during render instead of duplicating state.
- Avoid redundant client state that mirrors server state without a reason.

---

## No-Op Save Detection (Dirty-State Check)

Before sending a save/update mutation, compare the edited state against the last-known saved state. If they are equal, the save is a no-op: skip the request entirely.

### The rule

- Track the saved (pristine) snapshot of the form/settings when it loads or after a successful save.
- Compute dirtiness by comparing the current edited values against that snapshot (deep/structural equality on the fields being saved), not by counting user interactions.
  - Example: a value goes from state x to state z, then back to x before saving. The net change is zero - the form is NOT dirty, and pressing Save must send nothing to the backend.
- When the form is not dirty, the Save action does nothing (and the button should reflect it, e.g. disabled or neutral); no request, no spinner, no toast.
- When partial updates are supported, send only the changed fields (a diff against the snapshot), not the full object.
- After a successful save, replace the snapshot with the newly saved state so subsequent edits diff against it.

### When NOT to apply it (judgment call)

This is the default, not an absolute. Skip the no-op check and allow the save to go through when overwriting has value on its own:

- The resource is edited concurrently by many users or updated constantly server-side, and an explicit save is meant to assert/overwrite the user's view ("last write wins" by intent).
- Saving has intentional side effects beyond persisting values: bumping `updatedAt`, re-triggering a pipeline/deploy, re-validating, or acknowledging a state.
- The client snapshot cannot be trusted to match the server (long-lived stale forms) and the save doubles as a sync.

Decide per case which mode fits; when in doubt for simple single-user forms and settings panels, apply the no-op check.

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

## Accessibility & Resilience

- Use semantic markup and accessible interactive elements by default.
- Handle loading, empty, and error states explicitly for every async view.
- Validate user input in real time per validation-policy; never rely on the UI as the only validation layer.

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