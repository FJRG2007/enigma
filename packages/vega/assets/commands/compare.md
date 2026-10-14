---
description: Compare two shipped versions of an app and explain what changed. Usage: /compare <old path> <new path> [focus]
---

# /compare

Follow REA's `compare_application_versions` workflow for the two targets in the arguments.

1. Open and inspect each target in turn; keep the Evidence of each.
2. Diff what the artifacts show: files and digests, modules, symbols, strings, entry points,
   and the focus area when one was given.
3. For each change that matters, read the code on both sides and state the behavioral
   difference, with evidence from both versions.
4. List changes found but not explained as unknowns.
