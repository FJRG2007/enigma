# Hook latency (`enigma doctor hooks`)

`src/doctor-hooks.ts`. One command that answers "which hook is making this slow", because
Claude Code's own message cannot: it says `UserPromptSubmit hook timed out after 30s` and
names the EVENT, while an event routinely carries half a dozen hooks from four different
places.

## What contributes a hook to an event

All of these are live at once, and a report that walks only one of them will miss the hook
the user is hunting:

- `~/.claude/settings.json` (user)
- `<cwd>/.claude/settings.json` (project)
- `<cwd>/.claude/settings.local.json` (project-local)
- every plugin enabled by any of the above, via its own `hooks/hooks.json`

The plugin path is the one that catches people out. `enabledPlugins` keys a plugin
`"<plugin>@<marketplace>"` but the files live under
`plugins/cache/<marketplace>/<plugin>/<version>` - the key is split, not joined. The exact
install path is in `plugins/installed_plugins.json`; scanning the version directories is the
fallback. A plugin hook's command contains `${CLAUDE_PLUGIN_ROOT}`, expanded at run time, so
collection reports the literal and only the timing run substitutes it.

## Why it executes the hooks

There is no other way to time one. That constrains the design:

- The default scope is `UserPromptSubmit` and `PostToolUse` - the two that fire every turn,
  which is where latency is actually felt. `--all` is opt-in because `Stop` and `PreCompact`
  hooks do real work.
- The payload is deliberately inert: `tool_name: "Read"` with an empty `tool_input`, so a
  hook that formats or lints the edited file finds no file, and `stop_hook_active: true`, so
  a stop hook does not try to block a turn that is not running.
- A `.sh` command (or one that starts with `bash `) is run through `bash -c`. cmd.exe runs
  neither, and a hook that fails to START would time as instant and read as healthy - the
  one failure mode that would make the report actively misleading.

Three runs, graded on the median: this measurement is noisy enough on Windows that a single
run says nothing. A hook is `over` only against its OWN declared `timeout`; with no timeout
declared the report says so rather than inventing Claude Code's default, and `slow` (>= 1s)
carries the signal instead. Exit codes are reported and never graded - a hook exits non-zero
to block an event, which is it working.

## Measured here, 2026-09-07

The reason this exists. On DRAGON every process launch costs 2-13 s (Defender real-time, no
exclusions), so a hook's cost is dominated by how many processes it starts, not by its logic:

| hook | cost | fires |
| --- | --- | --- |
| `warp@claude-code-warp` `PostToolUse` | 12.8-21.5 s | every tool call |
| `warp@claude-code-warp` `UserPromptSubmit` | 9.2-17.4 s | every prompt |
| `enigma __codegraph-hook prompt` | 1.6-6.4 s | every prompt |
| `enigma __post-edit-hook` | 0.3-5.9 s | every edit |

Both Warp entries only send a status notification, and each spends its time on `bash` plus
two or three `jq` spawns. Neither declares a `timeout`, so they fall back to Claude Code's
default and a spike over it surfaces as the timeout message. They were removed from that
plugin's cached `hooks.json` on this machine; a plugin update restores them.

The lesson generalises past Warp: a per-turn hook must answer inside a process that is
already running, or not be wired at all. That is the same conclusion `post-edit-hook.md`
reached for enigma's own three, and why they share one entry.
