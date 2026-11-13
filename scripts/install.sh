#!/bin/sh
# enigma installer - installs the latest enigma-cli, then deploys it.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.sh | sh
#
# Default (standalone): no npm, no Node required. Downloads the enigma-cli tarball and this
# host's binary from the GitHub Release, verifies both against the release's SHA256SUMS, extracts
# them into ~/.enigma/cli/<version> (current version recorded in ~/.enigma/cli/current) and writes
# an `enigma` command to ~/.local/bin. `enigma update` later updates it the same way.
#
# Environment:
#   ENIGMA_INSTALL=npm              install with `npm install -g enigma-cli@latest` instead
#   ENIGMA_INSTALL_VERSION=1.2.3    pin a release (default: the latest)
#   ENIGMA_DOWNLOAD_BASE=<url>      mirror holding ONE release's assets (https:// or file://)
#   ENIGMA_PREFIX=<dir>             where versions live (default ~/.enigma/cli)
#   ENIGMA_BIN_DIR=<dir>            where the `enigma` command goes (default ~/.local/bin)
#   ENIGMA_NO_SETUP=1               install only; skip `enigma install`
#   ENIGMA_INSTALL_ARGS="..."       arguments for `enigma install` (or pass them: | sh -s -- --all --yes)
set -e

RELEASES="https://github.com/FJRG2007/enigma/releases"

say() { echo "enigma: $*"; }
die() { echo "enigma: $*" >&2; exit 1; }

if [ "$#" -eq 0 ] && [ -n "${ENIGMA_INSTALL_ARGS:-}" ]; then
  # Word splitting is the point: the variable carries several arguments.
  # shellcheck disable=SC2086
  set -- $ENIGMA_INSTALL_ARGS
fi

# Run `enigma install` with whatever runs enigma ($1), then the pass-through arguments.
setup() {
  runner="$1"
  shift
  if [ -n "${ENIGMA_NO_SETUP:-}" ]; then
    say "installed. Skipping setup (ENIGMA_NO_SETUP). Run 'enigma install' to deploy it to your agents."
    return 0
  fi
  if [ "$#" -gt 0 ]; then
    say "setting up your agents: enigma install $*"
    "$runner" install "$@" </dev/null
    return
  fi
  say "setting up your agents (answer the prompts)..."
  # Prompts must read the controlling terminal, not the curl pipe (rustup's trick). TRY to
  # open it in a subshell rather than testing that the file exists: on macOS /dev/tty is
  # always present and the open still fails when the process has no controlling terminal,
  # so the old `[ -e /dev/tty ]` test passed, the prompt then read EOF, and the installer
  # treated that as a cancel and installed nothing. The subshell keeps a failed open from
  # taking this script down with it - `exec` is a special built-in, and a redirection error
  # on one exits a non-interactive shell outright.
  if (exec </dev/tty) 2>/dev/null; then
    "$runner" install </dev/tty
  else
    say "no terminal available - deploying defaults (run 'enigma' later to customize)."
    "$runner" install --all --yes </dev/null
  fi
}

install_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    die "npm not found. Install Node.js first (https://nodejs.org), or drop ENIGMA_INSTALL=npm to install without it."
  fi

  say "clearing the npm cache (forces the latest version)..."
  npm cache clean --force >/dev/null 2>&1 || true

  say "installing enigma-cli globally..."
  # A global install needs write access to npm's prefix, which a system Node on macOS does
  # not grant without sudo. That is not fatal here: npx runs the same package without one.
  if npm install -g enigma-cli@latest; then
    global_install=yes
  else
    global_install=no
    echo "enigma: the global install failed - continuing with npx for this run." >&2
  fi

  # The package can be installed and still not be on this shell's PATH (a fresh npm prefix),
  # so resolve the command instead of assuming it is there.
  if [ "$global_install" = yes ] && command -v enigma >/dev/null 2>&1; then
    run_enigma() { enigma "$@"; }
  else
    if [ "$global_install" = yes ]; then
      echo "enigma: 'enigma' is not on this shell's PATH yet - using npx (open a new shell to get the command)." >&2
    fi
    run_enigma() { npx --yes enigma-cli@latest "$@"; }
  fi
  setup run_enigma "$@"
}

# Download $1 to $2. Only https:// (and file:// for a local mirror); TLS is always verified.
fetch() {
  case "$1" in
    https://* | file://*) ;;
    *) die "refusing non-HTTPS download URL: $1" ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' --proto-redir '=https' --retry 2 -o "$2" "$1" || die "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    case "$1" in file://*) die "file:// mirrors need curl" ;; esac
    wget -q --https-only -O "$2" "$1" || die "download failed: $1"
  else
    die "curl or wget is required"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else die "no sha256 tool found (sha256sum, shasum or openssl)"
  fi
}

