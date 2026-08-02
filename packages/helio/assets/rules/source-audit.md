# Source Code Audit Rules

For white-box / source-assisted bug bounty hunting. Apply when a repo is available.

---

## CORE PRINCIPLE: TRACE THE FULL DATA FLOW

Before reporting ANY source-code finding, trace the complete path:

```
External input → validation (or lack thereof) → sink
```

If you cannot identify the sink, you do not have a bug yet.
If validation exists anywhere in the chain, prove it is insufficient.

---

## 1. MAP TRUST BOUNDARIES FIRST

Before hunting, identify all entry points where external data enters the system.

### HTTP / API Boundaries
```
- REST routes (app.get/post/put/delete)
- GraphQL resolvers (Query, Mutation, Subscription)
- WebSocket message handlers
- File upload handlers
- Form submissions
```

### Data / System Boundaries
```
- DB query construction (raw SQL, stored procs)
- Shell command execution (os.system, exec, subprocess)
- Template rendering (render_template_string, dangerouslySetInnerHTML)
- Deserialization (pickle, YAML.load, eval, JSON.parse with reviver)
- File system access (readFile, open, path.join)
```

### Other Entry Points
```
- CLI arguments (argv, argparse)
- Environment variables (os.environ, process.env)
- Queue/event consumers (Kafka, SQS, RabbitMQ message bodies)
- Scheduled jobs (cron bodies from DB)
- Third-party webhooks
```

**Key rule:** Trace from entry point → sink. If the data never reaches a dangerous sink, it is not a finding.

---

## 2. CROSS-FILE ANALYSIS PATTERNS

Source code bugs cluster at module boundaries. Check these six patterns every time:

### Pattern 1: Assumption Mismatch
```
Function A assumes input was pre-validated.
Function B calls A without validating.
→ Input reaches A's dangerous operation unvalidated.

Example:
  // auth.js — expects sanitized email
  function buildQuery(email) { return `SELECT * FROM users WHERE email='${email}'` }
  
  // login.js — passes raw req.body.email directly
  buildQuery(req.body.email)  ← SQLi
```

### Pattern 2: Error Propagation Gap
```
A throws exception → B catches and swallows → C assumes success
→ Partial operation completed, inconsistent state.

Example:
  try { await deleteUser(id); } 
  catch (e) { res.json({ success: true }); }  ← always reports success
```

### Pattern 3: Type Coercion Trap
```
Value is valid string at boundary but becomes different type at sink.
→ Bypasses string-based validation.

Example:
  if (req.user.role == true)  // "user" string is truthy → admin access
  bcrypt.compare(req.body.password, hash)  // non-string input throws uncaught
```

### Pattern 4: Partial Failure State
```
Multi-step operation: step 2 fails but step 1 side effects are not rolled back.
→ Data corruption / inconsistency.

Example:
  await db.createUser(user)      // succeeds
  await sendVerificationEmail()  // throws
  // user created but unverified — may allow auth bypass
```

### Pattern 5: Auth/Authz Gap
```
Route A checks auth → calls shared function F.
Route B (unprotected) also calls F.
→ F reachable without auth via Route B.
```

### Pattern 6: Shared Mutable State
```
Two code paths read-modify-write the same state without coordination.
→ Race condition / TOCTOU.

Example:
  // Both paths:
  balance = getBalance(user)
  if (balance >= amount): deduct(user, amount)
  // No transaction = race: balance checked twice before deduction
```

---

## 3. SECURITY CHECKLIST (for CRITICAL + HIGH files)

Run this for every file classified as CRITICAL or HIGH risk:

### Injection Sinks
```
[ ] SQL: raw string concatenation into query (not parameterized)
[ ] Command: os.system / exec / subprocess.call with user input
[ ] Template: render_template_string / dangerouslySetInnerHTML / eval
[ ] Path traversal: path.join / os.path.join / readFile with user input
[ ] LDAP / XPath / SSTI: string-built queries with user input
```

### Authentication / Authorization
```
[ ] Hardcoded secrets (JWT_SECRET, API_KEY, DB_PASSWORD in code)
[ ] JWT/session without expiry
[ ] Weak crypto: MD5/SHA1 for passwords (use bcrypt/argon2)
[ ] Missing ownership check before returning resource (IDOR)
[ ] Loose equality in auth check: == instead of ===
[ ] Auth only at route level (function also reachable from unprotected route)
```

### Input Validation
```
[ ] Unvalidated request body fields
[ ] No Content-Type or size limits on uploads
[ ] Unvalidated numeric inputs (no bounds checking)
[ ] Type confusion: number/string/null/array where only string expected
```

