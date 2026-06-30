---
description: Run full recon pipeline on a target — subdomain enum, live host discovery, URL crawl, nuclei scan. Usage: /recon target.com
---

# /recon

Run the full recon pipeline on a target and produce a prioritized attack surface.

## What This Does

1. Enumerates subdomains (subfinder, assetfinder, chaos)
2. Resolves DNS and finds live hosts (dnsx + httpx)
3. Crawls URLs (katana, waybackurls, gau)
4. Classifies URLs by bug class (gf patterns)
5. Runs nuclei for known CVEs and misconfigs

## Usage

```
!recon target.com
```

## Steps

### Subdomain Enumeration

```bash
subfinder -d $TARGET -silent | anew recon/$TARGET/subdomains.txt
assetfinder --subs-only $TARGET | anew recon/$TARGET/subdomains.txt
echo "[+] Subdomains: $(wc -l < recon/$TARGET/subdomains.txt)"
```

### Live Host Discovery

```bash
cat recon/$TARGET/subdomains.txt \
  | dnsx -silent \
  | httpx -silent -status-code -title -tech-detect \
  | tee recon/$TARGET/live-hosts.txt

echo "[+] Live hosts: $(wc -l < recon/$TARGET/live-hosts.txt)"
```

### URL Crawl

```bash
cat recon/$TARGET/live-hosts.txt | awk '{print $1}' \
  | katana -d 3 -jc -kf all -silent \
  | anew recon/$TARGET/urls.txt

echo $TARGET | waybackurls | anew recon/$TARGET/urls.txt
gau $TARGET --subs | anew recon/$TARGET/urls.txt
```

### Nuclei Scan

```bash
nuclei -l recon/$TARGET/live-hosts.txt \
  -severity critical,high,medium \
  -o recon/$TARGET/nuclei.txt
```

## Output

After running, you will have in `recon/<target>/`:
- subdomains.txt — All discovered subdomains
- live-hosts.txt — Live hosts with status/title/tech
- urls.txt — All crawled URLs
- api-endpoints.txt — API-specific paths
- nuclei.txt — Known CVE/misconfig findings

## 5-Minute Rule

If after running this pipeline:
- All hosts return 403 or static pages
- No API endpoints visible
- No interesting parameters
- nuclei returns 0 findings

**→ Move on to a different target.**