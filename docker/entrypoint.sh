#!/usr/bin/env bash
# Print a short banner on an interactive start, then hand off to the command (default: bash).
set -e
if [ -t 1 ]; then
    echo "enigma test shell (built from the repo, not npm)"
    echo "  enigma:  $(enigma version 2>/dev/null || echo '?')"
    if command -v claude >/dev/null 2>&1; then
        echo "  claude:  $(claude --version 2>/dev/null || echo 'installed')"
    else
        echo "  claude:  not installed (rebuild with INSTALL_CLAUDE=true)"
    fi
    echo "  home:    ${HOME} (persisted when a volume is mounted at it)"
    echo "  try:     enigma --help  |  enigma install --all --yes  |  enigma recall sync  |  claude"
    echo
fi
exec "$@"