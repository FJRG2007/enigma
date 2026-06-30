---
description: Validate a finding — runs 7-Question Gate + 4-gate checklist. Kills weak findings before report writing. Prevents N/A submissions that hurt validity ratio. Usage: /validate
tui: opencode
---

# /validate

Run full validation on the current finding before writing a report.

## What This Does

1. Runs 7-Question Gate (one wrong answer = kill it)
2. Checks against the always-rejected list
3. Runs 4 pre-submission gates
4. Outputs: PASS (write the report) or KILL (move on)

## Usage

```
/validate
```

Describe the finding when prompted. Include:
- The endpoint
- The bug class
- What the PoC shows
- The target program

## The 7-Question Gate

Answer each. ONE wrong answer = STOP.

### Q1: Can I demonstrate this step-by-step RIGHT NOW?

Write this out:
```
1. Setup:   I need [own account / another user's ID / no account]
2. Request: [exact HTTP method, URL, headers, body]
3. Result:  Response shows [exact data / action completed]
4. Impact:  Real consequence is [account takeover / PII exposed / money stolen]
5. Cost:    Time: [X min], Capital: [$0 / $X]
```

If step 2 is "I need to look at the code more" → KILL IT.

### Q2: Is the impact accepted by this program?

Check program scope page. Is your bug class listed? Is it excluded?

### Q3: Is the vulnerable asset in scope?

Exact domain in scope? Not staging/dev? Not a third-party service?

### Q4: Does it need admin or privileged access that an attacker can't get?

"Admin can do X" → KILL IT.
"Regular user can do X that only admin should" → valid.

### Q5: Is this known or documented behavior?

Search disclosed reports + changelog + API docs.

### Q6: Can you prove impact beyond "technically possible"?

- XSS → actual cookie value in exfil request, not just alert()
- SSRF → response body from internal service, not just DNS callback
- IDOR → actual other-user's private data in response, not just 200 status

**OSS Scope Exception:** If the target has a public codebase AND a production domain, Q6 can be satisfied without triggering the exploit:
1. Trace the full vulnerable code path in the public repo (code evidence)
2. Confirm the vulnerable version is live via passive check — response headers, `/version` endpoint, npm/PyPI/Docker metadata, or publicly served `package.json` / `requirements.txt`
3. Include the payload labeled "NOT EXECUTED IN PRODUCTION — code-confirmed"

What is NEVER allowed even on OSS: sending the actual exploit to production, triggering exfil, or modifying state. Passive version confirmation only.

### Q7: Is this on the never-submit list?

```
Missing headers, GraphQL introspection alone, clickjacking without PoC,
self-XSS, open redirect alone, SSRF DNS-only, logout CSRF, banner disclosure,
rate limit on non-critical forms, missing cookie flags alone...
```

If yes → KILL IT unless you have a chain.

## Check: Conditionally Valid?

If it's on the never-submit list, can you chain it?

| You Have | Chain Available? |
|---|---|
| Open redirect | + OAuth code theft → ATO? |
| SSRF DNS-only | + internal service data? |
| Clickjacking | + sensitive action + PoC? |
| CORS wildcard | + credentialed data exfil? |
| Prompt injection | + IDOR → other user's data? |

If no chain → KILL IT. If chain confirmed → report both together.

## 4 Gates — All Must Pass

**Gate 0 (30 sec):**
```
[ ] Confirmed with real HTTP requests (not just code reading)
[ ] In scope (checked program page)
[ ] Reproducible from scratch
[ ] Evidence captured
```

**Gate 1 — Impact (2 min):**
```
[ ] Can answer "What does attacker walk away with?"
[ ] More than "sees non-sensitive data"
[ ] Real victim exists
[ ] No unlikely preconditions
```

**Gate 2 — Dedup (5 min):**
```
[ ] Searched HackerOne Hacktivity for endpoint + bug class
[ ] Searched GitHub issues
[ ] Read 5 most recent disclosed reports
[ ] Not in changelog as known issue
```

**Gate 3 — Report quality (10 min):**
```
[ ] Title formula: [Class] in [Endpoint] allows [actor] to [impact]
[ ] Steps have exact HTTP request
[ ] Evidence shows actual impact
[ ] CVSS calculated
[ ] Fix: 1-2 concrete sentences
```

## Step 0 — Hard Exclusions (Run First, 30 Seconds)

Before any gate, check if the finding auto-kills:

```
[ ] Is it DoS / resource exhaustion without demonstrated business impact? → KILL
[ ] Is it rate limiting only? → KILL
[ ] Is it only in test files? → KILL
[ ] Is it log injection / spoofing? → KILL
[ ] Is it SSRF where attacker controls only path, not host? → KILL
[ ] Is it missing audit logging? → KILL
[ ] Is it a secret in a file with correct permissions? → KILL
[ ] Does it exist only in dead/unreachable code? → KILL
[ ] Is the resource ID a UUID/ULID/CUID (non-enumerable)? → KILL
[ ] Does reaching this vulnerability REQUIRE first exploiting a different vulnerability? → KILL as standalone
    Only valid if reported as a confirmed end-to-end chain where BOTH bugs are independently verified.
```

If any box checks → STOP. Kill it now. Don't spend time on gates.

## Step 0.5 — Framework Protection Check

Before claiming injection/XSS/validation bypass:

```
[ ] Is an ORM used? (Prisma, SQLAlchemy, ActiveRecord) → only raw queries are vulnerable
[ ] Are templates auto-escaping? (Django, Jinja2, Handlebars) → check for |safe / raw overrides
[ ] Is schema validation middleware applied? (Joi, Zod, Pydantic) → verify it's wired to the route
[ ] Does the framework prevent CSRF by default? → check for skip_ decorators on the route
[ ] Is a reverse proxy handling rate limiting? → check nginx/Cloudflare config
```

If the framework already prevents it → KILL. Don't report framework-protected behavior.

## Adversarial Skeptic Layer (Run Before Q1–Q7)

Spend 5 minutes actively trying to DISPROVE the finding:

```
1. Is there validation I missed earlier in the full call chain?
2. Does the framework/ORM/middleware prevent this by default?
3. Is the entry point actually reachable without special access? (Reachability check)
4. Could the language runtime prevent exploitation? (Type safety, memory safety)
5. Is the output rendered dangerously or just stored benignly?
6. Is output escaped at the render layer even if not sanitized at input?
7. Does the "sink" actually cause exploitable behavior in this tech stack?
```

**DISPROVE result → KILL the finding. Move on.**
**Cannot disprove → confidence increases. Proceed to Q1–Q7.**

## Reachability + Exploitability Labels

Before Q1, classify these two dimensions:

**Reachability:**
- EXTERNAL — unauthenticated, public-facing (full severity)
- AUTHENTICATED — requires valid session (reduce one tier)
- INTERNAL — admin-only / internal service (reduce two tiers)
- UNREACHABLE — dead code / gated → KILL immediately

**Exploitability:**
- EASY — standard technique, no special conditions
- MEDIUM — requires specific conditions or chained step
- HARD — insider knowledge, rare race, advanced technique

Include both labels in your report.

## Output

**PASS:** "All gates pass. Reachability: [label]. Exploitability: [label]. Confidence: [score]/100. Proceed to /report."

**KILL:** "Hard exclusion / Skeptic disproves at step [N] because [reason]. Kill this finding. Move on."

**DOWNGRADE:** "Q6 only shows technical possibility. Downgrade from High to Medium. Requires showing actual data exfil in PoC."
