---
description: Start vulnerability hunting on a target. Loads scope, reads recon data, runs targeted tests. Usage: /hunt target.com
---

# /hunt

Active vulnerability hunting on a target.

## What This Does

1. Reads program scope (in-scope assets, exclusions, payment behavior)
2. Loads recon output from `recon/<target>/` if available
3. Detects tech stack and maps to primary bug classes
4. Runs targeted tests for the highest-ROI bug classes
5. Documents findings with exact HTTP requests

## Usage

```
/hunt target.com
/hunt target.com --vuln-class idor          # focus on one bug class (lower tokens, faster)
/hunt target.com --vuln-class ssrf
/hunt target.com --vuln-class graphql
/hunt target.com --source-code ./repo       # static analysis + live testing
/hunt target.com --browser                  # browser-based testing (OAuth/SSO/SPA flows)
/hunt targets.txt                           # multi-target: one domain per line
```

## Session Isolation

**One session per target.** The agent accumulates context — testing two targets in one session
causes cross-contamination where payloads, assumptions, and findings from target A
affect target B.

Open a separate session/window for each target.

## Multi-Target

Create a `targets.txt` with one domain per line:
```
api.target.com
app.target.com
admin.target.com
```
Then: `/hunt targets.txt --vuln-class idor`

Each target runs independently. Findings scoped per-target in hunt memory.

## Source Code Mode (--source-code)

```
/hunt target.com --source-code ./path/to/repo
/hunt target.com --source-code https://github.com/org/repo
```

Enables:
- Hardcoded secrets and API key grep
- Route-to-controller mapping — find endpoints with missing auth decorators
- Dangerous function scan: eval, exec, unserialize, raw SQL concat
- Cross-reference source findings with live endpoint scan

## Browser Mode (--browser)

When a browser tool is available in your agent, use `--browser` for:
- OAuth / SSO / 2FA flows that require JavaScript
- DOM-based XSS (invisible to curl probes)
- WebSocket endpoints
- SPA route discovery (React/Vue/Angular)
- Real file upload and form submission

## Phase 0: Pre-Hunt Setup

### MCP Browser Detection

Before hunting, check which tools are available:

```
If a browser MCP or browser automation tool is available:
  USE IT FOR: account creation (CAPTCHA/email-verify flows), OAuth consent screens,
              JS-heavy auth, XSS proof-of-execution in browser
  DO NOT USE FOR: any standard HTTP request you can do with curl or fetch
  REASON: browser MCP adds 500ms-5s per request vs ~50ms for curl

Default: curl / fetch for all HTTP testing. Browser MCP is last resort only.
```

### Scope Lock

**Before making any request, the scope must be locked.**

```
1. Extract the exact in-scope list from the program page
2. Extract the exact out-of-scope list
3. Load it into ScopeChecker (tools/scope_checker.py) if running automated tests
4. If an asset is NOT on the in-scope list → it does not exist for this hunt
5. If an asset IS on the out-of-scope list → hard stop, do not proceed
```

Scope creep = bans + instant-close reports. Wildcard `*.target.com` does NOT cover:
- `target.com` itself (must be listed separately)
- Third-party services even if CNAME points there (Zendesk, Salesforce, etc.)

## Phase 1: Read Before Touching (15 min)

### Read Program Scope
```
1. Go to program page (HackerOne/Bugcrowd/Intigriti)
2. Note ALL in-scope domains — only test these
3. Note ALL out-of-scope domains — never test these
4. Note impact types accepted (some exclude low severity)
5. Write down the scope list — refer back before every new host you touch
```

### Read Disclosed Reports (Intel)
```bash
# HackerOne Hacktivity for this program:
# https://hackerone.com/TARGET_NAME/hacktivity
# Extract from each report: endpoint, bug class, parameter, missing check, payout
```

## Phase 2: Tech Stack Detection (2 min)

```bash
TARGET="target.com"
curl -sI https://$TARGET | grep -iE "server|x-powered-by|x-aspnet|x-runtime|x-generator"

# Stack → Primary bug class:
# Ruby on Rails  → mass assignment, IDOR
# Django         → IDOR (ModelViewSet), SSTI
# Flask          → SSTI (render_template_string), SSRF
# Laravel        → mass assignment, IDOR
# Express/Node   → prototype pollution, path traversal
# Spring Boot    → Actuator endpoints, SSTI
# Next.js        → SSRF via Server Actions, open redirect
# GraphQL        → introspection, IDOR via node(), auth bypass on mutations
```

## Phase 3: Active Testing

### IDOR Testing (highest ROI)

