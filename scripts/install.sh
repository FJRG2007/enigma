#!/bin/sh
# enigma installer - always fetches the latest enigma-cli, then deploys it.
#
#   curl -fsSL https://raw.githubusercontent.com/FJRG2007/enigma/main/scripts/install.sh | sh
#
# It clears the npm cache first (so you always get the newest published version),
# installs the `enigma` command globally, and runs `enigma install` for you.
set -e

if ! command -v npm >/dev/null 2>&1; then
  echo "enigma: npm not found. Install Node.js first: https://nodejs.org" >&2
  exit 1
fi

echo "enigma: clearing the npm cache (forces the latest version)..."
npm cache clean --force >/dev/null 2>&1 || true

echo "enigma: installing enigma-cli globally..."
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

echo "enigma: setting up your agents (answer the prompts)..."
# Prompts must read the controlling terminal, not the curl pipe (rustup's trick). TRY to
# open it in a subshell rather than testing that the file exists: on macOS /dev/tty is
# always present and the open still fails when the process has no controlling terminal,
# so the old `[ -e /dev/tty ]` test passed, the prompt then read EOF, and the installer
# treated that as a cancel and installed nothing. The subshell keeps a failed open from
# taking this script down with it - `exec` is a special built-in, and a redirection error
# on one exits a non-interactive shell outright.
if (exec </dev/tty) 2>/dev/null; then
  run_enigma install </dev/tty
else
  echo "enigma: no terminal available - deploying defaults (run 'enigma' later to customize)."
  run_enigma install --all --yes
fi

echo "enigma: done. Run 'enigma' anytime for the interactive hub."
