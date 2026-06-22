# enigma installer (Windows PowerShell) - latest enigma-cli, then deploys it.
#
#   irm https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.ps1 | iex
#
# Clears the npm cache first (so you always get the newest published version),
# installs the `enigma` command globally, and runs `enigma install` for you.
#
# We deliberately do NOT set `$ErrorActionPreference = "Stop"`: npm writes its warnings
# (e.g. "using --force") to stderr, which PowerShell 5.1 would otherwise turn into a
# terminating NativeCommandError. We check exit codes explicitly instead.

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "enigma: npm not found. Install Node.js first: https://nodejs.org"
    exit 1
}

Write-Host "enigma: clearing the npm cache (forces the latest version)..."
npm cache clean --force 2>$null

Write-Host "enigma: installing enigma-cli globally..."
npm install -g enigma-cli@latest
if ($LASTEXITCODE -ne 0) {
    Write-Host "enigma: npm install failed (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

Write-Host "enigma: deploying skills and memory..."
enigma install --all --yes

Write-Host "enigma: done. Run 'enigma' for the interactive hub."
