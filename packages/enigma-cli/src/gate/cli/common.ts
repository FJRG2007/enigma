/**
 * Shared helpers for the gate CLI command surface: terminal styling, run-status
 * coloring, repo lookup, and DB opening. This is the minimal, faithful subset of
 * no-mistakes' `internal/cli` package helpers (`style.go`, `root.go`) that the
 * ported commands need; the full root/style/telemetry surface is a separate
 * phase. The telemetry wrappers (`trackCommand`) are intentionally dropped: each
 * command runs its body directly, which is byte-identical on stdout.
 *
 * Styling mirrors lipgloss' foreground palette (Color("1"..."8")) via 256-color
 * SGR, applied only when stdout is a color-capable TTY (so captured/piped output
 * stays plain, matching lipgloss in a non-TTY).
 */

import { Database } from "../db";
import type { Repo } from "../db";
import { getRepoByPath } from "../db";
import type { RunStatus } from "../types";
import { findGitRoot, findMainRepoRoot } from "../git";

/** Reports whether ANSI color should be emitted on stdout. */
function colorEnabled(): boolean {
    return process.stdout.isTTY === true && !("NO_COLOR" in process.env);
}

/** Wraps text in an SGR sequence when color is enabled, else returns it raw. */
function sgr(code: string, text: string): string {
    return colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** lipgloss Color("1") - red. */
export const sRed = (text: string): string => sgr("38;5;1", text);
/** lipgloss Color("2") - green. */
export const sGreen = (text: string): string => sgr("38;5;2", text);
/** lipgloss Color("3") - yellow. */
export const sYellow = (text: string): string => sgr("38;5;3", text);
/** lipgloss Color("4") - blue. */
export const sBlue = (text: string): string => sgr("38;5;4", text);
/** lipgloss Color("6") - cyan. */
export const sCyan = (text: string): string => sgr("38;5;6", text);
/** lipgloss Color("8") - dim (bright black). */
export const sDim = (text: string): string => sgr("38;5;8", text);
/** lipgloss Bold. */
export const sBold = (text: string): string => sgr("1", text);

/** Returns a styled string for the given run status. */
export function runStatusStyle(status: RunStatus): string {
    switch (status) {
        case "completed":
            return sGreen(status);
        case "failed":
            return sRed(status);
        case "running":
            return sBlue(status);
        default:
            return sDim(status);
    }
}

/** Smaller of two integers (Go's `minLen`, used for SHA truncation). */
export function minLen(a: number, b: number): number {
    return a < b ? a : b;
}

/** Writes a string to stdout (Go's `fmt.Fprint` to `cmd.OutOrStdout()`). */
export function out(text: string): void {
    process.stdout.write(text);
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Two-digit zero-padded decimal. */
function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

/** Formats a unix-seconds timestamp as "YYYY-MM-DD HH:MM:SS" in local time. */
export function formatDateTime(unixSec: number): string {
    const d = new Date(unixSec * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Formats a unix-seconds timestamp as "YYYY-MM-DD HH:MM" in local time. */
export function formatDateShort(unixSec: number): string {
    const d = new Date(unixSec * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Opens the gate database for a CLI command, ensuring the data directories
 * exist first. The port's equivalent of `openResources` (paths are already
 * resolved by the caller). The caller must close the returned Database.
 */
export function openDb(paths: import("../paths").Paths): Database {
    paths.ensureDirs();
    return new Database(paths.db());
}

/**
 * Looks up the repo for the current directory. Falls back to the main worktree
 * root so a linked worktree resolves to an already-initialized main repo.
 * Throws a user-facing error when not in a git repo or the repo is not a gate.
 */
export function findRepo(d: Database): Repo {
    let gitRoot: string;
    try {
        gitRoot = findGitRoot(".");
    } catch {
        throw new Error("not in a git repository");
    }
    const repo = getRepoByPath(d, gitRoot);
    if (repo !== null) return repo;

    let mainRoot: string;
    try {
        mainRoot = findMainRepoRoot(".");
    } catch {
        throw new Error("repo not initialized (run 'enigma gate init' first)");
    }
    if (mainRoot === gitRoot) {
        throw new Error("repo not initialized (run 'enigma gate init' first)");
    }
    const mainRepo = getRepoByPath(d, mainRoot);
    if (mainRepo === null) {
        throw new Error("repo not initialized (run 'enigma gate init' first)");
    }
    return mainRepo;
}
