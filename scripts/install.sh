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
npm install -g enigma-cli@latest

echo "enigma: setting up your agents (answer the prompts)..."
# Read prompts from the controlling terminal, not the curl pipe (rustup's trick); fall
# back to a no-prompt default deploy when there is no terminal (CI / headless).
if [ -e /dev/tty ]; then
  enigma install </dev/tty
else
  echo "enigma: no terminal detected - deploying defaults (run 'enigma' later to customize)."
  enigma install --all --yes
fi

echo "enigma: done. Run 'enigma' anytime for the interactive hub."
