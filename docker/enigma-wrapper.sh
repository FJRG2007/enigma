#!/usr/bin/env bash
# `enigma` inside the test container: mirror what the Node launcher does for the compiled
# binary - point it at the on-disk assets/guard/dashboard and report the repo version - then
# exec it. The asset dirs come from ENV (set in the Dockerfile); the version from the baked
# file, since ENV cannot read it at build.
export ENIGMA_ASSETS_DIR="${ENIGMA_ASSETS_DIR:-/opt/enigma/assets}"
export ENIGMA_GUARD_PATH="${ENIGMA_GUARD_PATH:-/opt/enigma/guard.js}"
export ENIGMA_DASHBOARD_ASSETS="${ENIGMA_DASHBOARD_ASSETS:-/opt/enigma/dashboard-assets}"
export ENIGMA_VERSION="${ENIGMA_VERSION:-$(cat /opt/enigma/VERSION 2>/dev/null || echo dev)}"
exec /opt/enigma/enigma-bin "$@"