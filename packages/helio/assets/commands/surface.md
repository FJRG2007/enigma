---
description: Show ranked attack surface for a target based on recon output + hunt memory. Usage: /surface target.com
---

# /surface

View the prioritized attack surface for a target.

## What This Does

1. Reads cached recon output from `recon/<target>/`
2. Reads hunt memory for patterns and tested endpoints
3. Produces prioritized ranking
4. Outputs P1 (start here), P2, and Kill List

## Usage

```
!surface target.com
```

## Prerequisites

Run `!recon target.com` first.

## Output

```
ATTACK SURFACE: target.com
══════════════════════════════════════

Priority 1 (start here):
1. api.target.com/v2/users/{id} — IDOR candidate
   Tech: Express + PostgreSQL
   Suggested: numeric ID swap on GET/PUT/DELETE

2. api.target.com/graphql — introspection enabled
   Suggested: field-level auth check

Priority 2 (after P1):
1. cdn.target.com:8443/upload — file upload endpoint

Kill List (skip):
- static.target.com — CDN only
- docs.target.com — third-party

Memory:
- 3 endpoints tested, 5 remain
```