```bash
# Setup: create two accounts (attacker + victim)
# Replay with attacker's token but victim's IDs

# Test HTTP method variations:
curl -X DELETE https://target.com/api/user/123/orders \
  -H "Authorization: Bearer ATTACKER_TOKEN"

# Test API version differences:
# Protected: /api/v2/user/123/data  →  Try: /api/v1/user/123/data

# Test GraphQL node():
# {"query": "{ node(id: \"dXNlcjoy\") { ... on User { email phone } } }"}
```

### Auth Bypass Testing

```bash
for endpoint in export delete share archive download restore transfer admin; do
  curl -s -o /dev/null -w "$endpoint: %{http_code}\n" \
    "https://target.com/api/users/123/$endpoint" \
    -H "Authorization: Bearer ATTACKER_TOKEN"
done
```

### SSRF Testing

```bash
# If DNS callback confirmed → escalate to internal:
curl "https://target.com/api/image?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/"
```

## Phase 4: The A→B Signal Method

When you confirm bug A, immediately check for B and C:

| Found A | Check B | Check C |
|---|---|---|
| IDOR on GET | IDOR on PUT/DELETE same path | IDOR on sibling endpoints |
| Auth bypass on endpoint | Every sibling in same controller | Old API version |
| Stored XSS | Does admin view it? (priv esc) | Email/export/PDF rendering |
| SSRF DNS callback | Internal services (169.254.x.x) | SSRF via open redirect |

**Before pursuing B:** Confirm A is real first (exact HTTP request + response).

## Phase 5: Finding Confirmation Gate

**A finding is only "Confirmed" when ALL of the following are true:**

```
[ ] Have exact HTTP request that reproduces it
[ ] Have actual response showing the impact (not just 200 OK)
    - IDOR: response contains other user's private data
    - XSS: payload executes in browser context (not just reflected)
    - SSRF: response body from internal service (not just DNS callback)
    - SQLi: actual data extracted (not just error message)
[ ] Reproduced minimum 2 times from a fresh session
[ ] Not a framework false positive (checked ORM, template escaping, middleware)
[ ] Reachability confirmed: EXTERNAL / AUTHENTICATED / INTERNAL (not UNREACHABLE)
[ ] Exploitability confirmed: EASY / MEDIUM / HARD
[ ] Confidence >= 70
```

**OSS Scope Exception:** If the program has a public codebase AND a production domain, a finding can be "Confirmed" via two-path evidence:
1. Full code path traced in the public repo
2. Vulnerable version confirmed deployed via passive check only (response headers, `/version` endpoint, npm/PyPI/Docker metadata)
NEVER send the exploit payload to production. Passive version check only.

If a finding does not pass this gate → it is a "Lead", not a "Confirmed Bug". Keep hunting.

## Phase 6: Document Findings

```markdown
## Active Leads
- [14:22] /api/v2/invoices/{id} — no ownership check visible. Testing...

## Dead Ends (don't revisit)
- /admin → IP restricted. Hard stop.

## Confirmed Bugs (passed all gates above)
- [15:10] IDOR on /api/invoices/{id} — read+write from attacker session
  Evidence: curl -H "Authorization: Bearer ATTACKER_TOKEN" https://target.com/api/invoices/999
  Response: {"id":999,"user_id":456,"amount":1200,"email":"victim@example.com"}
```

## 20-Minute Rotation Rule

Every 20 min ask: "Am I making progress?" No → rotate to next endpoint or vuln class.

## Source Code Mode (`--source-code`)

Follow `rules/source-audit.md`. Full data flow trace required. No code reading without sink confirmation.

## Getting Specific Results (Anti-Vague Rule)

If the agent gives a generic message like "try testing for XSS" or "check for IDOR",
that is not useful. Demand specificity by including this in your prompt:

```
Give me the EXACT curl command to test endpoint X.
Include: full URL, exact headers (including auth token placeholder), exact body.
Do not describe what to do — show the command.
```

Example:
```
I found /api/v2/users/{id}/invoices returns a 200 for any user.
Give me the exact curl to confirm IDOR from an attacker account.
My attacker token is ATTACKER_TOKEN, victim user ID is 456.
```

The agent should ALWAYS respond with runnable commands, not descriptions.
If it doesn't, add: "Show commands only. No prose."

## Auto-Memory (runs at session end)

When the hunt session ends, run `/remember` to log a summary to hunt memory so `/pickup` picks it up next time.

## Stop Signals (move on)

- 403 no matter what you try
- 20+ payload variations, identical response
- Finding needs 5+ simultaneous preconditions
- 30+ min on same endpoint with no progress
