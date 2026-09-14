/**
 * Shell integration that lets a managed agent be launched under its OWN command name.
 *
 * `enigma claude` puts enigma where the terminal expects the agent, and terminals decide
 * their agent features from the command the user typed, not from the process tree. Warp is
 * the concrete case (its shell integration reports the literal typed line, so `enigma claude`
 * never matches `claude` and the CLI-agent toolbar - with it, image paste - never opens), but
 * the defect class is generic: any wrapper, any terminal keying off the typed command or the
 * foreground process name. Nothing enigma does at spawn time can change what the user typed.
 *
 * So the fix is to make the typed word BE the agent: a shell function per installed tool that
 * delegates to `enigma <tool>`, keeping account selection while the terminal sees `claude`.
 *
 * Functions, deliberately, not shims on PATH: a shell function is not inherited by child
 * processes, so everything that spawns the agent programmatically (the gate's own agents, any
 * script) keeps resolving the real binary. A PATH shim would intercept those too and silently
 * change what they launch.
 */

import { homedir } from "node:os";
import * as acct from "./accounts";
import { unixProfile } from "./path-env";
import { join, dirname } from "node:path";
import { locateToolBinary } from "./tool-path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Shell dialects the generated block can be written in. */
export type ShimKind = "powershell" | "fish" | "posix";

/** Markers delimiting the managed block. A `#` comment in every dialect supported here. */
const SHIM_START = "# >>> enigma shim >>>";
const SHIM_END = "# <<< enigma shim <<<";

/** Outcome of writing or removing the block. */
export interface ShimResult {
    /** The block was added, rewritten, or removed by this call. */
    changed: boolean;
    /** Profile file that was edited. */
    profile: string;
    /** Tools the block now defines a function for (empty when removed). */
    tools: string[];
    /** Human-readable status. */
    note: string;
}

/** What the profile currently holds. */
export interface ShimStatus {
    enabled: boolean;
    profile: string;
    /** Tools the installed block covers. */
    tools: string[];
    /** Installed tools enigma can manage, whether or not the block covers them. */
    installed: string[];
}

/** Dialect of the user's login shell (the one whose profile gets the block). */
export function shimKind(): ShimKind {
    if (process.platform === "win32") return "powershell";
    return (process.env.SHELL || "").includes("fish") ? "fish" : "posix";
}

/**
 * Profile file the block belongs in. Windows uses the PowerShell CurrentUserCurrentHost
 * profile; POSIX reuses the same shell-to-profile mapping `fix-path` already applies, so the
 * two features can never disagree about which file is the user's.
 *
 * Resolved from USERPROFILE/HOME via `homedir()`, which is what makes this testable against a
 * throwaway home instead of the developer's own profile.
 */
export function shimProfilePath(): string {
    if (process.platform !== "win32") return unixProfile();
    return join(homedir(), "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
}

/** Tools enigma manages that are actually installed on this machine. */
export function installedTools(): string[] {
    return acct.TOOL_NAMES.filter((tool) => locateToolBinary(tool).effective !== null);
}

/**
 * One shell function: run the agent through enigma when enigma is available, and fall back to
 * the real binary when it is not, so a broken or uninstalled enigma can never make the agent
 * itself unreachable from the shell.
 */
function shimFunction(tool: string, kind: ShimKind): string {
    const bin = acct.getTool(tool).bin;
    if (kind === "powershell") {
        return [
            `function global:${tool} {`,
            "    if (Get-Command enigma -CommandType Application -ErrorAction SilentlyContinue) {",
            `        enigma ${tool} @args`,
            "    } else {",
            `        ${bin}.exe @args`,
            "    }",
            "}",
        ].join("\n");
    }
    if (kind === "fish") {
        return [
            `function ${tool}`,
            "    if command -v enigma >/dev/null 2>&1",
            `        enigma ${tool} $argv`,
            "    else",
            `        command ${bin} $argv`,
            "    end",
            "end",
        ].join("\n");
    }
    return [
        `${tool}() {`,
        "    if command -v enigma >/dev/null 2>&1; then",
        `        enigma ${tool} "$@"`,
        "    else",
        `        command ${bin} "$@"`,
        "    fi",
        "}",
    ].join("\n");
}

/** The full managed block for `tools`, markers included. */
export function renderBlock(tools: string[], kind: ShimKind): string {
    const bypass = tools.map((tool) => (kind === "powershell" ? `${acct.getTool(tool).bin}.exe` : `command ${acct.getTool(tool).bin}`));
    const header = [
        SHIM_START,
        "# Managed by 'enigma shim' - edits here are overwritten. Remove with 'enigma shim off'.",
        "# Terminals decide their agent features from the command you type, so typing the agent's",
        "# own name keeps that detection while still launching enigma's active account.",
        `# Bypass enigma for one call: ${bypass.join(", ") || "n/a"}`,
    ].join("\n");
    return [header, ...tools.map((tool) => shimFunction(tool, kind)), SHIM_END, ""].join("\n");
}

/** Read a profile, treating an absent one as empty. */
function readProfile(path: string): string {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** The profile's content with any existing managed block removed. */
function withoutBlock(content: string): string {
    const start = content.indexOf(SHIM_START);
    if (start === -1) return content;
    const end = content.indexOf(SHIM_END, start);
    if (end === -1) return `${content.slice(0, start).trimEnd()}\n`;
    const after = content.slice(end + SHIM_END.length).replace(/^\n/, "");
    const before = content.slice(0, start).trimEnd();
    return before ? `${before}\n${after}` : after;
}

/** Tools the block currently installed in `content` defines a function for. */
function blockTools(content: string): string[] {
    const start = content.indexOf(SHIM_START);
    if (start === -1) return [];
    const end = content.indexOf(SHIM_END, start);
    const block = content.slice(start, end === -1 ? undefined : end);
    return acct.TOOL_NAMES.filter((tool) => block.includes(`enigma ${tool} `));
}

/** What the user's profile currently holds, for `enigma shim status`. */
export function shimStatus(): ShimStatus {
    const profile = shimProfilePath();
    const tools = blockTools(readProfile(profile));
    return { enabled: tools.length > 0, profile, tools, installed: installedTools() };
}

/**
 * Write or remove the managed block. Rewriting is idempotent: the previous block is replaced
 * whole, so enabling again after installing another agent simply picks it up.
 *
 * `tools` defaults to every installed tool; it is injectable so the behavior can be checked
 * without depending on which agents happen to be installed on the machine running the test.
 */
export function applyShim(on: boolean, tools: string[] = installedTools()): ShimResult {
    const profile = shimProfilePath();
    const kind = shimKind();
    const before = readProfile(profile);
    const stripped = withoutBlock(before);

    if (!on) {
        if (before === stripped) return { changed: false, profile, tools: [], note: "No enigma shim block in your shell profile." };
        writeFileSync(profile, stripped);
        return { changed: true, profile, tools: [], note: `Removed the enigma shim block from ${profile}.` };
    }

    if (!tools.length) {
        return { changed: false, profile, tools: [], note: "No supported agent is installed, so there is nothing to shim." };
    }

    const body = stripped.trimEnd();
    const next = body ? `${body}\n\n${renderBlock(tools, kind)}` : renderBlock(tools, kind);
    if (next === before) return { changed: false, profile, tools, note: `Already up to date in ${profile}.` };
    mkdirSync(dirname(profile), { recursive: true });
    writeFileSync(profile, next);
    return { changed: true, profile, tools, note: `Wrote ${tools.join(", ")} into ${profile}. Open a new terminal to pick it up.` };
}
