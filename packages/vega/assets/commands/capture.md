---
description: Plan and run a bounded, controlled capture of a process's runtime behavior. Usage: /capture <target path> <what to observe>
---

# /capture

Follow REA's `prepare_bounded_process_capture` workflow for the target in the arguments.

1. Design the experiment first: the exact command, inputs, interactions, time and output
   limits, and what the run is expected to show.
2. Show that plan to the user and run the target only after they approve it - it executes with
   their permissions.
3. Run the capture within those bounds and read its terminal, exit and filesystem observations.
4. Report what was observed against what was expected, and what the run could not show.
