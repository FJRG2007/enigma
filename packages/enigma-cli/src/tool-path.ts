/**
 * OS-agnostic discovery and repair of a coding agent's launch binary.
 *
 * Claude Code (and the other supported CLIs) install to locations that are not
 * always on the shell PATH - npm global bins, the native-installer dir, bun/volta
 * shims - so `enigma <tool>` can fail to spawn the agent even when it is installed
 * (the launcher would fall back to a bare command name that the OS cannot resolve).
 * This module finds the binary in the well-known per-OS locations and persists its
 * absolute path to the enigma config (toolPaths), so the launcher uses it directly.
 *
 * The persisted path is consumed by launchTool (accounts.ts), between the env
 * override (ENIGMA_<TOOL>_BIN) and a plain PATH lookup. This module is the only
 * place that knows the candidate install directories; adding one is a single edge.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolveBin, resolveBinIn } from "./util";
import { readConfig, setToolPath } from "./config";
import { getTool, TOOL_NAMES, type ToolSpec } from "./accounts";

/** Where a tool's binary was found, and what the launcher will actually use right now. */
export interface ToolLocation {
    tool: string;
    label: string;
    /** The default command name the tool is launched with (e.g. "claude"). */
    command: string;
    /** Value of ENIGMA_<TOOL>_BIN when it points at an existing file, else null. */
    env: string | null;
    /** Persisted toolPaths entry when it points at an existing file, else null. */
    configured: string | null;
    /** Absolute path resolved on the shell PATH, or null. */
    onPath: string | null;
    /** Absolute path found in a well-known install dir but NOT on PATH, or null. */
    offPath: string | null;
    /** Path the launcher resolves today: env > configured > onPath (null if none). */
    effective: string | null;
}

/** Outcome of repairing one tool's launch path. */
export interface FixResult {
    tool: string;
    label: string;
    command: string;
    /** The tool is now launchable through enigma. */
    ok: boolean;
    /** A new launch path was persisted to the config (a real repair happened). */
    changed: boolean;
    /** Whether the tool was found installed anywhere. */
    installed: boolean;
    /** The path now in effect, or null when the tool was not found. */
    path: string | null;
    /** Human-readable summary for CLI/TUI/dashboard output. */
    message: string;
}

/** A string when it names an existing file, else null. */
function existingFile(path: string | undefined | null): string | null {
    return path && existsSync(path) ? path : null;
}

/**
 * Well-known directories a coding-agent CLI may install to, beyond the shell PATH.
 * Cross-platform and best-effort: directories that do not exist are simply skipped
 * by resolveBinIn. Order is most-specific first so a native install wins over a
 * generic toolchain dir.
 */
function candidateBinDirs(): string[] {
    // Explicit override (path-delimited) replaces discovery entirely: lets a power
    // user point at a custom install dir, and lets tests run hermetically without
    // depending on whatever the host happens to have in /usr/bin or %APPDATA%.
    const override = process.env.ENIGMA_TOOL_PATH_DIRS;
    if (override) return override.split(process.platform === "win32" ? ";" : ":").filter(Boolean);

    const home = homedir();
    const dirs: string[] = [];
    if (process.platform === "win32") {
        const { APPDATA, LOCALAPPDATA, ProgramFiles, ProgramW6432 } = process.env;
        dirs.push(join(home, ".local", "bin"));
        dirs.push(join(home, ".claude", "local"));
        dirs.push(join(home, ".bun", "bin"));
        if (LOCALAPPDATA) {
            dirs.push(join(LOCALAPPDATA, "Programs", "claude"));
            dirs.push(join(LOCALAPPDATA, "pnpm"));
            dirs.push(join(LOCALAPPDATA, "Yarn", "bin"));
        }
        if (APPDATA) dirs.push(join(APPDATA, "npm"));
        dirs.push(join(home, "AppData", "Roaming", "npm"));
        if (ProgramFiles) dirs.push(join(ProgramFiles, "nodejs"));
        if (ProgramW6432) dirs.push(join(ProgramW6432, "nodejs"));
    } else {
        dirs.push(join(home, ".local", "bin"));
        dirs.push(join(home, ".claude", "local"));
        dirs.push(join(home, ".bun", "bin"));
        dirs.push(join(home, ".volta", "bin"));
        dirs.push(join(home, ".npm-global", "bin"));
        dirs.push(join(home, ".asdf", "shims"));
        if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
        dirs.push("/usr/local/bin");
        dirs.push("/usr/bin");
        dirs.push("/opt/homebrew/bin");
        dirs.push("/opt/local/bin");
    }
    return dirs;
}

