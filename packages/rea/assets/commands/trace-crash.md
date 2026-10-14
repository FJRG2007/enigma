---
description: Correlate a crash with the code paths that lead to it. Usage: /trace-crash <target path> <crash symptom, log or address>
---

# /trace-crash

Follow REA's `trace_crash` workflow for the target and symptom in the arguments.

1. Pin the symptom to code: a faulting address, symbol, message string or recorded crash file.
2. Trace the static paths that reach it and the conditions on each.
3. Only if the user approves running the target: capture a bounded process run that
   reproduces it, and compare it with the static paths.
4. Report the most likely cause with its evidence, the alternatives still open, and what would
   decide between them.
