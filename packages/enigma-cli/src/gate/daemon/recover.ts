/**
 * Crash recovery for orphaned managed agent servers (opencode, rovodev) plus the
 * shared process-liveness, process-start-time, and daemon PID-file helpers.
 *
 * Faithful port of the Go `internal/daemon` recovery surface: `recover_servers.go`
 * (the reaper + daemon-liveness guard + PID-file (de)serialization) and the
 * platform `proc_*.go` / `recover_servers_*.go` files, collapsed to one
 * cross-platform module.
 *
 * Divergences (intentional):
 * - Process liveness uses `process.kill(pid, 0)` (Node's portable probe): no
 *   error or EPERM means alive, ESRCH means gone - matching the Go
 *   `syscall.Kill(pid, 0)` semantics on Unix and `OpenProcess`/`GetExitCodeProcess`
 *   on Windows.
 * - Process start time is read best-effort by spawning `ps` (POSIX) or PowerShell
 *   (Windows); any failure DEGRADES SAFELY (the caller logs and skips, never
 *   kills), preserving the security property that an unverifiable PID is never
 *   terminated. The legacy zero-start-time daemon PID record is treated as a
 *   match when the process is alive, rather than performing Go's IPC health-check
 *   upgrade (avoids coupling recovery to the IPC client).
 */

import { log } from "../log";
import { join } from "node:path";
import type { Paths } from "../paths";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync, statSync } from "node:fs";
import {
    type ServerPIDInfo,
    SERVER_PID_OWNER_DAEMON,
    SERVER_PID_OWNER_WIZARD
} from "../agent/serverpid";

/**
 * Bounds the acceptable difference between a recorded process start time and the
 * one the OS reports now, in milliseconds. A small nonzero value absorbs clock
 * quirks and the sub-second gap between spawn and the recorded timestamp.
 */
const ORPHAN_START_TIME_TOLERANCE_MS = 2000;

/** The daemon PID file payload: the daemon PID and its process start time. */
export interface DaemonPIDFile {
    pid: number;
    startedAt: Date | null;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// --- Process liveness + start time --------------------------------------------

/**
 * Reports whether a process with `pid` is alive via a signal-0 probe. ESRCH is a
 * clean "gone"; EPERM means the process exists but is owned by another user
 * (still alive). Returns null on an unexpected error so callers can degrade.
 */
export function processRunning(pid: number): boolean | null {
    if (pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        if (code === "EPERM") return true;
        return null;
    }
}

/**
 * Returns the process creation time for `pid`, or null when it cannot be
 * determined. Best-effort: spawns `ps -o lstart=` on POSIX and PowerShell's
 * `Get-Process` on Windows. A null result makes the orphan reaper skip the PID
 * rather than risk killing a reused one.
 */
export function processStartTime(pid: number): Date | null {
    if (pid <= 0) return null;
    try {
        if (process.platform === "win32") return windowsProcessStartTime(pid);
        return posixProcessStartTime(pid);
    } catch {
        return null;
    }
}

function posixProcessStartTime(pid: number): Date | null {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
    }).trim();
    if (out === "") return null;
    // Format: "Mon Jan 2 15:04:05 2006" (locale forced to C above).
    const parsed = new Date(out);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function windowsProcessStartTime(pid: number): Date | null {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // Without this the daemon (which has no console of its own) pops a visible
        // PowerShell window on every probe - see the note in shellenv.ts.
        windowsHide: true
    }).trim();
    if (out === "") return null;
    const parsed = new Date(out);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startTimesMatch(a: Date, b: Date): boolean {
    return Math.abs(a.getTime() - b.getTime()) <= ORPHAN_START_TIME_TOLERANCE_MS;
}

// --- Daemon PID file ----------------------------------------------------------

