# syntax=docker/dockerfile:1
#
# Dev/test image for the enigma project. NOT for production and NOT published.
# It gives contributors a throwaway shell with Claude Code installed and `enigma`
# already built FROM THE CURRENT REPO SOURCE (the to-be-published version, never npm).
#
# Build context is the repo root (see docker-compose.yml / the README). Two stages:
#   1) builder  - compiles the Linux enigma binary from source with Bun.
#   2) runtime  - a slim Node shell with Claude Code + the freshly built enigma.
#
# Customize via build args:
#   INSTALL_CLAUDE=false   skip installing Claude Code
#   CLAUDE_PKG=...@x.y.z    pin a specific Claude Code version

# ---- Stage 1: build the enigma binary from the current source ----------------
FROM oven/bun:1.3 AS builder
WORKDIR /src
# Copy the whole monorepo (the .dockerignore drops node_modules, references/, dist).
COPY . .
# Fresh install (devDeps included: `bun build --compile` bundles them) and build.
# No --frozen-lockfile: the repo's lockfile is npm's, so let bun resolve its own.
RUN bun install
WORKDIR /src/packages/enigma-cli
RUN bun run build
# Host target inside this linux image is bun-linux-<arch>, so the OpenTUI native core
# embeds reliably (cross-compiling other targets would not). Output: dist-bin/enigma-linux-<arch>.
RUN bun scripts/build-binaries.ts \
    && cp dist-bin/enigma-linux-* /tmp/enigma-bin

# ---- Stage 2: runtime test shell --------------------------------------------
FROM node:22-bookworm-slim AS runtime
ARG INSTALL_CLAUDE=true
ARG CLAUDE_PKG=@anthropic-ai/claude-code

# A useful interactive shell: git (enigma security/guard drive git), ripgrep, an editor.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep less nano curl \
    && rm -rf /var/lib/apt/lists/*

# Claude Code (the `claude` CLI), installed by default. Toggle with INSTALL_CLAUDE=false.
RUN if [ "$INSTALL_CLAUDE" = "true" ]; then npm install -g "$CLAUDE_PKG"; fi

# enigma: the compiled binary + the on-disk assets it reads (skills/memory/commands,
# the guard, and the dashboard UI) - the same files the Node launcher points the binary at.
COPY --from=builder /tmp/enigma-bin /opt/enigma/enigma-bin
COPY --from=builder /src/packages/enigma-cli/assets /opt/enigma/assets
COPY --from=builder /src/packages/enigma-cli/dist/guard.js /opt/enigma/guard.js
COPY --from=builder /src/packages/enigma-cli/package.json /opt/enigma/package.json
COPY --from=builder /src/packages/dashboard/assets /opt/enigma/dashboard-assets
RUN chmod +x /opt/enigma/enigma-bin \
    && node -p "require('/opt/enigma/package.json').version" > /opt/enigma/VERSION

# The asset overrides the compiled binary needs (its own __dirname is Bun's virtual fs).
# Set as ENV so even a direct /opt/enigma/enigma-bin call resolves assets; the `enigma`
# wrapper adds the version (which ENV cannot read from a file).
ENV ENIGMA_ASSETS_DIR=/opt/enigma/assets \
    ENIGMA_GUARD_PATH=/opt/enigma/guard.js \
    ENIGMA_DASHBOARD_ASSETS=/opt/enigma/dashboard-assets

COPY docker/enigma-wrapper.sh /usr/local/bin/enigma
COPY docker/entrypoint.sh /usr/local/bin/enigma-entrypoint
RUN chmod +x /usr/local/bin/enigma /usr/local/bin/enigma-entrypoint

# Session/auth persistence lives in $HOME (Claude Code: ~/.claude, ~/.claude.json;
# enigma: ~/.enigma). Mount a volume at /root to keep it across runs (see compose).
WORKDIR /workspace
ENTRYPOINT ["enigma-entrypoint"]
CMD ["bash"]