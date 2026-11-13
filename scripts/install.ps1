# enigma installer (Windows PowerShell) - latest enigma-cli, then deploys it.
#
#   irm https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.ps1 | iex
#
# Default (standalone): no npm, no Node required. Downloads the enigma-cli tarball and the Windows
# binary from the GitHub Release, verifies both against the release's SHA256SUMS, extracts them into
# %LOCALAPPDATA%\enigma\cli\<version> (current version recorded in ...\cli\current), writes an
# `enigma` command to %LOCALAPPDATA%\enigma\bin and adds that folder to your user PATH.
# `enigma update` later updates it the same way.
#
# Environment:
#   ENIGMA_INSTALL=npm              install with `npm install -g enigma-cli@latest` instead
#   ENIGMA_INSTALL_VERSION=1.2.3    pin a release (default: the latest)
#   ENIGMA_DOWNLOAD_BASE=<url>      mirror holding ONE release's assets (https:// or file://)
#   ENIGMA_PREFIX=<dir>             where versions live (default %LOCALAPPDATA%\enigma\cli)
#   ENIGMA_BIN_DIR=<dir>            where the `enigma` command goes (default %LOCALAPPDATA%\enigma\bin)
#   ENIGMA_NO_SETUP=1               install only; skip `enigma install`
#   ENIGMA_INSTALL_ARGS="..."       arguments for `enigma install` (e.g. "--all --yes")
#   ENIGMA_NO_PATH=1                do not add the command folder to the user PATH
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
    $releases = "https://github.com/FJRG2007/enigma/releases"
    # Mutated by the functions below (a hashtable is shared by reference across their scopes).
    $state = @{ ok = $true }
    $installArgs = @()
    if ($env:ENIGMA_INSTALL_ARGS) { $installArgs = @($env:ENIGMA_INSTALL_ARGS -split "\s+" | Where-Object { $_ }) }

    # Run `enigma install` through $runner (a command name or path), honoring the env options.
    function Invoke-Setup([string] $runner) {
        if ($env:ENIGMA_NO_SETUP) {
            Write-Host "enigma: installed. Skipping setup (ENIGMA_NO_SETUP). Run 'enigma install' to deploy it to your agents."
            return
        }
        $setupArgs = $installArgs
        if ($setupArgs.Count -eq 0 -and [Console]::IsInputRedirected) {
            Write-Host "enigma: no terminal available - deploying defaults (run 'enigma' later to customize)."
            $setupArgs = @("--all", "--yes")
        }
        Write-Host "enigma: setting up your agents..."
        # A console program inherits this console, so enigma's prompts work even though this
        # script arrived over `irm ... | iex`.
        & $runner install @setupArgs
        if ($LASTEXITCODE -ne 0) { Write-Host "enigma: 'enigma install' exited $LASTEXITCODE."; $state.ok = $false }
    }

    function Install-Npm {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            Write-Host "enigma: npm not found. Install Node.js first (https://nodejs.org), or drop ENIGMA_INSTALL=npm to install without it."
            $state.ok = $false
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
            $state.ok = $false
            return
        }
        Invoke-Setup "enigma"
    }

    # Download $url to $dest. Only https:// (and file:// for a local mirror); TLS is verified.
    function Get-Asset([string] $url, [string] $dest) {
        if ($url -match "^file://") {
            Copy-Item -LiteralPath ([uri] $url).LocalPath -Destination $dest -ErrorAction Stop
            return
        }
        if ($url -notmatch "^https://") { throw "refusing non-HTTPS download URL: $url" }
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
    }

    # Parse SHA256SUMS (`<hex>  [*]<name>` per line) into a name -> hash table.
    function Read-Sums([string] $path) {
        $sums = @{}
        foreach ($line in Get-Content -LiteralPath $path) {
            if ($line.Trim() -match "^([0-9a-fA-F]{64})\s+\*?(\S+)$") { $sums[$Matches[2]] = $Matches[1].ToLower() }
        }
        return $sums
    }

    function Assert-Sha256([string] $path, [string] $name, $sums) {
        if (-not $sums.ContainsKey($name)) { throw "$name is not listed in SHA256SUMS; refusing to install it" }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower()
        if ($actual -ne $sums[$name]) { throw "checksum mismatch for ${name}: expected $($sums[$name]), got $actual" }
    }

    function Install-Standalone {
        # Windows PowerShell 5.1 defaults to TLS 1.0/1.1, which GitHub refuses.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
        $data = Join-Path $env:LOCALAPPDATA "enigma"
        $prefix = if ($env:ENIGMA_PREFIX) { $env:ENIGMA_PREFIX } else { Join-Path $data "cli" }
        $bindir = if ($env:ENIGMA_BIN_DIR) { $env:ENIGMA_BIN_DIR } else { Join-Path $data "bin" }
        $pin = if ($env:ENIGMA_INSTALL_VERSION) { $env:ENIGMA_INSTALL_VERSION.TrimStart("v") } else { "" }
        if ($env:ENIGMA_DOWNLOAD_BASE) { $base = $env:ENIGMA_DOWNLOAD_BASE.TrimEnd("/") }
        elseif ($pin) { $base = "$releases/download/v$pin" }
        else { $base = "$releases/latest/download" }

        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("enigma-install-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        try {
            Write-Host "enigma: reading release checksums from $base..."
            Get-Asset "$base/SHA256SUMS" (Join-Path $tmp "SHA256SUMS")
            $sums = Read-Sums (Join-Path $tmp "SHA256SUMS")
            $cliAsset = $sums.Keys | Where-Object { $_ -match "^enigma-cli-(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)\.tgz$" } | Select-Object -First 1
            if (-not $cliAsset) { throw "SHA256SUMS at $base lists no enigma-cli tarball" }
            $version = $cliAsset.Substring("enigma-cli-".Length) -replace "\.tgz$", ""
            if ($pin -and $version -ne $pin) { throw "release at $base is enigma-cli $version, not $pin" }
            # Download from that exact tag from here on: `latest` may move between two requests.
            if (-not $env:ENIGMA_DOWNLOAD_BASE) { $base = "$releases/download/v$version" }
            $binAsset = "enigma-win32-$arch.exe"
            if (-not $sums.ContainsKey($binAsset)) { throw "release v$version has no binary for win32-$arch" }

            Write-Host "enigma: downloading enigma-cli $version ($binAsset)..."
            $tgz = Join-Path $tmp $cliAsset
            $exe = Join-Path $tmp $binAsset
            Get-Asset "$base/$cliAsset" $tgz
            Assert-Sha256 $tgz $cliAsset $sums
            Get-Asset "$base/$binAsset" $exe
            Assert-Sha256 $exe $binAsset $sums

            New-Item -ItemType Directory -Force -Path $prefix, $bindir | Out-Null
            $staging = Join-Path $prefix ".staging-$PID"
            if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
            New-Item -ItemType Directory -Path $staging | Out-Null
            # The system bsdtar, by full path: a Git for Windows tar earlier on PATH reads `C:` as a host.
            & (Join-Path $env:SystemRoot "System32\tar.exe") -xzf $tgz -C $staging
            if ($LASTEXITCODE -ne 0) { throw "could not extract $cliAsset (tar exit $LASTEXITCODE)" }
            $pkg = Join-Path $staging "package"
            if (-not (Test-Path -LiteralPath (Join-Path $pkg "package.json"))) { throw "$cliAsset did not contain package/package.json" }
            Copy-Item -LiteralPath $exe -Destination (Join-Path $pkg "bin\enigma-bin.exe")
            [IO.File]::WriteAllText((Join-Path $pkg "install-method"), "standalone`n")
            $dest = Join-Path $prefix $version
            if (Test-Path -LiteralPath $dest) {
                # Reinstalling the same version: a running enigma-bin.exe can be renamed, not deleted.
                $old = Join-Path $prefix ".old-$version-$PID"
                Rename-Item -LiteralPath $dest -NewName (Split-Path $old -Leaf)
                Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
            }
            Move-Item -LiteralPath $pkg -Destination $dest
            Remove-Item -LiteralPath $staging -Recurse -Force
            $pointer = Join-Path $prefix "current.tmp-$PID"
            [IO.File]::WriteAllText($pointer, "$version`n")
            Move-Item -LiteralPath $pointer -Destination (Join-Path $prefix "current") -Force

            # Kept identical to the one scripts/install.sh writes under Git Bash.
            $shim = @(
                "@echo off",
                "setlocal",
                "set `"ENIGMA_ROOT=$prefix`"",
                "set /p ENIGMA_CUR=<`"%ENIGMA_ROOT%\current`"",
                "set `"ENIGMA_PKG=%ENIGMA_ROOT%\%ENIGMA_CUR%`"",
                "if defined ENIGMA_NO_NODE goto bin",
                "where node >nul 2>nul || goto bin",
                "node `"%ENIGMA_PKG%\bin\enigma.mjs`" %*",
                "exit /b %ERRORLEVEL%",
                ":bin",
                "set `"ENIGMA_ASSETS_DIR=%ENIGMA_PKG%\assets`"",
                "set `"ENIGMA_GUARD_PATH=%ENIGMA_PKG%\dist\guard.js`"",
                "set `"ENIGMA_GUARDRAILS_PATH=%ENIGMA_PKG%\dist\guardrails.js`"",
                "set `"ENIGMA_TRIM_PATH=%ENIGMA_PKG%\dist\trim.js`"",
                "set `"ENIGMA_VERSION=%ENIGMA_CUR%`"",
                "`"%ENIGMA_PKG%\bin\enigma-bin.exe`" %*",
                "exit /b %ERRORLEVEL%"
            ) -join "`r`n"
            $shimPath = Join-Path $bindir "enigma.cmd"
            [IO.File]::WriteAllText($shimPath, "$shim`r`n", [Text.Encoding]::ASCII)
            Write-Host "enigma: installed enigma-cli $version to $dest"
        } catch {
            Write-Host "enigma: $($_.Exception.Message)"
            $state.ok = $false
            if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
            return
        } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }

        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $onPath = @($userPath -split ";") -contains $bindir
        if (-not $onPath -and -not $env:ENIGMA_NO_PATH) {
            [Environment]::SetEnvironmentVariable("Path", (@($bindir) + @($userPath -split ";" | Where-Object { $_ }) -join ";"), "User")
            Write-Host "enigma: added $bindir to your user PATH (new terminals pick it up)."
        } elseif (-not $onPath) {
            Write-Host "enigma: $bindir is not on your PATH (ENIGMA_NO_PATH). Call $shimPath directly or add it yourself."
        }
        if (@($env:Path -split ";") -notcontains $bindir) { $env:Path = "$bindir;$env:Path" }
        $found = (Get-Command enigma -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if ($found -and $found -ne $shimPath) { Write-Host "enigma: note: 'enigma' resolves to $found (another install) in this session." }
        Invoke-Setup $shimPath
    }

    switch ($(if ($env:ENIGMA_INSTALL) { $env:ENIGMA_INSTALL } else { "standalone" })) {
        "standalone" { Install-Standalone }
        "npm" { Install-Npm }
        default { Write-Host "enigma: ENIGMA_INSTALL must be 'standalone' or 'npm' (got '$env:ENIGMA_INSTALL')."; $state.ok = $false }
    }

    if ($state.ok) { Write-Host "enigma: done. Run 'enigma' anytime for the interactive hub." }
}