/** Parses the daemon PID file bytes, tolerating the legacy bare-integer form. */
export function readDaemonPIDFileData(data: string): DaemonPIDFile {
    const text = data.trim();
    try {
        const obj = JSON.parse(text) as { pid?: unknown; started_at?: unknown; };
        const pid = typeof obj.pid === "number" ? obj.pid : 0;
        if (pid <= 0) throw new Error("invalid pid file: pid must be positive");
        const startedAt =
            typeof obj.started_at === "string" && obj.started_at !== "" ? new Date(obj.started_at) : null;
        return { pid, startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null };
    } catch {
        const pid = Number.parseInt(text, 10);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid pid file: pid must be positive");
        return { pid, startedAt: null };
    }
}

/** Reads and parses the daemon PID file at `path`. Throws ENOENT-coded on miss. */
export function readDaemonPIDFile(path: string): DaemonPIDFile {
    return readDaemonPIDFileData(readFileSync(path, "utf8"));
}

/**
 * Reports whether the daemon PID file points at a live process that is not us.
 * The recovery path runs before the new daemon writes its own PID file, so any
 * live PID here belongs to a predecessor. Fails safe: any uncertainty (a read
 * error, an unverifiable start time) returns true so the reaper does not touch a
 * possibly-live daemon's servers.
 */
export function otherDaemonAlive(p: Paths): boolean {
    let record: DaemonPIDFile;
    try {
        record = readDaemonPIDFile(p.pidFile());
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        log.warn("read daemon pid file", "path", p.pidFile(), "error", errMessage(err));
        return true;
    }
    if (record.pid === process.pid) return false;
    if (record.pid <= 0) {
        log.warn("invalid daemon pid", "path", p.pidFile(), "pid", record.pid);
        return true;
    }
    const alive = processRunning(record.pid);
    if (alive === null) {
        log.warn("check daemon pid", "pid", record.pid);
        return true;
    }
    if (!alive) return false;
    const startedAt = processStartTime(record.pid);
    if (startedAt === null) {
        log.warn("check daemon start time", "pid", record.pid);
        return true;
    }
    // A legacy record without a recorded start time is accepted as the live
    // daemon (best-effort; Go performs an IPC health-check + record upgrade).
    if (record.startedAt === null) return true;
    return startTimesMatch(startedAt, record.startedAt);
}

// --- Server PID record (de)serialization --------------------------------------

/** Reads a managed-server PID record file, returning null when unreadable. */
function readServerPIDRecord(path: string): ServerPIDInfo | null {
    let data: string;
    try {
        data = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(data) as Record<string, unknown>;
    } catch {
        return null;
    }
    const ownerStartedAt =
        typeof raw.owner_started_at === "string" && raw.owner_started_at !== ""
            ? new Date(raw.owner_started_at)
            : undefined;
    const startedAt = typeof raw.started_at === "string" ? new Date(raw.started_at) : new Date(0);
    return {
        pid: typeof raw.pid === "number" ? raw.pid : 0,
        owner: typeof raw.owner === "string" ? raw.owner : undefined,
        ownerPID: typeof raw.owner_pid === "number" ? raw.owner_pid : undefined,
        ownerStartedAt: ownerStartedAt && !Number.isNaN(ownerStartedAt.getTime()) ? ownerStartedAt : undefined,
        agent: typeof raw.agent === "string" ? raw.agent : "",
        bin: typeof raw.bin === "string" ? raw.bin : "",
        port: typeof raw.port === "number" ? raw.port : 0,
        startedAt: Number.isNaN(startedAt.getTime()) ? new Date(0) : startedAt
    };
}

function removeServerPIDFile(path: string): void {
    try {
        unlinkSync(path);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            log.warn("remove server pid file", "path", path, "error", errMessage(err));
        }
    }
}

// --- Orphan reaping -----------------------------------------------------------

/**
 * Kills managed-server subprocesses left behind by a crashed predecessor daemon
 * and deletes their stale PID files.
 *
 * Safety rules (ported verbatim):
 *   - If another daemon appears alive, skip everything (do not kill its servers).
 *   - For each PID file require the recorded start time to match the process's
 *     actual start time within tolerance; otherwise the PID was reused by
 *     something unrelated, so delete the file but never signal the process.
 */
