/**
 * Faithful port of the no-mistakes `internal/shellenv` Go package.
 *
 * Two responsibilities:
 *   1. Process-group isolation + whole-tree cancellation. The Go
 *      `ConfigureShellCommand(*exec.Cmd)` puts a child in its own process group
 *      (Unix `Setpgid` / Windows `CREATE_NEW_PROCESS_GROUP`) and installs a
 *      cancel hook that kills the WHOLE tree on context cancellation, so
 *      grandchildren (npm -> node test workers, agent-spawned git/build) cannot
 *      survive and hold a worktree lock. Node sets these flags at spawn time, so
 *      the equivalent is `spawnConfigured` / `configureSpawnOptions` / `killTree`
 *      wired to an `AbortSignal` (mirroring Go's `cmd.Cancel`).
 *   2. Login-shell environment + PATH construction (`resolve`, `loginShell`,
 *      `wellKnownBinDirs`, `augmentPath`, ...), ported verbatim from shellenv.go.
 *
 * Node-builtins only; zero npm dependencies.
 */

import { log } from "./log";
import { userInfo, type UserInfo } from "node:os";
import { join, basename, delimiter } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

// Go's runtime.GOOS uses "windows"/"darwin"/"linux"; Node's process.platform
// uses "win32" but agrees on the rest. Map so the string comparisons below
// stay byte-faithful to the source.
const GOOS = process.platform === "win32" ? "windows" : process.platform;

// shellCommandTimeout bounds the one-time login-shell probe. It is deliberately
// forgiving: a 2s budget was too tight for an interactive login shell under
// cold-start load and silently dropped the daemon onto a degraded fallback PATH
// that omitted version-manager dirs (nvm/fnm/volta) - the #143 trigger.
const shellCommandTimeout = 30 * 1000;

let cachedEnv: string[] | null = null;

// -- Process-group isolation + whole-tree kill (ConfigureShellCommand) --------

/**
 * Build the SpawnOptions that isolate a child in its own process group, the
 * prerequisite for a whole-tree kill. POSIX uses `detached: true` (a new process
 * group, mirroring Go's `Setpgid`) - this is REQUIRED for `killTree` to signal
 * the negative pid. Windows relies on `taskkill /T` walking the pid tree, so it
 * only forces `windowsHide` (overridable by the caller).
 */
export function configureSpawnOptions(options: SpawnOptions = {}): SpawnOptions {
    if (process.platform === "win32") {
        return { windowsHide: true, ...options };
    }
    return { ...options, detached: true };
}

/**
 * Kill the whole process tree rooted at `child`. POSIX sends SIGKILL to the
 * negative pid (the process group, requires `detached: true`); ESRCH means the
 * group already exited and is benign. Windows runs `taskkill /T /F /PID <pid>`
 * (/T walks the tree, /F forces). Either path falls back to killing at least the
 * direct child so a hung Wait/pipe read can make progress, mirroring the Go
 * Windows backstop.
 */
export function killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
        try {
            execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
        } catch {
            try {
                child.kill("SIGKILL");
            } catch { /* already gone */ }
        }
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        try {
            child.kill("SIGKILL");
        } catch { /* already gone */ }
    }
}

/**
 * Spawn `command` in its own process group and, when an `AbortSignal` is passed,
 * kill the WHOLE tree on abort (the Node equivalent of Go's `cmd.Cancel`). The
 * signal is handled here rather than by `spawn` so abort triggers a tree kill,
 * not just a direct-child terminate.
 */
export function spawnConfigured(
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {}
): ChildProcess {
    const { signal, ...rest } = options;
    const child = spawn(command, args, configureSpawnOptions(rest));
    if (signal) {
        const onAbort = (): void => { killTree(child); };
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
            child.once("exit", () => signal.removeEventListener("abort", onAbort));
        }
    }
    return child;
}

// -- Login-shell environment + PATH construction ------------------------------

