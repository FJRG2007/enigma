# Reporting Rules

Report quality directly impacts payout. Triagers are busy. Make their job easy.

---

## 1. NEVER USE THEORETICAL LANGUAGE

```
NEVER: "could potentially allow"
NEVER: "may allow an attacker to"
NEVER: "might be possible"
NEVER: "could lead to"
NEVER: "could be chained with X to cause Y"

ALWAYS: "An attacker can [exact action] by [exact method]"
```

If you can't write a concrete statement → you don't have a bug yet.

## 2. RUN 7-QUESTION GATE BEFORE WRITING

Every finding must pass all 7 questions before spending time on a report.

One NO = kill it immediately. N/A hurts your validity ratio more than missing a bug.

## 3. ALWAYS INCLUDE PROOF OF CONCEPT

- IDOR → show victim's actual data in the response (not just 200 OK)
- XSS → show actual cookie exfil (not just alert(document.domain))
- SSRF → show actual internal service response (not just DNS callback)
- SQLi → show actual database content (not just error message)

A "technically possible" finding without PoC is an Informational at best.

## 4. CVSS MUST MATCH ACTUAL IMPACT

Don't claim Critical for a Medium bug. Triagers trust you less for every overclaim.
Don't claim Medium for a Critical — you're leaving money on the table.

Use the CVSS 3.1 formula. Common scoring:
- IDOR read PII (auth required): 6.5 Medium
- Auth bypass → admin: 9.8 Critical
- SSRF → cloud metadata: 9.1 Critical

## 5. NEVER SUBMIT FROM THE ALWAYS-REJECTED LIST

These are always N/A. Never submit them standalone:

```
Missing headers (CSP, HSTS, X-Frame-Options)
GraphQL introspection alone
Self-XSS
Open redirect alone
SSRF DNS-only
Logout CSRF
Missing cookie flags alone
Rate limit on non-critical forms
Banner/version disclosure without working exploit
```

Build the chain first. Prove it works. Then report.

## 6. VERIFY DATA ISN'T ALREADY PUBLIC

Before submitting an information disclosure finding:
1. Open the target in an incognito browser (not logged in)
2. Can you see the same data without authentication?
3. If yes → not a bug

## 7. TWO TEST ACCOUNTS FOR IDOR

