# enigma installer (Windows PowerShell) - latest enigma-cli, then deploys it.
#
#   irm https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.ps1 | iex
#
# Clears the npm cache first (so you always get the newest published version),
# installs the `enigma` command globally, and runs `enigma install` for you.
#
# IMPORTANT: run via `iex`, this code executes IN your current PowerShell session, so it must
# NEVER call `exit` - that would close your terminal. The whole body runs inside a scriptblock
# (`& { ... }`) and uses `return`, so a failure stops the installer without killing the session.
#
# npm writes warnings/progress to stderr. In a session where $ErrorActionPreference is "Stop"
# (common, and inherited when this runs via `irm ... | iex`), PowerShell 5.1 turns native-command
# stderr into a terminating NativeCommandError. Two safeguards: force "Continue" for this run, and
# invoke npm through `cmd /c` so its stderr is handled by cmd and never enters PowerShell's error
# stream. Exit codes are checked explicitly.

& {
    $ErrorActionPreference = "Continue"

    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "enigma: npm not found. Install Node.js first: https://nodejs.org"
        return
    }

    Write-Host "enigma: clearing the npm cache (forces the latest version)..."
    cmd /c "npm cache clean --force >NUL 2>NUL"

    Write-Host "enigma: installing enigma-cli globally..."
    cmd /c "npm install -g enigma-cli@latest"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "enigma: npm install failed (exit $LASTEXITCODE). Your terminal stays open; fix the error above and re-run."
        return
    }

    Write-Host "enigma: setting up your agents (answer the prompts)..."
    # Interactive: cmd /c keeps the real console attached, so enigma's prompts work even
    # though this script arrived over `irm ... | iex`.
    cmd /c "enigma install"

    Write-Host "enigma: done. Run 'enigma' anytime for the interactive hub."
}
