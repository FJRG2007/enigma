---
name: bug-hunt
description: Find what looks finished but breaks in real use - flows that fail on the second step, state lost on reload, round trips that do not round-trip, roles that see a dead button, existing data the change never handled. Use for any "find the bugs", QA, or "is this really done" pass over a feature or a whole app.
---

# Bug hunt

The bugs worth finding here are the ones a green test suite and a quick click-through both
miss. Each one gets a reproduction you ran, or it is not reported.

## Where they hide

- **The second step.** The first action works; the next one, the refresh, the back button, the
  second item, the edit after create - fails.
- **Round trips.** Export then import, save then reload, send then receive, create then search
  for it. Run both halves.
- **Conditions other than yours.** A non-admin role, another locale, an empty account, an
  account full of old data written before this change, a narrow viewport, a slow network.
- **Looks enabled, does nothing.** A button with no handler, a toggle that does not persist, a
  form that "saves" while the request fails, an error swallowed into a spinner.
- **Concurrency.** Two tabs, a double click, a retry while the first request is in flight.
- **Lifecycle.** Expired session, deleted parent record, a resource referenced after removal.
- **What it leaves behind.** Orphan rows, temp files, items left in a queue, inventory or state
  lost when a flow aborts halfway.

## Method

1. Pick the flows from how the product is used, most frequent first.
2. In the browser, do each flow as the user would, then repeat it with one condition changed at
   a time. Read console errors and failed requests after every step; a 4xx/5xx the UI hid is a
   finding.
3. For every failure, cut it to the shortest reproduction, then find the line responsible.
4. Re-run the reproduction after any fix. A fix that was not re-run is not a fix.

## Report

| Severity | What breaks | Reproduction | Evidence | Cause (`file:line`) | Fix |

Severity is what failing costs the user (data loss, blocked task, wrong result, annoyance), not
how hard the bug was to find.