### Information Disclosure
```
[ ] Sensitive fields in API responses (password hash, SSN, full card)
[ ] Stack traces in error responses
[ ] Internal paths/server info in headers or errors
[ ] User enumeration via different error messages (user not found vs wrong password)
```

### Session / Token
```
[ ] Non-expiring tokens
[ ] Token not invalidated on logout/password change
[ ] Password reset token valid after use
[ ] JWT signature not verified (alg:none attack)
```

### Other
```
[ ] Missing rate limiting on auth endpoints
[ ] Missing CSRF protection (if not framework-provided)
[ ] Open redirects (redirect to attacker-controlled URL)
```

---

## 4. RISK MAP — CLASSIFY FILES BEFORE HUNTING

Classify every file before diving in. Hunt in priority order.

| Tier | Contains | Hunt First? |
|------|----------|-------------|
| **CRITICAL** | Auth logic, payment processing, admin functions, crypto operations | Yes — read every line |
| **HIGH** | API endpoints, route handlers, DB queries, session management | Yes — full analysis |
| **MEDIUM** | Business logic, data transformation, utility libraries | If time allows |
| **LOW** | Static assets, CSS, translations, constants | Context only |
| **SKIP** | Test files, mocks, fixtures, generated code | Read for behavior clues only |

**Recently modified files** (last 30 days) are elevated one tier regardless.

```bash
# Find recently modified files
git log --oneline --since="30 days ago" --diff-filter=M --name-only | grep -v "^[a-f0-9]"
```

---

## 5. FALSE POSITIVE — HARD EXCLUSIONS

Auto-dismiss any finding that matches these patterns. Do NOT report them.

| Auto-Kill | Reason |
|-----------|--------|
| DoS / resource exhaustion (without demonstrated business impact) | Not accepted as standalone in most programs |
| Rate limiting concerns | Informational only — not a security bug |
| ReDoS without >1 second backtracking payload | Not credible without proof |
| Memory/CPU exhaustion in memory-safe language | Language prevents exploitation |
| Findings only in test files (*.test.*, __tests__/) | Not deployed code |
| Log injection / log spoofing | No direct impact |
| SSRF where attacker controls only path (not host/protocol) | Not exploitable |
| User-controlled content to AI/LLM prompts | Out of scope in most programs |
| Missing audit logging | Not a vulnerability |
| Secrets in files with correct permissions (0600) | Mitigated by OS controls |
| Client-side auth checks (when server enforces separately) | Defense-in-depth only |
| UUIDs/ULIDs/CUIDs as resource IDs | Not enumerable |
| Environment variables / CLI flags (developer-controlled input) | Trusted input boundary |
| Config/documentation files only | No runtime impact |
| Bugs only reachable from UNREACHABLE code paths | Dead code |

---

## 6. FRAMEWORK-SPECIFIC FALSE POSITIVES

Before claiming SQL injection, XSS, or validation bypass — verify the framework doesn't already prevent it.

| Framework | Common False Positive | Truth |
|-----------|----------------------|-------|
| **Prisma / SQLAlchemy / ActiveRecord** | SQL injection via ORM methods | ORM parameterizes queries — only raw SQL (`$queryRaw`, `.execute()`) is vulnerable |
| **Django templates / Jinja2 / Handlebars** | XSS via template output | Templates auto-escape by default — only `\|safe`, `{!! !!}`, `dangerouslySetInnerHTML` bypass this |
| **Express + Helmet** | Missing security headers | Helmet middleware adds most headers — verify middleware chain |
| **Joi / Zod / Pydantic / Cerberus** | Missing input validation | Schema middleware validates at request entry — verify middleware is applied to the route |
| **Rails CSRF protect_from_forgery** | CSRF vulnerability | Enabled by default — only APIs with `skip_before_action :verify_authenticity_token` are vulnerable |
| **Next.js Server Actions** | SSRF via server-side fetch | Requires user-controlled URL parameter in the action |
| **bcrypt.compare()** | Auth bypass via type confusion | Will throw on non-string input — catch the error and return 401 (check if catch is missing) |

**Rule:** Don't report framework-protected behavior. Verify the protection is actually applied first.

---

## 7. CONFIDENCE SCORING

Assign confidence to every finding before reporting:

| Score | Label | Criteria |
|-------|-------|----------|
| **80–100** | HIGH | Code read directly; full data flow traced; sink confirmed; mitigations verified absent |
| **50–79** | MEDIUM | Evidence quality good; some assumptions; cross-references partially traced |
| **0–49** | LOW | Cross-service boundary; complex chain; unverified assumptions |

