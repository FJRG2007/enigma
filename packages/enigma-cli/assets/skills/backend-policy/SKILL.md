---
name: backend-policy
description: Backend/API architecture - controller-service-repository layering, request/response handling, API and request optimization (batching, avoiding redundant calls), server-side caching (Redis) with invalidation, and Zod boundary validation. Use when designing or changing API endpoints, services, controllers, server business logic, or backend request flow.
---

# Backend & API Architecture Policy

## Activation Scope

- Apply whenever the task involves API endpoints, server business logic, services, controllers, or backend request flow.
- Owns server-side layering, API/request optimization, and server-side caching. Strict input validation rules live in validation-policy; persistence and query rules live in database-expert.

---

## Layered Structure (Separation of Concerns)

- Separate controllers, services, repositories, and validators into distinct layers.
- Controller/route handler: parse and validate input, call a service, shape the response. No business logic.
- Service: business logic and orchestration. Reusable and domain-focused. No HTTP or framework details.
- Repository/data access: the only layer that talks to the database (per database-expert). No business logic. On a TypeScript/JavaScript/Node/Bun stack that layer is the Prisma client over PostgreSQL by default - pick it without asking, and use another ORM only when the user, the requirements, or the existing codebase names one.
- Validator/schema: input contracts via Zod or equivalent (per validation-policy).
- Do not place business logic in route handlers, and do not place data access in services - go through the repository.

---

## Boundary Validation

- Validate every incoming request at the controller boundary before any business logic runs, using Zod (or equivalent) schemas.
- Share schemas with the frontend where possible; schemas are the single source of truth.
- Full validation and error-handling rules are owned by validation-policy - apply it; do not duplicate them here.
- Never expose internal errors, stack traces, or schemas to clients.

---

## API & Request Optimization

- Minimize external requests; prefer batching or aggregation over many small calls.
- Avoid redundant network calls and duplicate work within a request.
- Skip no-op writes: if a mutation would set fields to the values they already hold, short-circuit before touching the database - no write, no domain event, no cache invalidation - and return the unchanged resource. Compare the incoming values against the current row (or a version/ETag). The client applies the same rule (frontend-policy); the server is the authority.
- Merge requests when possible; coalesce concurrent identical work.
- Avoid N+1 queries; batch data access (delegate query specifics to database-expert).
- Return only the fields the client needs; avoid overfetching.
- Paginate large collections (prefer keyset/seek pagination per database-expert); expose a cursor-based endpoint so the client can do virtualized infinite scroll or pagination (frontend-policy).
- Do not block a whole response on one slow aggregate. Split independent data into separate endpoints, or fetch the parts in parallel server-side and return/stream each as it is ready, so the client can render progressively instead of waiting on the slowest query.

---

## Server-Side Caching (Redis)

Cache expensive or hot reads on the server to reduce database load, complementing the client cache (frontend-policy). The layered model: client cache absorbs most reads, Redis absorbs the rest, the database is queried least.

### When to cache

- Cache read-heavy, expensive-to-compute, or frequently requested data.
- Reach for the client cache first (frontend-policy): it removes the request instead of serving it faster, so it costs this service nothing. A server cache is for what the client cannot hold - an expensive computation shared across users, a payload too large or too sensitive to sit on a device, or a rate-limited upstream you are shielding.
- Support the client's revalidation instead of making it re-download: answer with an `ETag`/`Last-Modified` and honour `If-None-Match`/`If-Modified-Since` with a `304`, so an unchanged resource costs a header exchange and no body.
- Do not cache data that must always be strongly consistent unless invalidation is immediate and reliable.
- Never cache secrets or sensitive data without encryption and strict access control.

### Patterns

- Use cache-aside (lazy loading): on miss, load from DB, then populate the cache with an explicit TTL.
- Always set a TTL; never cache indefinitely without an expiry or invalidation trigger.
- Add small TTL jitter to avoid synchronized expiry and thundering-herd reloads.
- Use a lock or single-flight on cache miss for hot keys to prevent stampedes.

### Invalidation (mandatory)

- Invalidate or update the cached value immediately after any mutation that changes it.
- Keep a single source of truth: the database is authoritative; the cache is derived (see database-expert).
- Use clear, namespaced, versioned cache keys so related entries can be invalidated together.

---

## Resilience & Rate Limiting

- Apply rate limiting and return proper 429 responses with Retry-After headers.
- Make external/service calls resilient: timeouts, bounded retries with backoff, and circuit breaking where appropriate.
- Keep requests idempotent where possible; use idempotency keys for unsafe operations that may be retried.
- Fail gracefully and degrade (e.g. serve cached data) instead of cascading failures.

---

## Observability

- Log enough context to trace a request end to end, without logging secrets or sensitive values.
- Surface metrics for latency, error rate, cache hit ratio, and rate-limit rejections.
- Distinguish client errors (4xx) from server errors (5xx) consistently.