Never test IDOR with only one account (testing yourself).
- Account A = attacker (your account doing the request)
- Account B = victim (whose data you're reading)

Report must show: "I sent request with Account A's token but Account B's ID, and received Account B's private data."

## 8. REPORT FORMAT BY PLATFORM

**HackerOne:** Impact-first summary → CVSS → Steps to Reproduce → Impact → Fix
**Bugcrowd:** VRT category in title → Description → Expected vs Actual → Severity Justification
**Intigriti:** CVSS prominent → Clear steps → Business impact
**Immunefi:** Root cause in code → Foundry PoC → $ impact quantified

## 9. UNDER 600 WORDS

Triagers skim. Long reports get skimmed harder.

Structure:
- Sentence 1: What attacker can do (impact)
- Sentence 2-3: How (endpoint, parameter, method)
- Steps to reproduce: numbered, with exact HTTP request
- Impact: one paragraph, quantified
- Fix: 1-2 sentences

## 10. ESCALATION LANGUAGE (WHEN PAYOUT IS DOWNGRADED)

```
"This requires only a free account — no special privileges."
"The data includes [PII type], subject to GDPR/CCPA requirements."
"An attacker can automate this — all [N] records in minutes."
"This is externally exploitable with no internal access required."
"Impact equivalent to a full breach of [feature/data type]."
```

## 11. DON'T COMBINE SEPARATE BUGS

If A and B are independent bugs (different endpoints, different impact):
- Report them as SEPARATE reports = separate payouts
- Only combine if they're part of ONE attack chain that requires both

## 12. TITLE FORMULA — NEVER DEVIATE

```
[Bug Class] in [Exact Endpoint/Feature] allows [attacker role] to [impact] [scope]
```

Examples:
```
IDOR in /api/v2/invoices/{id} allows authenticated user to read any customer's invoice
Missing auth on POST /api/admin/users allows unauthenticated creation of admin accounts
Stored XSS in profile bio field executes in admin panel — privilege escalation possible
```

Bad (never use):
```
IDOR vulnerability found
Security issue in API
XSS in user input
```

## 13. HUMAN WRITING STYLE — MANDATORY

Reports are read by humans. Write like one.

NEVER use:
- Horizontal rules (--- or *** or ___) as decorators or separators
- Em-dashes (—) — use a regular hyphen or rewrite the sentence
- Unicode arrows (→, ⇒, ←, ⟶) — use -> or => like a developer would type
- Emojis anywhere in reports or PoC code — not in prose, not in code comments, not in titles
- Excessive bold/italic abuse — only bold section labels, nothing else
- AI filler phrases: "it's worth noting", "it's important to mention", "I hope this helps", "as mentioned above", "in conclusion", "to summarize"
- Excessive headers for a short report — one level of headers max unless the report is multi-bug
- Bullet points for everything — use prose for the summary and impact sections
- Markdown tables in the actual report body (CVSS header is fine, narrative is prose)
- Box-drawing characters (────, ═══, ╔══╗, etc.) — use plain hyphens (----) if a separator is needed in a comment
- Any character that requires copy-pasting or a special key combo to type — if a developer wouldn't type it from their keyboard, don't use it

DO use:
- Short, declarative sentences
- Active voice: "An attacker reads any user's invoice" not "Invoice data can be read by an attacker"
- Real numbers and endpoints, not abstract descriptions
- Line breaks between sections, not decorative separators
- ASCII-only punctuation: -> not →, => not ⇒, -- not —, ... not …

The goal: a senior security engineer wrote this, not a chatbot.

## 13. STRUCTURED POC FORMAT

Every PoC must answer all four lines. No exceptions.

```
Payload:  [the exact malicious input — string, HTTP body, JSON value]
Request:  [HTTP method + URL + headers + body, or exact CLI command]
Expected: [what should happen — the secure behavior]
Actual:   [what does happen — the vulnerable behavior, with evidence]
```

Example (IDOR):
```
Payload:  GET /api/invoices/9182 with Attacker's session token
Request:  curl -H "Authorization: Bearer ATTACKER_TOKEN" https://target.com/api/invoices/9182
Expected: 403 Forbidden (attacker does not own invoice 9182)
Actual:   200 OK — response contains victim's invoice data (name, amount, card last4)
```

If you cannot fill in "Actual" with real evidence → you do not have a reportable bug yet.

## 14. STRIDE / CWE QUICK REFERENCE

Include the STRIDE category and CWE in every report header. Use this table:

| STRIDE | Threat | Common CWEs |
|--------|--------|-------------|
| **Spoofing** | Identity forgery, session hijack, forged auth | CWE-306, CWE-287, CWE-601 |
| **Tampering** | Malicious input modifying data or behavior | CWE-89 (SQLi), CWE-78 (CMDi), CWE-79 (XSS), CWE-22 (Path traversal), CWE-352 (CSRF), CWE-502 (Deserialization), CWE-915 (Mass assignment), CWE-611 (XXE) |
| **Repudiation** | Ability to deny performing an action | CWE-778 (Insufficient logging) |
| **Information Disclosure** | Data leakage, PII exposure, enumeration | CWE-639 (IDOR), CWE-798 (Hardcoded creds), CWE-200 (Sensitive data exposure), CWE-209 (Error info in response) |
| **Denial of Service** | Crashing or degrading the service | CWE-400 (Uncontrolled resource consumption) |
| **Elevation of Privilege** | Gaining unauthorized permissions | CWE-862 (Missing authz), CWE-863 (Incorrect authz), CWE-269 (Improper privilege management) |

Report header format:
```
STRIDE: Tampering
CWE: CWE-89 (SQL Injection)
CVSS: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N (9.1)
Reachability: EXTERNAL
Exploitability: EASY
```

## 15. REACHABILITY + EXPLOITABILITY IN EVERY REPORT

Always include these two labels in the report summary. They justify your CVSS score.

**Reachability:** EXTERNAL / AUTHENTICATED / INTERNAL / UNREACHABLE
**Exploitability:** EASY / MEDIUM / HARD

```
EXTERNAL + EASY = Network/Low/None/None in CVSS — near-max score
AUTHENTICATED + MEDIUM = Network/Low/Low/None — mid-range score
INTERNAL + HARD = typically Medium or lower regardless of impact
```

Triagers trust scored reports that explain the scoring. Missing these labels signals "didn't think it through."

## 16. THE 5 REJECTION REASONS — PREVENT EVERY ONE

Every N/A, Informational, or "Not Applicable" response maps to one of these 5 reasons. Eliminate each before submitting.

### NOT REPRODUCIBLE

The triager could not reproduce your steps with what you provided.

Root causes:
- Missing exact HTTP request (you described it instead of showing it)
- Session token expired between your test and their reproduction
- Requires Burp match-and-replace / active scanner setup you didn't document
- Race condition that requires multiple simultaneous requests — didn't state hit rate
- Assumed the triager has the same environment, accounts, or test data

Prevention:
- Paste the exact curl command or raw HTTP request — nothing paraphrased
- Reproduce from a fresh session (new browser profile, new token) at least 2 times before submitting
- If it requires a second account: provide the exact setup for both accounts
- If race condition: show the number of parallel threads and hit rate (e.g., "3 of 5 concurrent requests succeed")
- Never submit if you cannot reproduce it yourself right now

### INFORMATIONAL

The bug exists but does not meet the program's minimum impact threshold.

Root causes:
- On the never-submit list without a chain
- CVSS < 4.0 standalone
- "Technically possible" language with no demonstrated harm
- Submitted a finding class the program excludes

Prevention:
- Check CVSS first — if < 4.0, build a chain or kill it
- Check the program's Vulnerability Disclosure Policy for excluded bug classes
- Never use: "could potentially", "may allow", "might be possible" — if you can't write a concrete sentence, you don't have a bug yet
- Read the never-submit list before touching the report template

### OUT OF SCOPE

The affected asset is not covered by the program.

Root causes:
- Tested a related domain that isn't listed
- Assumed *.target.com covers target.com
- Tested a third-party service the company uses
- Tested staging/dev when only prod is in scope
- Scope changed since you started hunting

Prevention:
- Verify the exact domain/asset on the scope page RIGHT NOW — not from memory from when you started hunting
- Wildcard *.target.com does NOT cover target.com (separate entry required)
- Third-party services (Zendesk, Salesforce, HubSpot, Stripe, Cloudflare, Google Auth, Intercom) are NEVER in scope unless the program says so explicitly
- If unsure, check ScopeChecker.is_in_scope() before any request

### SPAM / DUPLICATE

The same bug was already reported, or the submission is considered low-effort mass submission.

Root causes:
- Bug already filed by another researcher
- Same bug you found on a different endpoint filed separately instead of as one chain
- Same bug class reported across unrelated targets with copy-pasted description
- Already fixed (check changelog/git history)

Prevention:
- Search HackerOne Hacktivity: program name + bug class + endpoint — do this BEFORE writing the report
- Search GitHub issues on the target repo: endpoint name + security keyword
- Read the 5 most recent disclosed reports for this program
- If you find the same pattern on multiple endpoints, file ONE report covering all instances — not separate submissions
- Check git log for recent security fixes with the same pattern

### INVALID

The bug does not behave as you described, or does not exist.

Root causes:
- Code reading without PoC confirmation (especially source-code audits)
- Framework protection you missed (ORM, template escaping, middleware)
- Documented/intentional behavior
- Wrong endpoint or parameter in the report
- The program cannot reproduce it at all

Prevention:
- Run /validate and pass all 7 questions and 4 gates
- Never submit from code reading alone — always confirm with actual HTTP request/response
- Run the framework protection check (Prisma/SQLAlchemy, Django templates, Helmet.js, etc.)
- Run the adversarial skeptic: spend 5 minutes actively trying to disprove the finding
- Check the API docs / program's security FAQ — is this documented behavior?

## 17. MINIMUM IMPACT THRESHOLD — NEVER REPORT BELOW THIS

The goal of Helio is maximum payout per report. Informational and standalone low-impact
findings waste time and damage your validity ratio without generating any income.

**Never report these as standalone findings:**
```
Informational (zero payout on any serious program):
- Missing security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
- GraphQL introspection enabled (no sensitive data)
- Banner / version disclosure without a working exploit for that version
- Open redirect without a confirmed exploit chain (OAuth theft, phishing with high impact)
- SSRF with DNS callback only (no internal data, no cloud metadata)
- Self-XSS (requires victim to paste payload themselves)
- Missing cookie flags (Secure, HttpOnly, SameSite) without a working exploit
- Username/email enumeration when registration already reveals this
- Logout CSRF
- Rate limiting on non-sensitive forms
- Descriptive error messages when no sensitive data is leaked
- Missing audit logs
- Outdated TLS versions without a demonstrated downgrade attack
```

**Minimum bar to report:**
- Medium CVSS (4.0+) with demonstrated impact, OR
- Low CVSS but part of a confirmed exploit chain that reaches Medium or above, OR
- Any confirmed Critical/High regardless of class

**Ask before writing any report:** "Would a senior bug bounty hunter submit this?"
If uncertain — run /validate. If it does not pass Gate 1 (Impact) — kill it.

**The chain exception:** A finding below the minimum threshold CAN be included if it is
a necessary step in a confirmed attack chain with real impact. Always report the chain
together as one report, not as separate low/informational submissions.