/** Resolve the user's login shell (SHELL env, then dscl/getent, then bash). */
export function loginShell(): string {
    const shell = process.env.SHELL;
    if (shell && shell.trim() !== "") return shell;
    if (GOOS === "darwin") {
        const fromDscl = shellFromDSCL();
        if (fromDscl !== "") return fromDscl;
    }
    if (GOOS === "linux") {
        const fromGetent = shellFromGetent();
        if (fromGetent !== "") return fromGetent;
    }
    return "bash";
}

/** Report whether the shell accepts an interactive (`-i`) login probe. */
export function supportsInteractive(shell: string): boolean {
    const base = basename(shell);
    return base === "bash" || base === "zsh";
}

/**
 * Resolve the login-shell environment, caching only a successful shell probe. A
 * degraded fallback is never cached so a later call can retry and recover the
 * real PATH (the #143 failure mode).
 */
export function resolve(): string[] {
    if (cachedEnv !== null) return cachedEnv.slice();
    const [resolved, resolvedFromShell] = resolveUncached();
    if (resolvedFromShell && cachedEnv === null) {
        cachedEnv = resolved.slice();
    }
    return resolved.slice();
}

/** Apply the resolved environment onto this process's `process.env`. */
export function applyToProcess(): void {
    for (const entry of resolve()) {
        const idx = entry.indexOf("=");
        const key = idx === -1 ? entry : entry.slice(0, idx);
        if (key === "") continue;
        const value = idx === -1 ? "" : entry.slice(idx + 1);
        process.env[key] = value;
    }
}

/**
 * Probe the login shell for its environment. The boolean reports whether the
 * result came from a successful probe (cacheable) or a degraded fallback.
 */
function resolveUncached(): [string[], boolean] {
    if (GOOS === "windows") return [osEnviron(), true];

    const shell = loginShell();
    let args = ["-l", "-c", "env -0"];
    if (supportsInteractive(shell)) {
        args = ["-l", "-i", "-c", "env -0"];
    }
    let out: string;
    try {
        out = shellCommandOutput(shell, ...args);
    } catch (err) {
        log.warn(
            "login shell environment resolution failed; using a degraded fallback PATH that may omit version-manager dirs (nvm/fnm/volta), so agents may not find tools like pnpm (#143)",
            "shell", shell, "err", String((err as Error)?.message ?? err)
        );
        return [augmentPath(ensureShellEntry(osEnviron(), shell)), false];
    }
    const resolved = parseEnvOutput(out);
    if (resolved.length === 0) {
        log.warn(
            "login shell environment resolution returned no entries; using a degraded fallback PATH that may omit version-manager dirs (nvm/fnm/volta), so agents may not find tools like pnpm (#143)",
            "shell", shell
        );
        return [augmentPath(ensureShellEntry(osEnviron(), shell)), false];
    }
    return [augmentPath(ensureShellEntry(resolved, shell)), true];
}

/**
 * Common binary install locations that should be on PATH (Homebrew, user-local,
 * Go/Rust package managers). Missing dirs are kept unchanged - the launcher's
 * lookups ignore non-existent PATH entries, so filtering would only add cost.
 */
export function wellKnownBinDirs(): string[] {
    return wellKnownBinDirsForHome(homeDir());
}

/** Well-known bin dirs computed from an explicit home directory. */
export function wellKnownBinDirsForHome(home: string): string[] {
    const dirs: string[] = [];
    if (home.trim() !== "") {
        dirs.push(
            join(home, ".local", "bin"),
            join(home, "go", "bin"),
            join(home, ".cargo", "bin"),
            join(home, "bin")
        );
    }
    dirs.push(
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin"
    );
    return dirs;
}

function homeDir(): string {
    const home = process.env.HOME;
    if (home && home.trim() !== "") return home;
    const info = osUserInfo();
    if (info === null) return "";
    return info.homedir.trim();
}

/**
 * Merge WellKnownBinDirs into the PATH entry of env, preserving existing entries
 * in order (user PATH still wins) and appending any well-known dirs not already
 * present. Synthesizes a PATH entry when env lacks one.
 */
