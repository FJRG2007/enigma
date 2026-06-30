---
description: Write a submission-ready bug bounty report. Generates H1/Bugcrowd/Intigriti/Immunefi format with CVSS 3.1 score, proof of concept, impact statement, and remediation. Run /validate first. Usage: /report
tui: opencode
---

# /report

Generate a submission-ready bug bounty report.

## Pre-Conditions

Run `/validate` first. All 4 gates must pass before running this command.

Never write a report before validating. N/A submissions hurt your validity ratio.

## Rejection Prevention Checklist

The 5 most common rejection reasons. Check all before writing a single word.

**NOT REPRODUCIBLE:**
```
[ ] Reproduced from completely fresh session (new browser/token) at least 2 times
[ ] HTTP request is copy-pasteable as-is -- no "replace your token" ambiguity
[ ] Steps work for someone who has never seen your setup
[ ] No Burp-only artifacts (match-and-replace rules, active scanner injections)
[ ] If race condition: reproduce rate documented (X out of Y attempts)
```

**INFORMATIONAL:**
```
[ ] CVSS >= 4.0 confirmed, OR it is a confirmed step in a chain that reaches >= 4.0
[ ] Not on the never-submit list as a standalone finding
[ ] Impact proves concrete harm -- not "could be used to..."
```

**OUT OF SCOPE:**
```
[ ] Exact domain/asset verified on program scope page RIGHT NOW (not from memory)
[ ] Not a third-party service (Zendesk, Salesforce, HubSpot, Stripe, Google Auth, Intercom)
[ ] Not explicitly in the out-of-scope list
[ ] Staging/dev/internal only in scope if program explicitly says so
[ ] Wildcard *.target.com does NOT cover target.com -- checked both
```

**SPAM / DUPLICATE:**
```
[ ] Searched HackerOne Hacktivity: program name + bug class + endpoint name
[ ] Searched GitHub issues on target repo: endpoint + security keyword
[ ] Read the 5 most recent disclosed reports for this program
[ ] Not already fixed, documented, or in the program changelog
[ ] Not submitting the same pattern across unrelated endpoints as separate reports
```

**INVALID:**
```
[ ] /validate run and ALL 7 questions + 4 gates passed
[ ] Bug demonstrated by actual HTTP response (not inferred from code reading)
[ ] Not a framework false positive (ORM/template/middleware protection checked)
[ ] Not documented / intentional program behavior
[ ] Confidence >= 70 assigned
```

If any box fails -- stop. Fix it or kill the finding.

### Impact Gate — Run Before Anything Else

Before spending time on a report, confirm the finding meets the minimum payout threshold:

```
[ ] CVSS >= 4.0 (Medium or above), OR
[ ] Part of a confirmed exploit chain that reaches CVSS >= 4.0

If neither: STOP. Do not write the report. The finding is not reportable.
```

Informational and standalone low-impact findings are zero-payout on every serious program.
They also count against your validity ratio. The only exception is when they are a
confirmed step in a chain -- in that case, include them as part of the chain report, not
as a separate submission.

## Usage

```
/report
```

Provide when prompted:
- Platform (HackerOne / Bugcrowd / Intigriti / Immunefi)
- Bug class
- Affected endpoint
- Your two test accounts and their IDs
- The exact HTTP request that demonstrates the bug
- The exact response that shows the impact
- Tech stack (for CVSS and remediation advice)

## What This Generates

1. Title following the formula: `[Bug Class] in [Endpoint] allows [actor] to [impact]`
2. Summary paragraph (impact-first, no "could potentially")
3. Vulnerability details with CVSS 3.1 score and vector string
4. Steps to Reproduce with copy-paste HTTP requests
5. Impact statement with quantification
6. Recommended fix (1-2 sentences, specific)
7. Supporting materials section

## Platform Selection

### HackerOne Format
- Markdown sections: Summary, Vulnerability Details, Steps to Reproduce, Impact, Recommended Fix
- Include CVSS 3.1 score + vector string
- Include two test account setup instructions
- Keep under 600 words

### Bugcrowd Format
- Title with VRT category: `[VRT Category] > [Subcategory] > P[1-4]`
- Expected vs Actual Behavior section
- Severity Justification section referencing Bugcrowd VRT

### Intigriti Format
- CVSS score prominent at top
- Clear reproduction steps
- Business impact focused

### Immunefi Format (Web3)
- Root cause in Solidity code
- Foundry PoC test included
- Economic impact quantified in $ value
- Comparison evidence (same check present elsewhere, missing here)

## Proof of Concept — Always Required

Every report must include a working PoC section. No exceptions.

PoC format for HTTP bugs:
```
curl -s -X <METHOD> "https://target.com/endpoint" \
  -H "Authorization: Bearer ATTACKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"param": "payload"}'

# Expected: 403 Forbidden
# Actual: 200 OK -- returns victim's data
```

For automated reports (autopilot/hunt): generate the PoC from collected request/response data. Do not skip it.

## Writing Rules

1. **Never use:** "could potentially", "may allow", "might be possible"
2. **Always prove:** show actual data/action, not just "200 OK"
3. **Impact first:** sentence 1 = what attacker gets, not what the bug is
4. **Quantify:** how many users affected, what data type, $ amount
5. **Short:** triagers skim. < 600 words.
6. **Human:** write to a person, not a chatbot

## Human Style Rules

These are non-negotiable:

- No horizontal rules (--- or ***) as visual separators
- No em-dashes (—) -- use a hyphen or rewrite the sentence
- No unicode arrows (→, ⇒, ←) -- use -> or => instead
- No emojis anywhere: not in prose, not in code comments, not in titles
- No box-drawing characters (────, ═══, ╔══╗) -- use plain hyphens (----) in code comments if a separator is needed
- No special characters that require copy-paste to type -- ASCII only
- No AI filler: "it's worth noting", "in conclusion", "to summarize", "I hope this helps"
- No excessive markdown headers -- one level max for a standard single-bug report
- Summary and impact sections are prose, not bullet lists
- Every sentence earns its place -- cut anything that doesn't add information

## CVSS 3.1 Calculation Guide

Common patterns:
```
IDOR read PII (any user, auth needed):
→ AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N = 6.5 Medium

Auth bypass → admin (no auth):
→ AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H = 9.8 Critical

SSRF → cloud metadata:
→ AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:N = 9.1 Critical

Stored XSS (any user, scope changed):
→ AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:N = 8.2 High
```

## Escalation Language

Use when payout is being downgraded:
```
"This requires only a free account — no special privileges."
"The exposed data includes [PII type], subject to GDPR/CCPA requirements."
"An attacker can automate this — all [N] records in [X] minutes with a simple loop."
"This is exploitable externally without any internal network access."
"The impact is equivalent to a full data breach of [feature/data type]."
```

## Final Checklist Before Submitting

```
[ ] Title follows formula
[ ] First sentence states exact impact
[ ] HTTP request is copy-pasteable
[ ] Response showing impact included
[ ] Two accounts used (not self-testing)
[ ] CVSS calculated and included
[ ] Fix: 1-2 sentences
[ ] No typos in endpoint/param names
[ ] Under 600 words
[ ] Severity matches impact (no overclaiming)
[ ] NEVER used "could potentially"
```