# Fail unless file $1 hashes to the SHA256SUMS ($3) entry for asset $2.
verify() {
  expected="$(awk -v n="$2" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print tolower($1); exit } }' "$3")"
  [ -n "$expected" ] || die "$2 is not listed in SHA256SUMS; refusing to install it"
  actual="$(sha256_of "$1")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $2: expected $expected, got $actual"
}

# Quote $1 for a single-quoted sh string.
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

install_standalone() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) os=win32 ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  ext=""
  [ "$os" = win32 ] && ext=".exe"

  if [ "$os" = win32 ] && [ -n "${LOCALAPPDATA:-}" ]; then
    # Same layout as install.ps1, so either installer updates the other's install.
    data="$(cygpath -u "$LOCALAPPDATA" 2>/dev/null || printf '%s' "$LOCALAPPDATA")/enigma"
    prefix="${ENIGMA_PREFIX:-$data/cli}"
    bindir="${ENIGMA_BIN_DIR:-$data/bin}"
  else
    prefix="${ENIGMA_PREFIX:-$HOME/.enigma/cli}"
    bindir="${ENIGMA_BIN_DIR:-$HOME/.local/bin}"
  fi

  if [ -n "${ENIGMA_DOWNLOAD_BASE:-}" ]; then
    base="${ENIGMA_DOWNLOAD_BASE%/}"
  elif [ -n "${ENIGMA_INSTALL_VERSION:-}" ]; then
    base="$RELEASES/download/v${ENIGMA_INSTALL_VERSION#v}"
  else
    base="$RELEASES/latest/download"
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "reading release checksums from $base..."
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
  cli_asset="$(awk '{ f = $2; sub(/^\*/, "", f); if (f ~ /^enigma-cli-[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.tgz$/) { print f; exit } }' "$tmp/SHA256SUMS")"
  [ -n "$cli_asset" ] || die "SHA256SUMS at $base lists no enigma-cli tarball"
  version="${cli_asset#enigma-cli-}"
  version="${version%.tgz}"
  if [ -n "${ENIGMA_INSTALL_VERSION:-}" ] && [ "$version" != "${ENIGMA_INSTALL_VERSION#v}" ]; then
    die "release at $base is enigma-cli $version, not ${ENIGMA_INSTALL_VERSION#v}"
  fi
  # Download from that exact tag from here on: `latest` may move between two requests.
  [ -z "${ENIGMA_DOWNLOAD_BASE:-}" ] && base="$RELEASES/download/v$version"

  bin_asset="enigma-$os-$arch$ext"
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl && grep -q "enigma-$os-$arch-musl" "$tmp/SHA256SUMS"; then
    bin_asset="enigma-$os-$arch-musl"
  fi
  awk -v n="$bin_asset" '{ f = $2; sub(/^\*/, "", f); if (f == n) found = 1 } END { exit !found }' "$tmp/SHA256SUMS" ||
    die "release v$version has no binary for $os-$arch"

  say "downloading enigma-cli $version ($bin_asset)..."
  fetch "$base/$cli_asset" "$tmp/$cli_asset"
  verify "$tmp/$cli_asset" "$cli_asset" "$tmp/SHA256SUMS"
  fetch "$base/$bin_asset" "$tmp/$bin_asset"
  verify "$tmp/$bin_asset" "$bin_asset" "$tmp/SHA256SUMS"

  mkdir -p "$prefix" "$bindir"
  staging="$prefix/.staging-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  (cd "$staging" && tar -xzf "$tmp/$cli_asset")
  [ -f "$staging/package/package.json" ] || die "$cli_asset did not contain package/package.json"
  cp "$tmp/$bin_asset" "$staging/package/bin/enigma-bin$ext"
  chmod 755 "$staging/package/bin/enigma-bin$ext"
  printf 'standalone\n' >"$staging/package/install-method"
  if [ -d "$prefix/$version" ]; then
    # Reinstalling the same version: move the old tree aside (a running binary on Windows can
    # be renamed but not deleted) and drop it best-effort.
    mv "$prefix/$version" "$prefix/.old-$version-$$"
    rm -rf "$prefix/.old-$version-$$" 2>/dev/null || true
  fi
  mv "$staging/package" "$prefix/$version"
  rm -rf "$staging"
  printf '%s\n' "$version" >"$prefix/current.tmp-$$"
  mv -f "$prefix/current.tmp-$$" "$prefix/current"

  quoted_root="$(sh_quote "$prefix")"
  cat >"$bindir/enigma.tmp-$$" <<EOF
