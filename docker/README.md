# enigma test container

A throwaway shell for contributors to try enigma **built from the current repo source**
(the version about to be published, never the npm release), with **Claude Code** preinstalled.
Useful for testing `enigma install`, the TUI, recall, the dashboard, and `enigma <tool>`
launches without touching your real machine.

This is a dev tool. It is not published, runs as root for convenience, and should not be used
in production.

## Prerequisites

- Docker with Compose v2+ (`docker compose`).
- Run the commands below from the repo root.

## Build

```bash
docker compose -f docker/docker-compose.yml build
```

The image compiles the Linux `enigma` binary from `packages/enigma-cli` and bundles its assets
(skills, memory, commands, guard, dashboard UI). Rebuild after changing the source to pick up
your changes - the image is a snapshot, not a live mount.

## Run

Persistent shell (default) - the Claude Code login, your sessions, and enigma's data survive
across runs in a named volume:

```bash
docker compose -f docker/docker-compose.yml run --rm enigma
```

Ephemeral shell - no volume, everything is discarded on exit:

```bash
docker compose -f docker/docker-compose.yml --profile ephemeral run --rm enigma-ephemeral
```

Inside the shell:

```bash
enigma --help
enigma install --all --yes      # deploy skills/memory/commands into this container
enigma recall sync              # build session memory from transcripts
claude                          # log in once; the session persists (with the volume)
```

## Customize

- **Without Claude Code:** build with `--build-arg INSTALL_CLAUDE=false`
  (`docker compose -f docker/docker-compose.yml build --build-arg INSTALL_CLAUDE=false`).
- **Pin a Claude Code version:** set `CLAUDE_PKG=@anthropic-ai/claude-code@<version>` the same way.
- **With / without the volume:** the `enigma` service persists (`enigma-home` volume);
  `enigma-ephemeral` does not. Reset the persistent state with
  `docker volume rm enigma_enigma-home`.
- **Test against the live repo:** uncomment the `../:/workspace` bind mount under the `enigma`
  service to run enigma against the actual checkout inside the container.
- **Plain `docker run` (no compose):** `docker run --rm -it enigma-test:local` (ephemeral), or
  add `-v enigma-home:/root` to persist.

## What's inside

- `enigma` on `PATH`, compiled from this repo (`enigma version` reports the repo's version).
- `claude` (Claude Code) by default.
- `git`, `ripgrep`, an editor, and a `bash` shell.
- Asset env wired exactly like the real launcher (`ENIGMA_ASSETS_DIR`, `ENIGMA_GUARD_PATH`,
  `ENIGMA_DASHBOARD_ASSETS`), so skills/memory/commands, the guard, and the dashboard all work
  offline.
