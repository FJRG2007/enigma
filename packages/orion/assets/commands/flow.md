---
description: Break one user flow end to end in the browser - every step, every condition, every round trip. Usage: /flow <flow, e.g. "checkout" or "invite a teammate">
---

# /flow

Take the flow named in the arguments and run the `bug-hunt` skill on it alone.

1. Do the flow once in the browser as a daily user would; note every step and request.
2. Repeat it changing one condition at a time: another role, empty and full data, a reload in
   the middle, the back button, a double submit, a slow network, a narrow viewport.
3. Run every round trip it implies (create then find, save then reload, export then import).
4. Report each failure with its shortest reproduction, the evidence and the cause in the code.
