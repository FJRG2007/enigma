---
description: Offensive Vaccine — attack a finding, help apply a fix, then re-attack to verify the fix actually holds. Usage: /vaccine [finding-file]
tui: opencode
---

# /vaccine

The Offensive Vaccine loop: attack → defend → verify. After finding a vulnerability, this command guides applying a fix and then re-testing to confirm the patch actually prevents exploitation.

## Why

A fix that "looks right" in code often has edge cases that still allow exploitation. The only way to confirm a patch works is to re-run the attack after applying it. Platforms and clients often want verification evidence.

## Usage

```
/vaccine                            # interactive — describe the finding
/vaccine findings/high-ssrf.md      # load a specific finding file
/vaccine --finding "IDOR on /api/invoices/{id}"
```

## The Loop

```
Phase 1 — ATTACK (reproduce the bug)
    │  Confirm: exact HTTP request + exploitable response
    │
    ▼
Phase 2 — DEFEND (apply the fix)
    │  Generate fix: code change, config change, or middleware
    │  Apply it in the target environment
    │
    ▼
Phase 3 — VERIFY (re-attack with the same payload)
    │  Run exact same attack from Phase 1
    │  Expected: attack blocked (403/401/400 or no data returned)
    │  Unexpected: still works → fix incomplete, iterate
    │
    └─► If blocked: document verification evidence → report
        If still works: identify bypass → back to Phase 2
```

## Phase 1: Reproduce

Confirm the bug is real before attempting any fix:

```
[ ] Exact HTTP request that reproduces it (copy-pasteable curl)
[ ] Response showing the impact (not just 200 OK)
[ ] Reproduced 2+ times from a clean session
[ ] Confidence >= 70
```

## Phase 2: Fix Guidance

The agent will suggest the minimal correct fix. Fix types:

**Authorization fix (IDOR/broken auth):**
```python
# Add ownership check
order = db.query("SELECT * FROM orders WHERE id = ? AND user_id = ?",
                 order_id, current_user.id)
```

**Input validation (SSRF/RCE):**
```python
# Allowlist approach
ALLOWED_DOMAINS = {"api.internal.com", "webhooks.partner.com"}
parsed = urlparse(user_url)
if parsed.hostname not in ALLOWED_DOMAINS:
    raise ValueError("URL not permitted")
```

**Header/rate limit (auth bypass):**
```
Rate limit: 5 attempts per 15 minutes per IP
Add: CAPTCHA after 3 failed attempts
```

## Phase 3: Verification

Re-run Phase 1 payload against the patched endpoint:

```bash
# Example: IDOR verification
# Before fix: returns victim data → VULNERABLE
# After fix: should return 403/404 or attacker's own data

curl -s -H "Authorization: Bearer ATTACKER_TOKEN" \
    https://target.com/api/invoices/VICTIM_ID

# Expected after fix:
# {"error": "Not found"} or HTTP 403/404
# NOT: {"id": VICTIM_ID, "email": "victim@...", ...}
```

## Output

After successful verification, generate a verification report:

```markdown
## Fix Verification — <FINDING_TITLE>

**Finding:** <VULN_TYPE> on <ENDPOINT>
**Fix Applied:** <description of what was changed>
**Verification Date:** <date>

### Pre-Fix (Attack Successful)
```
<exact curl command>
Response: <proof of vulnerability>
```

### Post-Fix (Attack Blocked)
```
<same curl command>
Response: <403/404/access denied>
```

**Result:** VERIFIED — attack no longer succeeds
```

## Limitations

The vaccine loop verifies the specific attack vector tested. It does NOT guarantee:
- All variant attacks are blocked (test multiple payloads)
- Other endpoints with same pattern are fixed (check siblings)
- The fix doesn't introduce new vulnerabilities