function augmentPath(env: string[]): string[] {
    const sep = delimiter;
    let pathIdx = -1;
    let existing: string[] = [];
    for (let i = 0; i < env.length; i++) {
        const entry = env[i];
        if (entry.startsWith("PATH=")) {
            pathIdx = i;
            const raw = entry.slice("PATH=".length);
            if (raw !== "") existing = raw.split(sep);
            break;
        }
    }
    const seen = new Set<string>(existing);
    for (const dir of wellKnownBinDirs()) {
        if (seen.has(dir)) continue;
        existing.push(dir);
        seen.add(dir);
    }
    const merged = `PATH=${existing.join(sep)}`;
    if (pathIdx >= 0) env[pathIdx] = merged;
    else env.push(merged);
    return env;
}

function parseEnvOutput(out: string): string[] {
    const parts = out.split("\x00");
    const env: string[] = [];
    for (const part of parts) {
        const entry = parseEnvEntry(part);
        if (entry === null) continue;
        env.push(entry);
    }
    return env;
}

function parseEnvEntry(part: string): string | null {
    if (part === "") return null;
    const candidateStarts = [0];
    for (let i = 0; i < part.length; i++) {
        const ch = part[i];
        if (ch === "\n" || ch === "\r") candidateStarts.push(i + 1);
    }
    for (const start of candidateStarts) {
        const candidate = part.slice(start).replace(/^[\r\n]+/, "");
        if (candidate === "") continue;
        const idx = candidate.indexOf("=");
        if (idx !== -1 && validEnvKey(candidate.slice(0, idx))) return candidate;
    }
    return null;
}

function validEnvKey(key: string): boolean {
    if (key === "") return false;
    for (let i = 0; i < key.length; i++) {
        const code = key.charCodeAt(i);
        const isAlpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
        if (i === 0) {
            if (!isAlpha) return false;
            continue;
        }
        const isAlnum = isAlpha || (code >= 48 && code <= 57);
        if (!isAlnum) return false;
    }
    return true;
}

function ensureShellEntry(env: string[], shell: string): string[] {
    for (const entry of env) {
        if (entry.startsWith("SHELL=")) return env;
    }
    env.push(`SHELL=${shell}`);
    return env;
}

function shellFromDSCL(): string {
    const username = currentUsername();
    if (username === "") return "";
    let out: string;
    try {
        out = shellCommandOutput("dscl", ".", "-read", `/Users/${username}`, "UserShell");
    } catch {
        return "";
    }
    let line = out.trim();
    if (line.startsWith("UserShell:")) line = line.slice("UserShell:".length);
    return line.trim();
}

function shellFromGetent(): string {
    const username = currentUsername();
    if (username === "") return "";
    let out: string;
    try {
        out = shellCommandOutput("getent", "passwd", username);
    } catch {
        return "";
    }
    const line = out.trim();
    if (line === "") return "";
    const parts = line.split(":");
    if (parts.length === 0) return "";
    return parts[parts.length - 1].trim();
}

function currentUsername(): string {
    const username = process.env.USER;
    if (username && username.trim() !== "") return username;
    const info = osUserInfo();
    if (info === null) return "";
    return info.username.trim();
}

function osUserInfo(): UserInfo<string> | null {
    try {
        return userInfo({ encoding: "utf8" });
    } catch {
        return null;
    }
}

/** Snapshot the current environment as `KEY=value` entries (Go's os.Environ). */
function osEnviron(): string[] {
    const env: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        env.push(`${key}=${value}`);
    }
    return env;
}

/** Run a short command and return its stdout, bounded by shellCommandTimeout. */
function shellCommandOutput(name: string, ...args: string[]): string {
    return execFileSync(name, args, {
        encoding: "utf8",
        timeout: shellCommandTimeout,
        maxBuffer: 16 * 1024 * 1024
    });
}

/** Reset the resolution cache (test seam, mirrors Go's resetForTests). */
export function resetForTests(): void {
    cachedEnv = null;
}
