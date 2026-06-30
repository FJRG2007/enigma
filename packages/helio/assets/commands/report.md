---
description: Generate a submission-ready report. Run /validate first. Usage: /report
---

# /report

Write a bug bounty report from validated findings.

## Pre-Conditions

Run `/validate` first. All 4 gates must pass before running this command.

Never write a report before validating. N/A submissions hurt your validity ratio.

## Rejection Prevention Checklist

The 5 most common rejection reasons. Check all before writing a single word.

**NOT REPRODUCIBLE:**
```
[ ] Reproduced from completely fresh session (new browser/token) at least 2 times
[ ] HTTP request is copy-pasteable as-is — no "replace your token" ambiguity
[ ] Steps work for someone who has never seen your setup
[ ] No Burp-only artifacts (match-and-replace rules, active scanner injections)
[ ] If race condition: reproduce rate documented (X out of Y attempts)
```

**INFORMATIONAL:**
```
[ ] CVSS >= 4.0 confirmed, OR it is a confirmed step in a chain that reaches >= 4.0
[ ] Not on the never-submit list as a standalone finding
[ ] Impact proves concrete harm — not "could be used to..."
```

**OUT OF SCOPE:**
```
[ ] Exact domain/asset verified on program scope page RIGHT NOW (not from memory)
[ ] Not a third-party service (Zendesk, Salesforce, HubSpot, Stripe, Google Auth, Intercom)
[ ] Not explicitly in the out-of-scope list
[ ] Staging/dev/internal only in scope if program explicitly says so
[ ] Wildcard *.target.com does NOT cover target.com — checked both
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

If any box fails → stop. Fix it or kill the finding.

## Impact Gate

Before writing, confirm minimum threshold:
```
[ ] CVSS >= 4.0 (Medium or above), OR
[ ] Part of a confirmed exploit chain that reaches CVSS >= 4.0

If neither: STOP. Do not write the report.
```

## Usage

```
/report
/report --platform hackerone
```

## Output Sections

1. Title: `[Bug Class] in [Endpoint] allows [actor] to [impact]`
2. Summary (impact-first, no "could potentially")
3. Steps to Reproduce with copy-paste HTTP requests
4. Proof of Concept (always required)
5. Impact (quantified)
6. CVSS 3.1 score + vector
7. Remediation (1-2 sentences, specific)

## Proof of Concept — Always Required

```
curl -s -X METHOD "https://target.com/endpoint" \
  -H "Authorization: Bearer ATTACKER_TOKEN" \
  -d '{"param": "payload"}'

# Expected: 403
# Actual: 200 -- victim data returned
```

For OSS scope: include payload labeled "NOT EXECUTED IN PRODUCTION — code-confirmed."

## Platform Selection

**HackerOne:** Summary / Vulnerability Details / Steps to Reproduce / Impact / Recommended Fix. CVSS 3.1 vector. < 600 words.

**Bugcrowd:** VRT category in title. Expected vs Actual Behavior. Severity Justification referencing VRT.

**Intigriti:** CVSS prominent. Clear steps. Business impact focused.

**Immunefi (Web3):** Root cause in code. Foundry PoC. Economic impact in $ quantified.

## Writing Rules

1. Never use: "could potentially", "may allow", "might be possible"
2. Always prove: show actual data/action, not just "200 OK"
3. Impact first: sentence 1 = what attacker gets
4. Quantify: users affected, data type, $ amount
5. Short: triagers skim — < 600 words
6. Human: write to a person, not a chatbot

## Human Style Rules

Non-negotiable:
- No horizontal rules (--- or ***) as separators
- No em-dashes (—) — use hyphen or rewrite
- No unicode arrows (→, ⇒, ←) — use -> or =>
- No emojis anywhere
- No box-drawing characters — plain hyphens (----) only
- No AI filler ("it's worth noting", "in conclusion", "to summarize")
- Prose for summary and impact — not bullet lists
- One header level max for single-bug reports
- Active voice, short sentences

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
[ ] Rejection prevention checklist passed
```
