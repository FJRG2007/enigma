/**
 * Shell completion scripts for `enigma`.
 *
 * The word lists are DERIVED, never hand-written twice: the commands come from the
 * dispatcher's own set and the config keys from the settings registry, so a command
 * added to the CLI completes without anyone remembering to update a script. Only the
 * subcommand map below is written by hand, and a test holds it against each command's
 * help text so it cannot drift either.
 *
 * The generated script is printed to stdout and the user installs it wherever their
 * shell reads completions from - enigma never writes to a shell profile on its own.
 */

import { ALL_SETTINGS } from "./settings-registry";

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export const COMPLETION_SHELLS: CompletionShell[] = ["bash", "zsh", "fish", "powershell"];

/**
 * Subcommands per command, for the commands that take one. Checked against the help
 * text by `tests/completion.test.ts` - a subcommand listed here that the help does not
 * document, or the reverse, fails that test rather than silently completing a word
 * the CLI rejects.
 */
export const SUBCOMMANDS: Record<string, string[]> = {
    account: ["list", "add", "use", "login", "run", "rename", "remove", "provider", "sessions", "transfer"],
    profile: ["list", "add", "use", "set", "unset", "rename", "remove"],
    skills: ["list", "enable", "disable", "discard", "restore"],
    pack: ["list", "install", "remove", "update", "setup", "use", "run"],
    recall: ["status", "sync", "search", "list", "show", "timeline", "sessions", "context", "prune", "clear"],
    codegraph: ["status", "index", "projects", "arch", "search", "ask", "callers", "callees", "skeleton", "map", "grep", "graph", "check"],
    guardrails: ["list", "check", "stats", "enable", "disable", "remove"],
    resources: ["status", "wsl", "docker", "free-port", "kill"],
    dashboard: ["stop", "token"],
    verify: ["parity"],
    issue: ["bug", "feature"],
};

/** Flags accepted anywhere on the command line. */
const GLOBAL_FLAGS = ["--help", "--version", "--json", "--yes", "--dry-run", "--force", "--all"];

/** Shell-quote a word list into a single space-separated string. */
function words(list: readonly string[]): string {
    return [...new Set(list)].filter(Boolean).sort().join(" ");
}

function bashScript(commands: string[], keys: string[]): string {
    const cases = Object.entries(SUBCOMMANDS)
        .map(([cmd, subs]) => `        ${cmd}) COMPREPLY=($(compgen -W "${words(subs)}" -- "$cur")); return;;`)
        .join("\n");
    return `# enigma completion for bash. Install with:
#   enigma completion bash > /etc/bash_completion.d/enigma
# or source it from ~/.bashrc:
#   eval "$(enigma completion bash)"
_enigma_completion() {
    local cur prev
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=($(compgen -W "${words(commands)}" -- "$cur"))
        return
    fi

    case "$prev" in
        config) COMPREPLY=($(compgen -W "${words(keys)}" -- "$cur")); return;;
${cases}
    esac

    if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "${words(GLOBAL_FLAGS)}" -- "$cur"))
        return
    fi
    COMPREPLY=($(compgen -f -- "$cur"))
}
complete -F _enigma_completion enigma
`;
}

function zshScript(commands: string[], keys: string[]): string {
    const cases = Object.entries(SUBCOMMANDS)
        .map(([cmd, subs]) => `        ${cmd}) compadd ${words(subs)};;`)
        .join("\n");
    return `#compdef enigma
# enigma completion for zsh. Install with:
#   enigma completion zsh > "\${fpath[1]}/_enigma"
# or source it from ~/.zshrc:
#   eval "$(enigma completion zsh)"
_enigma() {
    if (( CURRENT == 2 )); then
        compadd ${words(commands)}
        return
    fi

    case "\${words[2]}" in
        config) compadd ${words(keys)};;
${cases}
        *) _files;;
    esac
}
compdef _enigma enigma
`;
}

function fishScript(commands: string[], keys: string[]): string {
    const lines = [
        "# enigma completion for fish. Install with:",
        "#   enigma completion fish > ~/.config/fish/completions/enigma.fish",
        `complete -c enigma -f -n "__fish_use_subcommand" -a "${words(commands)}"`,
        `complete -c enigma -f -n "__fish_seen_subcommand_from config" -a "${words(keys)}"`,
    ];
    for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
        lines.push(`complete -c enigma -f -n "__fish_seen_subcommand_from ${cmd}" -a "${words(subs)}"`);
    }
    for (const flag of GLOBAL_FLAGS) lines.push(`complete -c enigma -l ${flag.replace(/^--/, "")}`);
    return `${lines.join("\n")}\n`;
}

function powershellScript(commands: string[], keys: string[]): string {
    const cases = Object.entries(SUBCOMMANDS)
        .map(([cmd, subs]) => `            "${cmd}" { "${words(subs)}".Split(" ") }`)
        .join("\n");
    return `# enigma completion for PowerShell. Install with:
#   enigma completion powershell >> $PROFILE
Register-ArgumentCompleter -Native -CommandName enigma -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
    $candidates =
        if ($tokens.Count -le 1 -or ($tokens.Count -eq 2 -and $wordToComplete)) {
            "${words(commands)}".Split(" ")
        } else {
            switch ($tokens[1]) {
            "config" { "${words(keys)}".Split(" ") }
${cases}
                default { "${words(GLOBAL_FLAGS)}".Split(" ") }
            }
        }
    $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)
    }
}
`;
}

/** Best guess at the caller's shell, used when `enigma completion` is given no argument. */
export function detectShell(): CompletionShell {
    if (process.env.PSModulePath && process.platform === "win32" && !process.env.SHELL) return "powershell";
    const shell = process.env.SHELL ?? "";
    if (shell.includes("zsh")) return "zsh";
    if (shell.includes("fish")) return "fish";
    if (shell.includes("pwsh") || shell.includes("powershell")) return "powershell";
    return "bash";
}

/** Render the completion script for `shell` from the live command and setting lists. */
export function completionScript(shell: CompletionShell, commands: string[]): string {
    const keys = ALL_SETTINGS.map((s) => s.key);
    if (shell === "zsh") return zshScript(commands, keys);
    if (shell === "fish") return fishScript(commands, keys);
    if (shell === "powershell") return powershellScript(commands, keys);
    return bashScript(commands, keys);
}
