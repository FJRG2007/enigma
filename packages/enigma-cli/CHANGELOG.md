# Changelog

Notable changes to `enigma-cli`. Earlier releases are described by their commits and GitHub Releases.

## 1.73.0

### Added

- `enigma skills list --json [agent]`: the skill catalogue as one versioned JSON document (`schemaVersion`, `enigmaVersion`, `skills[]` with name, description, version, provider, disableable, disabled). Works with no install and no home directory.
- `enigma skills enable|disable <name...> [agent]`: several skills in one call, validated together; an unknown name changes nothing.
- `enigma install --skip <part,...>`: leave parts out of one install run (stop-hook, gate, recall, code-graph, compress, guardrails, output-style, commit-hooks and every other config-keyed part). An unknown part is an error that lists the valid ones.
- `enigma config --json [--defaults]`: every setting with key, description, kind, choices, scope, default and current value, from the settings registry. Works with no home directory.
- `enigma config set <key>=<value> ...` and `enigma config apply --file <json>`: many settings in one process, all or nothing.
- `enigma memory render --target generic [--compact] [--skills | -s a,b]`: the operating contract as plain text for a host that is not a CLI agent, deterministic per version and settings.
- `enigma serve --http --data-dir <dir> --token-file <file>`: a multi-tenant JSON API over recall, the code graph, compression and stats, with bearer auth, per-tenant data directories, request size caps, pagination and stable error codes. See `docs/notes/host-integration.md`.
- Every new command fails with `{"error": {"code", "message"}}` under `--json` and a non-zero exit, and never prompts.
- Standalone install with no Node or npm: `install.sh` / `install.ps1` install the Bun binary from GitHub Releases, verified against `SHA256SUMS`, and `enigma update` keeps that install current from GitHub Releases. The dashboard and isolated agents are fetched from the release too; the linter still needs npm. `ENIGMA_INSTALL=npm` keeps the npm path.

### Changed

- `enigma update` runs the post-update sync with the new version's binary directly instead of resolving `enigma` on PATH.
- Recall keeps one database handle per data directory (capped), so several data roots can be open in one process.
- Request bodies over the limit on the local API server now get a 413 answer instead of a reset connection.
