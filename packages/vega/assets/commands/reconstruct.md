---
description: Rebuild a behavior of a shipped program and verify the rebuild against the original. Usage: /reconstruct <target path> <behavior>
---

# /reconstruct

Reconstruct the behavior named in the arguments, then follow REA's `verify_reconstruction`
workflow.

1. Write the behavior as a finite specification: inputs, outputs, edge cases - each tied to the
   evidence it came from.
2. Implement it in the user's project, in their language. Reimplement behavior; never copy the
   target's protected code or assets.
3. Verify the implementation against the original on the same inputs and compare the results
   with REA's retained comparison Evidence.
4. Report each requirement as verified, failed or unverified, with the evidence.
