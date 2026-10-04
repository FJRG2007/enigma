---
description: Full Orion pass over the app - broken flows, speed, scalability and search - in a real browser, with evidence for every finding. Usage: /sweep [area]
---

# /sweep

Run a complete hunt over the app, or over the area named in the arguments.

1. Find how to run the app (README, package scripts) and start it. Ask only if it truly cannot be
   started.
2. List the main user flows, most used first.
3. Run the `bug-hunt` skill over those flows in the browser, delegating independent flows to the
   `flow-breaker` agent in parallel.
4. Run `perf-audit` on the most visited pages (delegate to `perf-profiler`).
5. Run `scale-audit` on the data paths behind them (delegate to `scale-auditor`).
6. Run `search-quality` on every search or finder you met.
7. Merge everything into one report, most severe first, with what held and what stays unverified.

Fix only when the user asks; report first.