**Rule:** Only report findings with confidence ≥ 70. For confidence < 70, trace further or drop it.

Findings with HIGH confidence from two independent analysis paths (dual-lens) = strong real bug signal.

---

## 8. REACHABILITY CLASSIFICATION

Classify every finding's reachability before assigning severity:

| Label | Meaning | Severity Impact |
|-------|---------|-----------------|
| **EXTERNAL** | Unauthenticated external input (public API, URL param, form) | Full severity |
| **AUTHENTICATED** | Requires valid user session | Reduce one tier |
| **INTERNAL** | Only from internal services / admin interfaces | Reduce two tiers |
| **UNREACHABLE** | Dead code or blocked by hard conditions | Not a bug — drop it |

**Rule:** A Critical bug that is INTERNAL becomes High. An UNREACHABLE bug is not a bug.

---

## 9. ADVERSARIAL CHALLENGE (DISPROVE BEFORE REPORTING)

Before writing any report, spend 5 minutes actively trying to disprove the finding:

```
1. Is there a validation step I missed? (check every function in the call chain)
2. Is there middleware that sanitizes this before it reaches the sink?
3. Does the framework protect against this by default?
4. Is the sink actually reachable in production? (dead code? config gate?)
5. Is the output actually rendered in a dangerous context or just stored?
6. Could the type system / language runtime prevent exploitation?
7. Does a framework abstraction prevent the raw operation?
```

**Only report if you cannot disprove it after this challenge.**

If you CAN disprove it → it is not a finding. Move on.

---

## 10. CALIBRATION EXAMPLES

### CONFIRMED: SQL Injection
```javascript
// auth.js:12
const query = `SELECT * FROM users WHERE email='${req.body.email}'`;
db.execute(query);
```
- Trust boundary: req.body.email (external HTTP POST, no auth)
- Sink: db.execute() with raw string
- Validation check: none in this file; no middleware in call chain
- Reachability: EXTERNAL
- Confidence: 95 (HIGH)
- DISPROVE check: Tried — no ORM, no parameterization, no middleware
- Verdict: CONFIRMED, Critical

### FALSE POSITIVE: SQL via ORM
```javascript
// users.js:8
const user = await prisma.user.findFirst({ where: { email: req.body.email } });
```
- Sink: Prisma ORM method (not raw SQL)
- Framework protection: Prisma parameterizes all queries
- DISPROVE check: Prisma docs confirm automatic parameterization
- Verdict: FALSE POSITIVE — ORM protects. Kill it.

### CONFIRMED: IDOR
```javascript
// docs.js:22
router.get('/api/documents/:id', requireAuth, async (req, res) => {
  const doc = await Document.findById(req.params.id);
  return res.json(doc);  // No ownership check
});
```
- Trust boundary: req.params.id (user-controlled, authenticated)
- Sink: returns doc.data without checking doc.owner === req.user.id
- Reachability: AUTHENTICATED
- Confidence: 90 (HIGH)
- Verdict: CONFIRMED, Medium (AUTHENTICATED lowers from High)

### FALSE POSITIVE: JWT IDOR
```javascript
// orders.js:14
router.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await Order.findOne({ id: req.params.id, userId: req.user.id });
  if (!order) return res.status(404).json({ error: 'Not found' });
  return res.json(order);
});
```
- Ownership check: `userId: req.user.id` in the query itself — not just route-level
- DISPROVE check: Query includes userId from JWT — attacker cannot change JWT contents
- Verdict: FALSE POSITIVE — ownership enforced at DB query level. Kill it.

### CONFIRMED: Command Injection
```javascript
// image.js:31
app.post('/api/resize', (req, res) => {
  const { filename, width, height } = req.body;
  exec(`convert ${filename} -resize ${width}x${height} output.jpg`, callback);
});
```
- Sink: exec() with shell=True and user-controlled filename
- Payload: `filename="; rm -rf /; echo "`
- Reachability: EXTERNAL (no auth on route)
- Confidence: 92 (HIGH)
- Verdict: CONFIRMED, Critical

### FALSE POSITIVE: Subprocess with List
```python
# resize.py:18
subprocess.run(["convert", filename, "-resize", f"{width}x{height}", "output.jpg"])
```
- Sink: subprocess.run with list args (no shell=True)
- Language protection: list args prevent shell interpretation
- Verdict: FALSE POSITIVE -- no shell injection possible with list argv. Kill it.

---

