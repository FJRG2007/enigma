/**
 * Refuses a shell command that would put a browser window on the user's screen.
 *
 * The Chrome DevTools MCP server already runs headless and closes itself (browser-mcp.ts), but
 * that is only one of the ways an agent reaches a browser. The others are plain shell commands:
 * starting `chrome.exe` itself, `Start-Process http://localhost:3000`, `playwright test --headed`,
 * `npx lighthouse <url>` (which launches a visible Chrome unless told otherwise), a dev server's
 * `--open`, `gh pr view --web`. Each one opens a real window in front of the user, and the agent
 * walks away from it, so nothing ever closes it. A PreToolUse hook sees the command before it
 * runs, which is the one point where that can be stopped rather than cleaned up after.
 *
 * Only the launch is judged, never a mention: `taskkill /IM chrome.exe`, `Get-Process msedge` and
 * `grep chrome` name a browser without starting one. A browser started WITH `--headless` passes.
 *
 * The guard follows the `browserHeadless` setting: a user who turned headless off to watch the
 * agent drive the browser gets no refusal. Anything unreadable lets the call through.
 *
 * COST: the handlers carry `if` filters, so Claude Code spawns this process only for commands
 * naming a browser, an opener or a browser test tool - never for the rest of a session's calls.
 */

import { readConfig } from "./config";
import { applyClaudeHook } from "./claude-hooks";
import { parseGuardPayload } from "./attribution-guard";
import type { HookGroup, HookWrite } from "./claude-hooks";

/** Marker identifying enigma's handlers in settings.json (see applyClaudeHook), and the hidden command itself. */
export const BROWSER_GUARD_MARKER = "__browser-guard";
const MARKER = BROWSER_GUARD_MARKER;

/** Executable names of desktop browsers, without a `.exe` suffix. */
export const BROWSER_EXE = /^(?:chrome|google-chrome(?:-stable|-beta|-unstable)?|google chrome|chromium(?:-browser)?|msedge|microsoft-edge(?:-stable|-beta|-dev)?|microsoft edge|brave|brave-browser|brave browser|firefox)$/i;

/** Commands whose job is to hand a URL or file to the default browser. */
const OPENERS = new Set(["start", "start-process", "saps", "explorer", "xdg-open", "open", "wslview", "sensible-browser", "x-www-browser", "www-browser", "open-cli"]);

/** A target an opener sends to the default browser: a URL, or an HTML page. */
const BROWSER_TARGET = /^(?:https?:|file:|about:|chrome:|edge:|www\.)|\.html?(?:[?#].*)?$/i;

/** Start-Process switches that take no value; every other `-Name` consumes the next word. */
const START_PROCESS_SWITCHES = /^-(?:wait|nonewwindow|passthru|usenewenvironment|loaduserprofile|whatif|confirm)$/i;

/** Shells that run a command passed to them as text (`-c` / `-Command`). */
const NESTING_SHELLS = new Set(["bash", "sh", "zsh", "powershell", "pwsh"]);

/** Playwright subcommands that show a window: the HTML report, the trace viewer, the recorder, a raw browser. */
const PLAYWRIGHT_WINDOWS = new Set(["show-report", "show-trace", "codegen", "open", "cr", "ff", "wk"]);

/**
 * Commands the hook is spawned for, in Claude Code's permission-rule syntax. Few and broad on
 * purpose: Claude Code runs EVERY handler of a command it cannot evaluate against the filters
 * (measured: anything with `$(...)` or `$VAR`), so each pattern here is one more process for
 * those. `*hrom*` is chrome, Chrome and chromium; `*http*` is any URL handed to an opener,
 * lighthouse or a browser; `*open*` is open, xdg-open, `--open` and `cypress open`; `*rave*` is
 * brave and Brave.
 */
export const COMMAND_PATTERNS = ["*hrom*", "*msedge*", "*irefox*", "*rave*", "*http*", "*open*", "*.htm*", "*playwright*", "*--web*", "*browse*", "*--ui*", "*storybook*", "*ng serve*"];

/**
 * The command without heredoc and here-string bodies: they are data written to a file or a
 * pipe (a script, a doc saying "open http://localhost:3000"), never a command that runs.
 */
function withoutHeredocs(command: string): string {
    return command
        .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1[ \t]*(?=\n|$)/g, "")
        .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''");
}

/** The command split at unquoted `;`, `|`, `||`, `&&` and line breaks, heredoc bodies left out. */
export function commandSegments(raw: string): string[] {
    const command = withoutHeredocs(raw);
    const out: string[] = [];
    let current = "";
    for (let i = 0; i < command.length; i++) {
        const c = command[i]!;
        if (c === "'" || c === "\"") {
            const close = command.indexOf(c, i + 1);
            const end = close === -1 ? command.length : close + 1;
            current += command.slice(i, end);
            i = end - 1;
        } else if (c === ";" || c === "|" || c === "\n" || c === "\r" || (c === "&" && command[i + 1] === "&")) {
            if (current.trim()) out.push(current.trim());
            current = "";
            if (command[i + 1] === c) i++;
        } else {
            current += c;
        }
    }
    if (current.trim()) out.push(current.trim());
    return out;
}

/** The words of one segment, quotes removed. */
export function words(segment: string): string[] {
    return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));
}

