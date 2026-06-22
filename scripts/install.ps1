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

    # On Windows, a running enigma binary (e.g. the 'always' dashboard daemon) holds
    # enigma-bin.exe open, so npm's update fails with EBUSY ("resource busy or locked,
    # copyfile ... enigma-bin.exe"). If the first attempt fails, free the lock by stopping
    # the binary and retry once.
    Write-Host "enigma: installing enigma-cli globally..."
    $installed = $false
    foreach ($attempt in 1, 2) {
        cmd /c "npm install -g enigma-cli@latest"
        if ($LASTEXITCODE -eq 0) { $installed = $true; break }
        if ($attempt -eq 1) {
            Write-Host "enigma: install failed (exit $LASTEXITCODE) - a running enigma may be locking the binary. Stopping it and retrying once..."
            Get-Process -Name "enigma-bin" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
    if (-not $installed) {
        Write-Host "enigma: npm install still failing (exit $LASTEXITCODE). Close any running 'enigma' (including a background dashboard) and re-run. Your terminal stays open."
        return
    }

    Write-Host "enigma: setting up your agents (answer the prompts)..."
    # Interactive: cmd /c keeps the real console attached, so enigma's prompts work even
    # though this script arrived over `irm ... | iex`.
    cmd /c "enigma install"

    Write-Host "enigma: done. Run 'enigma' anytime for the interactive hub."
}
