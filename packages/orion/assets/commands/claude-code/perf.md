---
description: Measure load and runtime speed of a page or flow with a real trace and Lighthouse, then find the cause of each slow part. Usage: /perf [page or flow]
---

# /perf

Run the `perf-audit` skill on the page or flow in the arguments (default: the most visited page).

1. Record a performance trace of the load and of the heaviest interaction; run Lighthouse.
2. Report LCP, INP, CLS and blocking time against their targets, the request waterfall, and the
   slowest server calls with their queries.
3. For each slow part, name the cause in the code and the fix. If you apply a fix, measure again
   the same way and report both numbers.
