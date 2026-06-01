---
name: frontend-policy
description: Frontend architecture - reusable components, abstraction thresholds, state management, client-side caching (localStorage/sessionStorage to avoid redundant server calls and survive rate limits), optimistic UI with rollback, and periodic React code-health audits (react-doctor). Use when building or changing UI components, client state, data fetching/caching, auditing React code, or any frontend structure.
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