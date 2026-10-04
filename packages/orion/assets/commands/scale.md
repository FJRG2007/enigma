---
description: Find what breaks as data, users and traffic grow - unbounded queries, missing indexes, per-row work, missing limits. Usage: /scale [area]
---

# /scale

Run the `scale-audit` skill on the area in the arguments (default: the whole backend).

1. List the entities that grow and every code path that reads or writes them.
2. State each path's cost in terms of N, and check the slow ones with the database's query plan.
3. Where it matters, generate data at the target size and time the path.
4. Report each limit with the evidence, the cause in the code and the fix.
