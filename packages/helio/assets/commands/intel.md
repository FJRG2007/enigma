---
description: Fetch intel on a target — CVE data, disclosed reports, program history. Usage: /intel target.com
---

# /intel

Fetch CVE and disclosure intel for a target.

## What This Does

1. Checks for CVEs related to target's tech stack
2. Searches HackerOne/Bugcrowd for disclosed reports
3. Analyzes program disclosure history
4. Provides hunting recommendations

## Usage

```
!intel target.com
```

## Sources

- CVE databases
- HackerOne Hacktivity
- Bugcrowd disclosures
- Intigriti/Immunefi

## Example Output

```
INTEL: target.com
══════════════════════════════════════

## CVEs
- CVE-2024-XXXX: Related to detected version
- CVE-2023-YYYY: Common in similar apps

## Disclosure Patterns
- H1: 3 IDOR reports (last 6 months)
- Avg payout: $1,500
- Common: numeric IDOR in /api/users/{id}

## Recommendations
- Focus on IDOR (proven pattern)
- Check OAuth redirect_uri
- Test GraphQL for introspection
```