export function reapOrphanedServers(p: Paths): void {
    const dir = p.serverPIDsDir();
    if (otherDaemonAlive(p)) {
        log.info("another daemon appears to be running; skipping managed-server reap", "dir", dir);
        return;
    }
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            log.warn("read server pids dir", "dir", dir, "error", errMessage(err));
        }
        return;
    }
    const myPID = process.pid;
    for (const name of entries) {
        const path = join(dir, name);
        let isFile: boolean;
        try {
            isFile = statSync(path).isFile();
        } catch {
            continue;
        }
        if (!isFile) continue;

        const info = readServerPIDRecord(path);
        if (info === null) {
            removeServerPIDFile(path);
            continue;
        }
        if (info.pid <= 0 || info.pid === myPID) {
            removeServerPIDFile(path);
            continue;
        }
        if (shouldSkipOrphanRecord(info)) continue;

        const alive = processRunning(info.pid);
        if (alive === null) {
            log.warn("check orphaned server", "pid", info.pid);
            continue;
        }
        if (!alive) {
            removeServerPIDFile(path);
            continue;
        }
        const actualStart = processStartTime(info.pid);
        if (actualStart === null) {
            log.warn("check orphan start time", "pid", info.pid);
            continue;
        }
        if (!startTimesMatch(actualStart, info.startedAt)) {
            log.info("orphan pid file stale; pid reused by unrelated process, not killing", "pid", info.pid, "agent", info.agent);
            removeServerPIDFile(path);
            continue;
        }
        log.info("reaping orphaned managed server", "pid", info.pid, "agent", info.agent, "bin", info.bin);
        try {
            terminateOrphanProcessGroup(info.pid);
        } catch (err) {
            log.warn("terminate orphan", "pid", info.pid, "error", errMessage(err));
            continue;
        }
        removeServerPIDFile(path);
    }
}

/**
 * Decides whether a PID record is owned by a still-live, unrelated owner (a
 * wizard process) and must be left alone. Daemon-owned (or unowned) records are
 * always reapable; a non-wizard owner is always skipped; a wizard owner is
 * skipped only while its owning process is alive with a matching start time.
 */
function shouldSkipOrphanRecord(info: ServerPIDInfo): boolean {
    const owner = info.owner ?? "";
    if (owner === "" || owner === SERVER_PID_OWNER_DAEMON) return false;
    if (owner !== SERVER_PID_OWNER_WIZARD) return true;
    const ownerPID = info.ownerPID ?? 0;
    if (ownerPID <= 0) return true;
    const alive = processRunning(ownerPID);
    if (alive === null) {
        log.warn("check wizard owner pid", "pid", ownerPID);
        return true;
    }
    if (!alive) return false;
    const startedAt = processStartTime(ownerPID);
    if (startedAt === null) {
        log.warn("check wizard owner start time", "pid", ownerPID);
        return true;
    }
    if (!info.ownerStartedAt) return true;
    return startTimesMatch(startedAt, info.ownerStartedAt);
}

/**
 * Forcibly terminates the orphaned process tree led by `pid`. Managed servers
 * are spawned detached (their process-group id equals their pid), so signaling
 * the negative pid reaps any helper children too. On Windows, `taskkill /T /F`
 * walks the tree.
 */
export function terminateOrphanProcessGroup(pid: number): void {
    if (process.platform === "win32") {
        try {
            execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
        } catch (err) {
            if (processRunning(pid) === false) return;
            throw new Error(`taskkill pid ${pid}: ${errMessage(err)}`);
        }
        return;
    }
    killPosixGroup(pid, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (processRunning(pid) === false) return;
        sleepMillis(100);
    }
    killPosixGroup(pid, "SIGKILL");
}

/** Signals the whole process group led by `pid` (negative pid), ignoring ESRCH. */
function killPosixGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        // Fall back to signaling just the direct child if the group is unavailable.
        try {
            process.kill(pid, signal);
        } catch (inner) {
            if ((inner as NodeJS.ErrnoException).code !== "ESRCH") {
                throw new Error(`${String(signal).toLowerCase()} pid ${pid}: ${errMessage(inner)}`);
            }
        }
    }
}

/** Synchronous sleep, used only on the orphan-termination grace-period poll. */
function sleepMillis(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
