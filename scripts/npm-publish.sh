#!/usr/bin/env bash
# Publish one workspace to npm, treating "already there" as success.
#
# Usage: scripts/npm-publish.sh <workspace> <package-dir>
#
# npm can accept a publish and still answer the client with
# `E409 Cannot publish over previously staged version`: the tarball and its provenance land,
# then a retried PUT of the same version conflicts with the one that just went through. The
# step failed while the version was live (it happened to @enigmax/dashboard 0.1.112 and
# 0.1.113), and the failure skipped every publish step after it. So a failed publish is checked
# against the registry: if this exact version is now published, the job carries on. Any other
# failure, or a version that never appears, still fails the step.
set -uo pipefail

workspace="$1"
dir="$2"
name="$(node -p "require('./$dir/package.json').name")"
version="$(node -p "require('./$dir/package.json').version")"

log="$(mktemp)"
if npm publish --workspace "$workspace" --provenance --access public 2>&1 | tee "$log"; then
  exit 0
fi
if ! grep -q "E409" "$log"; then
  exit 1
fi

# The registry can lag the publish by a few seconds; give it up to a minute.
for _ in 1 2 3 4 5 6; do
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "$name@$version is published (npm answered E409 to a repeated PUT); treating as success."
    exit 0
  fi
  sleep "${NPM_PUBLISH_RETRY_SECONDS:-10}"
done
echo "$name@$version did not appear on the registry after E409."
exit 1
