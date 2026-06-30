---
description: Verify if an asset is in program scope. Usage: /scope asset
---

# /scope

Check if an asset is in scope for the current program.

## What This Does

1. Reads current program scope from memory
2. Checks if asset matches in-scope patterns
3. Returns in-scope / out-of-scope verdict

## Usage

```
!scope target.com
!scope api.target.com
!scope https://target.com/path
```

## Output

```
SCOPE CHECK: api.target.com
══════════════════════════════════════

Result: IN SCOPE ✓

Patterns matched:
  - *.target.com (wildcard)
  - api.* (prefix)

Program: Example Program (H1)
```

## Output (Out of Scope)

```
SCOPE CHECK: staging.target.com
══════════════════════════════════════

Result: OUT OF SCOPE ✗

Reason: Explicitly excluded
Excluded: staging.*, dev.*, *.staging.*
```