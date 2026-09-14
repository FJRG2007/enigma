# Shell integration (`enigma shim`)

Launches a managed agent under its OWN command name, so the terminal keeps recognizing it.

## The defect this fixes

`enigma claude` puts enigma where the terminal expects the agent. Terminals decide their
agent features from the command the user TYPED, not from the process or the process tree,
so the wrapper makes the agent invisible to them.

Warp is the measured case. Its shell integration (`pwsh.ps1`, `Warp-Preexec`) sends the
literal typed line to the terminal over OSC 9278 as `hook = 'Preexec'`,
`value.command = "$line"`. `enigma claude` never matches `claude`, so the third-party
CLI-agent toolbar never opens - and with it goes image paste, which is why Ctrl+V falls
back to Warp's plain text paste and only a file path arrives. Same class, different
vendors: anything keying off the typed command or the foreground process name.

Nothing enigma does at spawn time can change what the user typed. `spawnInherit`
(`accounts.ts`) and the `CLAUDE_CONFIG_DIR` injection are NOT at fault: Claude Code's own
Windows clipboard reader (`powershell -NoProfile -NonInteractive -Sta -Command "Add-Type
-AssemblyName System.Windows.Forms; ...Clipboard]::ContainsImage()"`) returns exit 0
identically whether run directly or inside a child spawned the way enigma spawns it.

## Why shell functions and never a PATH shim

A shell function is not inherited by child processes. Everything that spawns the agent
programmatically - the gate's own `ClaudeAgent`, which runs `claude`, plus any script -
keeps resolving the real binary. A shim named `claude` placed first on PATH would
intercept those too and silently change what they launch, which is a regression the user
would never connect to this feature. The function is the narrower tool and the correct one.

Each function falls back to the real binary when `enigma` is not resolvable, so a broken
or uninstalled enigma can never make the agent itself unreachable from the shell.

## Shape

- `enigma shim` / `shim status` - the profile path, what its block covers, which agents are installed.
- `enigma shim on` - writes the block for every INSTALLED tool (`locateToolBinary().effective`).
- `enigma shim off` - removes the block and gives the profile back byte-for-byte.

The block lives between `# >>> enigma shim >>>` and `# <<< enigma shim <<<` (a `#` comment
in every dialect it targets). Rewriting replaces the block whole, so re-running `on` after
installing another agent simply picks it up instead of stacking a second block.

Profile per platform: the PowerShell CurrentUserCurrentHost profile on Windows, otherwise
`unixProfile()` - the same `$SHELL`-to-profile mapping `fix-path` already applies, exported
from `path-env.ts` so the two features can never disagree about which file is the user's.
Three dialects are generated (`powershell`, `fish`, `posix`); writing posix syntax into
`config.fish` would produce a profile that fails to load, breaking every new shell.

`homedir()` resolves the profile, which is what lets the tests run against a throwaway home
instead of the developer's own profile. `applyShim(on, tools?)` takes the tool list as an
optional argument for the same reason: the assertions must not depend on which agents happen
to be installed on the machine running the suite.

## Traps

- Warp records `shell = "pwsh"` for every session even when PowerShell 7 is not installed.
  That label is generic; it can be Windows PowerShell 5.1, which loads the
  `Documents\WindowsPowerShell` profile, NOT `Documents\PowerShell`. Do not infer the
  profile path from that column.
- A running terminal tab does not reload the profile. Before concluding the fix failed,
  check whether it was ever exercised: Warp's `commands` table
  (`%LOCALAPPDATA%\Warp\Warp\data\warp.sqlite`, columns `command, shell, start_ts`) is the
  record of what was actually typed and when.
- Warp also has its own escape hatch, `agents.third_party.cli_agent_toolbar_enabled_commands`
  (`ToolbarCommandMap` in its `resources/settings_schema.json`: command pattern -> agent id,
  ids `oz|claude|opencode|gemini|codex`). That one is Warp-only and covers the case where the
  user deliberately types `enigma claude`; the shim is the terminal-agnostic half.