/** A path or command word reduced to its program name: `C:\...\chrome.exe` -> `chrome`. */
export function programName(word: string): string {
    return (word.split(/[\\/]/).pop() ?? word).replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/** Flags a browser answers on the console and exits, except on Windows where Chrome ignores them and opens a window. */
const BROWSER_PROBE = /^--?(?:version|help|h)$/i;

/** Whether a segment starts its browser headless (`--headless`, `--headless=new`, Firefox's `-headless`). */
export function hasHeadless(segment: string): boolean {
    return /(?:^|\s|["'=,])--?headless\b/i.test(segment);
}

/**
 * The words that actually run: leading `VAR=value` assignments, PowerShell's `&` call operator
 * and wrappers that only start the next word (`cmd /c`, `env`, `exec`, `nohup`, package runners)
 * are dropped.
 */
function commandWords(segment: string): string[] {
    const all = words(segment);
    let i = 0;
    while (i < all.length) {
        const w = all[i]!;
        const name = programName(w);
        if (w === "&" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || ["env", "exec", "nohup", "sudo", "time"].includes(name)) i++;
        else if (name === "timeout") { i++; while (i < all.length && (all[i]!.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(all[i]!))) i++; }
        else if (name === "cmd" || name === "cmd.exe") { i++; while (i < all.length && /^\/[a-z]$/i.test(all[i]!)) i++; }
        else if (["npx", "bunx", "pnpx"].includes(name)) { i++; while (i < all.length && all[i]!.startsWith("-")) i++; }
        else if (["pnpm", "yarn", "bun", "npm"].includes(name) && ["exec", "dlx", "x"].includes(all[i + 1] ?? "")) i += 2;
        else break;
    }
    return all.slice(i);
}

/** What `Start-Process` starts: `-FilePath x`, else its first positional argument. */
function startProcessTarget(args: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        const w = args[i]!;
        if (/^-(?:filepath|file|path|fi|f)$/i.test(w)) return args[i + 1] ?? null;
        if (w.startsWith("-")) { if (!START_PROCESS_SWITCHES.test(w)) i++; continue; }
        return w;
    }
    return null;
}

/** What `start` (cmd) or another opener starts: the first argument that is not a flag or a title. */
function openerTarget(opener: string, args: string[]): string | null {
    if (opener === "start-process" || opener === "saps") return startProcessTarget(args);
    for (const w of args) {
        if (w === "" || (opener === "start" && /^\/\w+$/.test(w)) || w.startsWith("-")) continue;
        return w;
    }
    return null;
}

/** Why one segment would show a browser window, or "" when it would not. */
function segmentReason(segment: string, platform: NodeJS.Platform): string {
    const all = words(segment);
    if (all.some((w) => /^PWDEBUG=(?!0\b)/i.test(w))) return "PWDEBUG opens the Playwright inspector and a headed browser";
    const cmd = commandWords(segment);
    if (!cmd.length) return "";
    const program = programName(cmd[0]!);
    const args = cmd.slice(1);
    if (BROWSER_EXE.test(program)) {
        if (platform !== "win32" && args.length && args.every((a) => BROWSER_PROBE.test(a))) return "";
        return hasHeadless(segment) ? "" : `${program} started without --headless`;
    }
    // A command handed to another shell as text is judged as the command it is:
    // `powershell -Command "Start-Process http://..."`, `bash -c "..."`, and `cmd /c "start ..."`,
    // where the wrappers are already gone and one quoted word holding spaces is left.
    if (NESTING_SHELLS.has(program)) {
        const flag = program === "powershell" || program === "pwsh" ? /^-(?:c|command)$/i : /^-[a-z]*c$/;
        const at = args.findIndex((a) => flag.test(a));
        return at === -1 ? "" : visibleBrowserReason(args.slice(at + 1).join(" "), platform);
    }
    if (cmd.length === 1 && /\s/.test(cmd[0]!)) return visibleBrowserReason(cmd[0]!, platform);
    if (program === "rundll32" && args.some((a) => /url\.dll|FileProtocolHandler|shell32\.dll,ShellExec_RunDLL/i.test(a))) return "rundll32 hands the URL to the default browser";
    if (program === "gio" && args[0] === "open" && args[1] && BROWSER_TARGET.test(args[1])) return "gio open hands the URL to the default browser";
    if (OPENERS.has(program)) {
        const target = openerTarget(program, args);
        if (!target) return "";
        if (BROWSER_EXE.test(programName(target))) return hasHeadless(segment) ? "" : `${program} starts ${programName(target)} without --headless`;
        if (BROWSER_TARGET.test(target)) return `${program} opens ${target} in the default browser`;
        return "";
    }
    if (program === "python" || program === "python3" || program === "py") {
        if (args[0] === "-m" && args[1] === "webbrowser") return "python -m webbrowser opens the default browser";
        const code = args[args.indexOf("-c") + 1];
        return args.includes("-c") && code && /\bwebbrowser\b/.test(code) ? "python's webbrowser module opens the default browser" : "";
    }
    if (program === "playwright") {
        if (args[0] === "test" && args.some((a) => /^--(?:headed|ui|debug)\b/.test(a))) return `playwright test ${args.find((a) => /^--(?:headed|ui|debug)\b/.test(a))} runs a visible browser`;
        if (args[0] && PLAYWRIGHT_WINDOWS.has(args[0])) return `playwright ${args[0]} opens a window`;
        return "";
    }
    if (program === "cypress") return args[0] === "open" ? "cypress open starts the interactive runner in a window" : "";
    if (program === "lighthouse") return /--chrome-flags[= ]["']?[^"']*headless/i.test(segment) ? "" : "lighthouse launches a visible Chrome unless given --chrome-flags=\"--headless\"";
    if (program === "gh") {
        if (args[0] === "browse") return args.some((a) => a === "-n" || a === "--no-browser") ? "" : "gh browse opens the default browser";
        return args.some((a) => a === "--web" || a === "-w") ? "gh --web opens the default browser" : "";
    }
    if (program === "storybook" && args[0] === "dev") return args.some((a) => a === "--ci" || a === "--no-open") ? "" : "storybook dev opens the default browser unless given --ci or --no-open";
    if (program === "vitest" && args.includes("--ui")) return args.some((a) => /^--open=false$/.test(a)) ? "" : "vitest --ui opens the default browser unless given --open=false";
    if (args.some((a) => a === "--open" || a === "--open=true") || (program === "ng" && args[0] === "serve" && args.includes("-o"))) return `${program} --open opens the default browser`;
    return "";
}

/** Why `command` would put a browser window on the user's screen, or "" when it would not. */
export function visibleBrowserReason(command: string, platform: NodeJS.Platform = process.platform): string {
    for (const segment of commandSegments(command)) {
        const reason = segmentReason(segment, platform);
        if (reason) return reason;
    }
    return "";
}

/**
 * Hook entry. Exit 2 with the reason on stderr denies the call and feeds the reason back to
 * the model; an unreadable payload, or headless turned off, lets the call through.
 */
export function runBrowserGuardHook(raw: string, headless: () => boolean = () => readConfig().config.browserHeadless): number {
    const payload = parseGuardPayload(raw);
    if (payload === null) return 0;
    const reason = visibleBrowserReason(payload.command);
    if (!reason || !headless()) return 0;
    process.stderr.write(`enigma: this command would open a browser window on the user's screen (${reason}). Browsers here run headless only: use the chrome-devtools MCP tools (headless, closed when idle), or start the browser with --headless / headless: true and close it when the check is done. To give the user a link, print the URL instead of opening it. (enigma config browser-headless off allows visible browsers.)\n`);
    return 2;
}

/** The PreToolUse group: one filtered handler per command pattern and shell tool. */
function guardGroup(): HookGroup {
    const hooks = ["Bash", "PowerShell"].flatMap((tool) =>
        COMMAND_PATTERNS.map((pattern) => ({ type: "command", command: `enigma ${MARKER}`, timeout: 10, if: `${tool}(${pattern})` }))
    );
    return { matcher: "Bash|PowerShell", hooks };
}

/** Installs (on) or removes the guard in a Claude settings.json, leaving everything else. */
export function applyBrowserGuard(settingsPath: string, on: boolean): HookWrite {
    return applyClaudeHook(settingsPath, "PreToolUse", MARKER, guardGroup(), on);
}