/** Resolve where `toolName`'s binary lives across all known sources. */
export function locateToolBinary(toolName: string): ToolLocation {
    const tool: ToolSpec = getTool(toolName);
    const env = existingFile(process.env[tool.binEnv]);
    const configured = existingFile(readConfig().config.toolPaths?.[toolName]);
    const onPath = resolveBin(tool.bin);
    const offPath = onPath ? null : resolveBinIn(tool.bin, candidateBinDirs());
    return {
        tool: tool.name,
        label: tool.label,
        command: tool.bin,
        env,
        configured,
        onPath,
        offPath,
        effective: env || configured || onPath || null,
    };
}

/** One-line status of a tool's launch path, for listings (TUI/dashboard hints). */
export function describeLocation(loc: ToolLocation): string {
    if (loc.env) return "via env override";
    if (loc.onPath) return "on PATH";
    if (loc.configured) return "fixed";
    if (loc.offPath) return "installed, off PATH";
    return "not installed";
}

/**
 * Make `enigma <tool>` work: if the tool is installed but unreachable, persist the
 * discovered absolute path; if it already resolves, leave the config untouched; if
 * it is not installed anywhere, report that so the caller can guide the user.
 */
export function fixToolPath(toolName: string, scope: "global" | "local" = "global"): FixResult {
    const tool = getTool(toolName);
    const loc = locateToolBinary(toolName);
    const base = { tool: loc.tool, label: loc.label, command: loc.command };

    // Already launchable without a persisted fix: leave the config alone.
    if (loc.env) {
        return { ...base, ok: true, changed: false, installed: true, path: loc.env, message: `${loc.label} resolves via ${tool.binEnv} (${loc.env}).` };
    }
    if (loc.configured) {
        return { ...base, ok: true, changed: false, installed: true, path: loc.configured, message: `${loc.label} already fixed: ${loc.configured}.` };
    }
    if (loc.onPath) {
        return { ...base, ok: true, changed: false, installed: true, path: loc.onPath, message: `${loc.label} works on PATH (${loc.onPath}); '${loc.command}' launches it.` };
    }
    // Installed but off PATH: persist the discovered path so the launcher uses it.
    if (loc.offPath) {
        setToolPath(toolName, loc.offPath, scope);
        return { ...base, ok: true, changed: true, installed: true, path: loc.offPath, message: `${loc.label} found off PATH at ${loc.offPath}; saved so 'enigma ${loc.command}' now launches it.` };
    }
    // Not found anywhere.
    return { ...base, ok: false, changed: false, installed: false, path: null, message: `${loc.label} not found. Install it, then run 'enigma fix-path ${loc.command}'.` };
}

/** Fix the launch path for every supported tool (used by the TUI/dashboard "fix all"). */
export function fixAllToolPaths(scope: "global" | "local" = "global"): FixResult[] {
    return TOOL_NAMES.map((t) => fixToolPath(t, scope));
}

/** Per-tool launch-path status for listings: name, label and a one-line description. */
export function toolPathStatuses(): Array<{ name: string; label: string; status: string; path: string | null }> {
    return TOOL_NAMES.map((t) => {
        const loc = locateToolBinary(t);
        return { name: t, label: loc.label, status: describeLocation(loc), path: loc.effective };
    });
}
