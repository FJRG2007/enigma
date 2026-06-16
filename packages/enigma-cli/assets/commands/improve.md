---
description: Improve a focused area of the current project - ui/frontend, security, performance, or seo. Usage: /improve <area>.
argument-hint: ui | frontend | security | performance | seo
---

# /improve

Improve the requested area of THIS project. The area to improve is: **$ARGUMENTS**

## Resolve the target area

Map `$ARGUMENTS` (case-insensitive, ignore surrounding whitespace) to exactly one workflow:

- `ui` or `frontend` -> Frontend & UI workflow (both aliases produce the same workflow).
- `security` -> Security workflow.
- `performance` (also `perf`) -> Performance workflow.
- `seo` -> SEO workflow.

If `$ARGUMENTS` is empty or does not match one of the areas above, do NOT guess: print the supported areas (`ui|frontend`, `security`, `performance`, `seo`) and stop.

## Ground rules (every area)

- Work only on the current project/repository. Detect the stack first (framework, language, build tool, package manager) before proposing changes.
- Reuse existing code, components, and utilities before adding new ones; never duplicate logic.
- Make the smallest change that achieves the improvement. Do not rewrite working code without a concrete reason.
- Apply changes incrementally and keep them reviewable; explain each change briefly.
- Never trade away security, accessibility, or correctness to gain another goal.
- If a matching policy or skill is available in this environment, follow it (for example a frontend, security, backend, validation, or dependency policy).
- After editing, run the project's build, lint, and test commands when they exist and report the results. Do not claim success without verification.

## Workflows

### ui | frontend

Improve the visual design and frontend quality of the project.

1. Map the UI surface: entry points, shared components, design tokens/theme, and the routes or screens that matter most.
2. Visual design: establish or tighten a deliberate palette, typography scale, spacing, and layout rhythm. Remove templated, default-looking choices in favor of an intentional, consistent identity.
3. Components: extract repeated markup into reusable components only when reuse or complexity justifies it; align props and naming with the existing codebase.
4. States and feedback: cover loading, empty, error, and success states; add optimistic UI with rollback where it improves perceived speed.
5. Accessibility: semantic elements, labels, focus order, keyboard navigation, and sufficient contrast.
6. Responsiveness: verify the layout across small, medium, and large breakpoints.
7. Apply the available frontend and frontend-design guidance if present.

### security

Harden the project against the common, high-impact risks.

1. Secrets: find hardcoded credentials, tokens, or keys; move them to environment/secret storage and document the change. Never print secret values.
2. Authentication and authorization: enforce least privilege; check that every privileged path verifies identity and permissions.
3. Input handling: validate and sanitize all external input (request bodies, query params, CLI args, file/3rd-party payloads) at trust boundaries with a schema validator.
4. OWASP Top 10: review for injection, broken access control, SSRF, insecure deserialization, and similar classes relevant to the stack.
5. Transport and crypto: enforce TLS, use vetted crypto primitives, avoid weak/deprecated algorithms.
6. Dependencies: run the ecosystem audit (for example `npm audit`, `pip-audit`) and flag known-vulnerable packages.
7. Logging: ensure logs never leak secrets or PII; never expose internal errors to clients.
8. Apply the available security and validation guidance if present.

### performance

Improve runtime and perceived performance with evidence, not guesses.

1. Measure first: identify the actual hot paths (profiling, slow queries, large bundles, slow renders). Do not optimize blindly.
2. Backend: eliminate N+1 queries, add indexes where justified, batch redundant calls, and add caching with correct invalidation.
3. Frontend: reduce bundle size (code splitting, tree shaking), avoid unnecessary re-renders, lazy-load heavy assets, and cache client-side where safe.
4. Data and I/O: remove redundant computation and round-trips; stream or paginate large payloads.
5. Verify: re-measure after each change and report the before/after difference.

### seo

Improve search-engine visibility and crawlability.

1. Metadata: per-page title and meta description, canonical URLs, and Open Graph / Twitter card tags.
2. Semantic HTML: correct heading hierarchy, landmark elements, and descriptive link text.
3. Structured data: add relevant JSON-LD schema for the content type.
4. Crawlability: provide a sitemap and robots configuration; ensure important content is server-rendered or otherwise indexable.
5. Performance for SEO: address Core Web Vitals (LCP, CLS, INP) since they affect ranking; coordinate with the performance workflow when needed.
6. Accessibility overlaps with SEO (alt text, language attributes) - apply those too.

## Output

Report concisely: the resolved area, the files changed, what improved and why, the verification results (build/lint/test), and any follow-ups you could not safely automate.
