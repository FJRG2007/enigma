---
name: opsec
description: Operational security — scan rate limits, user-agent rotation, traffic shaping, evidence handling, detection awareness, scope enforcement, and anti-detection patterns for bug bounty and VAPT engagements.
---

# Operational Security (OPSEC)

OPSEC keeps the engagement covert, controlled, and within authorized scope. Poor OPSEC triggers WAF/IDS, burns the engagement, taints findings, and can get your account banned on bug bounty platforms.

## Pre-Engagement Checklist

Before ANY active operation:
- [ ] Written authorization (RoE, program policy, or signed SOW) confirmed
- [ ] In-scope asset list extracted and written down
- [ ] Out-of-scope list explicitly noted
- [ ] Testing window defined (for VAPT engagements)
- [ ] Emergency contact accessible (for VAPT engagements)

## Scan Rate Limits

| Target Type | Recommended Rate | Tool Flag |
|-------------|-----------------|-----------|
| Production web server | 5-10 req/sec | `ffuf -rate 5` |
| Bug bounty target | 10-20 req/sec | `nuclei -rl 10` |
| Internal network (VAPT) | 50-100 req/sec | `nmap -T3` |
| WAF-protected | 1-5 req/sec | custom delays |
| High-security target | 1-2 req/sec | `nmap -T1` |

```bash
# ffuf with rate limiting
ffuf -u https://TARGET/FUZZ -w wordlist.txt -rate 10 -p 0.1

# nuclei conservative
nuclei -u https://TARGET -rl 5 -c 2 -timeout 10

# nmap conservative
nmap -sS --max-rate 10 --max-retries 1 -p 80,443,8080,8443 TARGET

# curl loop with delay
while read url; do
    curl -s -o /dev/null -w "%{http_code} $url\n" "$url"
    sleep 0.2
done < urls.txt
```

## User-Agent Rotation

Tool default user-agents are logged and flagged. Always override.

```bash
# Current UA examples — update version numbers to match current stable releases
UA_LIST=(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0"
)
UA="${UA_LIST[$RANDOM % ${#UA_LIST[@]}]}"

# Apply to tools:
curl -s -A "$UA" https://TARGET/
ffuf -u https://TARGET/FUZZ -w list.txt -H "User-Agent: $UA"
nuclei -u https://TARGET -H "User-Agent: $UA"
```

Headers that expose scanner identity:
- `"Nmap Scripting Engine"` — nmap default
- `"nikto"` — nikto default
- `"gobuster"` — gobuster default
- `"sqlmap"` — sqlmap default

## Traffic Shaping

**Timing matters:**
- Business hours (9am-5pm target TZ) → scans blend with user traffic
- Weekends/holidays → lower baseline, scans stand out
- Burst → pause → burst: less detectable than sustained scanning

**Randomize wordlists and host order:**
```bash
# Randomize wordlist order before ffuf
shuf wordlist.txt > wordlist_rand.txt

# Randomize nmap host order (VAPT multi-host)
nmap -sS --randomize-hosts -iL targets.txt

# Random delay between requests (0.1 to 0.5 sec)
ffuf -u https://TARGET/FUZZ -w list.txt -p '0.1-0.5'
```

## Tool Signature Reduction

| Tool | Signature | Mitigation |
|------|-----------|------------|
| nmap | SYN pattern, probe ordering | `-T2`, `--data-length 24`, `-g 53` |
| nuclei | Template-specific payloads | `-rl 5`, selective templates `-t` |
| ffuf | Rapid sequential requests | `-rate`, `-p` delay |
| sqlmap | Parameter tampering patterns | `--delay=2`, `--level=1` |
| dirsearch | Sequential path enum | `--random-agent`, `--delay=0.3` |

```bash
# nmap with obfuscation
nmap -sS --data-length 24 -T2 TARGET          # Random packet padding
nmap -sS -g 53 TARGET                          # Appear as DNS traffic
nmap -sS -g 80 TARGET                          # Appear as HTTP traffic
```

## Detection Indicators

Signs you've been detected:
- **Connection resets** — firewall rule just added
- **429 responses** where 200s were before — WAF triggered
- **Timeouts** on previously responsive hosts — IP banned
- **Unusually permissive targets** — possible honeypot
- **Extremely slow responses** — tarpit, deliberately slowing scanner

Response to detection:
1. Pause all scanning — at least 30 minutes
2. Review recent scan patterns for what triggered it
3. Reduce rate by 50-75%
4. Switch to passive-only for a period
5. Document detection event

## Evidence Handling

```markdown
## Engagement Action Log

| Timestamp (UTC)    | Action          | Target            | Tool    | Justification            |
|--------------------|-----------------|-------------------|---------|--------------------------|
| 2026-04-22 14:23   | Subdomain enum  | example.com       | subfinder | In-scope root domain  |
| 2026-04-22 14:31   | Dir fuzzing     | api.example.com   | ffuf    | Live host, 443 open      |
```

Data rules:
- Credentials found → document, never store plaintext
- PII discovered → note existence, do not exfiltrate
- All scan output → `recon/<target>/` directory

## Scope Enforcement

```bash
# Before testing, verify target is in scope
SCOPE_FILE="scope.txt"
TARGET="api.target.com"

if grep -qF "$TARGET" "$SCOPE_FILE"; then
    echo "IN SCOPE — proceed"
else
    echo "WARNING: $TARGET not in scope file — verify before proceeding"
fi
```

Scope boundaries:
- **Domains**: only enumerate subdomains of authorized root domains
- **Wildcards**: `*.target.com` does NOT cover `target.com` itself
- **Cloud**: only test resources confirmed as client-owned
- **Third-party**: CDNs, SaaS platforms, shared infra are out of scope
- **Accidental out-of-scope**: stop, document, notify lead — do NOT clean up evidence

## Bug Bounty OPSEC Specifics

Unlike VAPT, bug bounty targets are not aware of testing. Extra constraints:
- Never use automated scanners on endpoints that accept payments, send emails, or affect other users
- Use `--dry-run` or `--simulate` flags when available
- Test on staging/dev instances when possible
- Keep request volume proportional to what a power user would generate
- One test account per target — do not create multiple accounts unless the program explicitly allows it
- Never store or exfiltrate user data found during testing, even as proof