## 11. PERSISTENT VULNERABILITY LEDGER (docs/vulnerabilities/)

When you audit a repo you have filesystem access to (white-box / --source-code), keep a
durable, in-repo record of every confirmed finding under `docs/vulnerabilities/`. This is the
project's own security memory: it lets a future scan skip what is already known, catches a
fixed bug that came back, and shows the devs and any other agent on the project which classes
of mistake have already happened here so they are not repeated.

This is NOT helio's private hunt memory. `targets/<t>/SESSION.md`, the hunt journal, and
`/remember` are transient, per-hunt, helio-side state. The ledger is committed into the
audited repo and is written for the people who maintain it. Keep both -- they serve different
readers.

**Scope and safety (hard rules):**
- Only for a repo the user or their team owns and controls. NEVER create a ledger inside a
  third-party bug-bounty target you do not own.
- Redact live secrets, tokens, credentials and real customer PII from every entry -- replace
  with placeholders (`ATTACKER_TOKEN`, `victim@example.com`). The ledger documents the flaw so
  it can be fixed; it must not become a committed copy of real secrets.
- Only CONFIRMED findings that pass the validation gate (confidence >= 70, not a framework FP,
  reachable) go in the ledger. Do not pollute it with weak leads.

### Before the audit -- READ the ledger first

1. If `docs/vulnerabilities/` exists, read `README.md` and every `VULN-*.md` entry.
2. Build a known-set keyed by `(cwe, normalized location/component, bug class)`.
3. Use it while hunting:
   - A candidate that matches an OPEN entry is already documented -> reference its id, do not
     re-file it as a new finding.
   - A candidate that matches a `fixed` entry but is present in the code again is a REGRESSION
     -> high signal, flag it explicitly.
   - A `false-positive` / `accepted-risk` entry -> do not resurface it unless the context changed.

### After confirming a finding -- WRITE the ledger

1. Ensure `docs/` exists at the repo root (create it if absent), then `docs/vulnerabilities/`
   and its `README.md` index.
2. Reconcile against the known-set:
   - New finding -> allocate the next id, create its file, add a row to the index.
   - Matches an open entry, still present -> update `last_seen`, do not duplicate.
   - Matched a `fixed` entry, present again -> set `status: regressed`, append a History line.
   - A previously open entry you can now confirm is patched in the code -> set `status: fixed`,
     set the `fixed` date (and `fix_commit` if you know the commit that closed it).

### Entry format

One file per finding: `docs/vulnerabilities/VULN-NNNN-<slug>.md` (4-digit id, kebab slug, e.g.
`VULN-0001-idor-invoices-endpoint.md`).

```markdown
---
id: VULN-0001
title: IDOR in src/api/invoices.ts allows any authenticated user to read others' invoices
status: open              # open | fixed | regressed | false-positive | accepted-risk
severity: high            # critical | high | medium | low | info
cwe: CWE-639
stride: Information Disclosure
cvss: "6.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N
location: src/api/invoices.ts:42
component: billing
reachability: AUTHENTICATED   # EXTERNAL | AUTHENTICATED | INTERNAL
exploitability: EASY          # EASY | MEDIUM | HARD
confidence: 90
discovered: 2026-08-02
last_seen: 2026-08-02
fixed: null                   # YYYY-MM-DD once remediated, else null
fix_commit: null              # commit sha that closed it, else null
---

## Summary
Impact-first prose. What an attacker can do, and where.

## Root cause / data flow
External input -> (missing ownership check) -> sink. Name the exact functions and lines.

## Evidence
Structured PoC (Payload / Request / Expected / Actual) or, for code-only confirmation, the
traced path plus passive version proof. Secrets and PII redacted to placeholders.

## Impact
Prose, quantified: what data, how many records, which actor.

## Remediation
One or two specific sentences. The concrete fix, not "add validation".

## History
- 2026-08-02: discovered by Helio (source audit), status open.
```

### Index format

`docs/vulnerabilities/README.md` opens with two lines on what the folder is (a security
findings ledger; new scans read it first to avoid repeats), then a table:

```markdown
| ID | Title | Severity | Status | Location | CWE | Discovered |
|----|-------|----------|--------|----------|-----|------------|
| VULN-0001 | IDOR in invoices endpoint | High | Open | src/api/invoices.ts:42 | CWE-639 | 2026-08-02 |
```

Sort open/regressed above fixed, and highest severity first. Keep the prose in the same
ASCII-only, human style as reports (see `rules/reporting.md`): no em-dash, no unicode arrows
(use `->`), no emojis, no decorative separators.
