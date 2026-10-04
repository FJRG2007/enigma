---
name: perf-audit
description: Measure and fix load and runtime speed where users feel it - Core Web Vitals from a real trace, request waterfalls, oversized bundles and payloads, N+1 queries, render-blocking work, slow interactions. Use when a page or flow feels slow, before shipping a heavy view, or for any performance or optimisation pass.
---

# Performance audit

Speed findings are numbers from this session, never impressions.

## Measure first

1. Run the app as it ships (production build when possible) and open the page in the browser.
2. Record a performance trace of the page load and of the heaviest interaction. Read LCP, INP,
   CLS and total blocking time from it, and run Lighthouse on the page.
3. List the network requests: count, sizes, which ones block render, which wait on another
   (waterfalls), which repeat.
4. On the server side, time the endpoints behind the slow parts and look at the queries they
   run (count per request, and the plan of the slowest).

Thresholds to judge against: LCP 2.5 s, INP 200 ms, CLS 0.1 (web.dev "good"); an API call a
user waits on should answer well under a second.

## Usual causes

- Data fetched one request at a time when one call would do (waterfall), or the same data
  fetched again on every render.
- N+1 queries: a query per row of a list. One query with a join or an `IN (...)` instead.
- Whole tables or whole objects sent when the view shows three fields.
- The page blocked on data instead of rendering its shell first.
- Large libraries shipped for one function; images not sized or compressed; no caching headers.
- Expensive work on every keystroke or render instead of memoized or debounced.

## Report

| Metric or symptom | Measured | Target | Cause (`file:line`) | Fix | Measured after |

A fix is reported with the number after it, measured the same way.
