---
description: Log a finding to hunt memory. Usage: /remember
---

# /remember

Save a finding or pattern to persistent hunt memory.

## What This Does

1. Auto-populates fields from session context
2. If `!validate` was run, pre-fills from validation output
3. Prompts to confirm before saving
4. Writes to `memory/journal.jsonl`

## Usage

```
!remember
!remember --from-validate
```

## Required Fields

- target
- vuln_class
- endpoint
- result (confirmed/rejected/partial)

## Why This Matters

- Next hunt shows which endpoints tested
- Cross-target pattern learning
- Track payouts and success rate