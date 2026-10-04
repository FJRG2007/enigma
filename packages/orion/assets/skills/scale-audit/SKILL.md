---
name: scale-audit
description: Find what breaks as data, users and traffic grow - unbounded queries and lists, missing indexes, per-row work, in-memory filtering, missing pagination, connection and rate limits, work that should be a background job. Use before launch, when data is growing, or for any scalability review.
---

# Scale audit

The question for every code path: what happens at 100x the rows, users or requests? Answer it
with the code and, where possible, a measurement on generated data.

## Look for

- **Unbounded reads.** A query with no `LIMIT`, a list endpoint with no pagination, a "load all
  then filter in code".
- **Missing indexes.** Every `WHERE`, `JOIN` and `ORDER BY` column on a large table. Check with
  the database's query plan (`EXPLAIN`), not by reading the schema.
- **Per-row work.** A query, request or file operation inside a loop over records.
- **Expensive totals.** `COUNT(*)` on a large table on every page view.
- **State in one process.** In-memory sessions, caches or locks that break with a second
  instance.
- **Slow work in the request.** Emails, exports, image processing, third-party calls done while
  the user waits; they belong in a background job.
- **No limits.** Endpoints without rate limits, uploads without size caps, retries without
  backoff, fan-out without a bound.

## Method

1. List the entities that grow (users, orders, events, logs) and every code path that reads them.
2. For each path, read the query or loop and state its cost in terms of N.
3. Where it matters, generate data at the target size and time the path before and after a fix.

## Report

| Path | Cost today (in N) | Breaks at | Evidence | Fix | Cost after |
