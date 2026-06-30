---
description: Quick triage of a finding — 7-Question Gate check. Usage: /triage
---

# /triage

Quick 7-Question Gate triage of a potential finding.

## The 7 Questions

1. **Can attacker do this RIGHT NOW?**
2. **What can attacker ACCESS?**
3. **What's the IMPACT?**
4. **Is this REPRODUCIBLE?**
5. **Is this IN SCOPE?**
6. **Is this a DUPLICATE?**
7. **Is time invested WORTH IT?**

## Usage

```
!triage
```

## When to Use

- After manual testing обнаружил something interesting
- Before spending more time on a lead
- Quick sanity check before running tools

## vs !validate

- `!triage` — Quick check, 30 seconds
- `!validate` — Full validation, detailed output