#!/bin/sh
# enigma command for a standalone install (written by scripts/install.sh). With Node on PATH it
# runs the Node launcher (fast hook paths); without it, the binary with the launcher's env.
root=$quoted_root
ver="\$(cat "\$root/current" 2>/dev/null)" || { echo "enigma: no install found at \$root - re-run the installer" >&2; exit 1; }
pkg="\$root/\$ver"
if [ -z "\${ENIGMA_NO_NODE:-}" ] && command -v node >/dev/null 2>&1; then
  exec node "\$pkg/bin/enigma.mjs" "\$@"
fi
ENIGMA_ASSETS_DIR="\$pkg/assets"
ENIGMA_GUARD_PATH="\$pkg/dist/guard.js"
ENIGMA_GUARDRAILS_PATH="\$pkg/dist/guardrails.js"
ENIGMA_TRIM_PATH="\$pkg/dist/trim.js"
ENIGMA_VERSION="\$ver"
export ENIGMA_ASSETS_DIR ENIGMA_GUARD_PATH ENIGMA_GUARDRAILS_PATH ENIGMA_TRIM_PATH ENIGMA_VERSION
exec "\$pkg/bin/enigma-bin$ext" "\$@"
EOF
  chmod 755 "$bindir/enigma.tmp-$$"
  mv -f "$bindir/enigma.tmp-$$" "$bindir/enigma"
  if [ "$os" = win32 ]; then
    # cmd.exe and PowerShell cannot run the sh script; give them the same command as install.ps1.
    win_root="$(cygpath -w "$prefix" 2>/dev/null || printf '%s' "$prefix")"
    write_cmd_shim "$win_root" >"$bindir/enigma.cmd"
  fi
  say "installed enigma-cli $version to $prefix/$version"

  # PATH holds POSIX paths under Git Bash, so compare and advise in that form.
  path_bindir="$bindir"
  [ "$os" = win32 ] && path_bindir="$(cygpath -u "$bindir" 2>/dev/null || printf '%s' "$bindir")"
  case ":$PATH:" in
    *":$path_bindir:"*) ;;
    *)
      say "$path_bindir is not on your PATH. Add it to your shell profile:"
      echo "  export PATH=\"$path_bindir:\$PATH\""
      ;;
  esac
  found="$(command -v enigma 2>/dev/null || true)"
  if [ -n "$found" ] && [ "$found" != "$path_bindir/enigma" ]; then
    say "note: 'enigma' on this PATH resolves to $found (another install), which runs first."
  fi
  setup "$bindir/enigma" "$@"
}

# The enigma.cmd shim for Windows, rooted at $1 (a Windows path). Kept identical to install.ps1's.
write_cmd_shim() {
  printf '%s\r\n' \
    '@echo off' \
    'setlocal' \
    "set \"ENIGMA_ROOT=$1\"" \
    'set /p ENIGMA_CUR=<"%ENIGMA_ROOT%\current"' \
    'set "ENIGMA_PKG=%ENIGMA_ROOT%\%ENIGMA_CUR%"' \
    'if defined ENIGMA_NO_NODE goto bin' \
    'where node >nul 2>nul || goto bin' \
    'node "%ENIGMA_PKG%\bin\enigma.mjs" %*' \
    'exit /b %ERRORLEVEL%' \
    ':bin' \
    'set "ENIGMA_ASSETS_DIR=%ENIGMA_PKG%\assets"' \
    'set "ENIGMA_GUARD_PATH=%ENIGMA_PKG%\dist\guard.js"' \
    'set "ENIGMA_GUARDRAILS_PATH=%ENIGMA_PKG%\dist\guardrails.js"' \
    'set "ENIGMA_TRIM_PATH=%ENIGMA_PKG%\dist\trim.js"' \
    'set "ENIGMA_VERSION=%ENIGMA_CUR%"' \
    '"%ENIGMA_PKG%\bin\enigma-bin.exe" %*' \
    'exit /b %ERRORLEVEL%'
}

case "${ENIGMA_INSTALL:-standalone}" in
  standalone) install_standalone "$@" ;;
  npm) install_npm "$@" ;;
  *) die "ENIGMA_INSTALL must be 'standalone' or 'npm' (got '$ENIGMA_INSTALL')" ;;
esac

say "done. Run 'enigma' anytime for the interactive hub."
