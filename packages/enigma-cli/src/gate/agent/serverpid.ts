/**
 * On-disk PID tracking for managed agent servers (opencode, rovodev).
 *
 * Faithful port of the Go `internal/agent/serverpid.go` plus the two
 * `serverpid_transient_*` build-tagged variants. A managed server writes a PID
 * record after its subprocess starts and removes it after a clean shutdown, so
 * a freshly started daemon can reap orphans left by a crashed predecessor.
 *
 * Divergences (intentional):
 * - The Go global state (`serverPIDsDir`, `serverPIDOwner`, `processStartedAt`)
 *   and its setters/getters are preserved as module-level state so a future
 *   daemon port can wire tracking once, exactly like Go.
 * - PID liveness is not needed here; the Windows sharing-collision retry is
 *   mapped from Go's `syscall.Errno(5|32)` to Node's `EPERM`/`EACCES`/`EBUSY`.
 */

import { log } from "../log";
import { join } from "node:path";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";

/**
 * Records a managed server's identity on disk so a freshly started daemon can
 * reap orphaned subprocesses left behind by a crashed predecessor.
 */
export interface ServerPIDInfo {
    pid: number;
    owner?: string;
    ownerPID?: number;
    ownerStartedAt?: Date;
    agent: string;
    bin: string;
    port: number;
    startedAt: Date;
}

export const SERVER_PID_OWNER_DAEMON = "daemon";
export const SERVER_PID_OWNER_WIZARD = "wizard";

const maxRenameAttempts = 50;

let serverPIDsDir = "";
let serverPIDOwner = "";
const processStartedAt = new Date();

/** Sleep between rename retries (test seam mirroring the Go package var). */
let sleepServerPIDRenameRetry = (): void => {
    sleepMillis(2);
};

/**
 * Configures where managed-server PID files are written. Callers (typically the
 * daemon at startup) should point this at `Paths.serverPIDsDir()`. Empty string
 * disables PID tracking, the default for processes without a daemon identity.
 */
export function setServerPIDsDir(dir: string): void {
    setServerPIDsDirForOwner(dir, dir !== "" ? SERVER_PID_OWNER_DAEMON : "");
}

export function setServerPIDsDirForOwner(dir: string, owner: string): void {
    serverPIDsDir = dir;
    serverPIDOwner = owner;
}

/** Configured PID-tracking directory, or "" when tracking is disabled. */
export function currentServerPIDsDir(): string {
    return serverPIDsDir;
}

export function currentServerPIDOwner(): string {
    return serverPIDOwner;
}

export function currentProcessStartedAt(): Date {
    return processStartedAt;
}

/**
 * Serializes info into a uniquely named file under dir and returns the file
 * path. When dir is empty this is a no-op returning "" so callers can treat "no
 * tracking" uniformly. Failures are logged but not surfaced: PID tracking is
 * best-effort and must not block a server from starting.
 */
export function writeServerPIDFile(dir: string, info: ServerPIDInfo): string {
    if (dir === "") return "";
    try {
        mkdirSync(dir, { recursive: true });
    } catch (err) {
        log.warn("create server pid dir", "dir", dir, "error", errMessage(err));
        return "";
    }

    const name = `${info.agent}-${info.pid}.json`;
    const path = join(dir, name);
    const data = JSON.stringify(marshalServerPIDInfo(info));
    const tmpPath = join(dir, `${name}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);

    try {
        writeFileSync(tmpPath, data);
    } catch (err) {
        log.warn("write server pid temp file", "path", tmpPath, "error", errMessage(err));
        return "";
    }

    try {
        replaceServerPIDFile(tmpPath, path);
    } catch (err) {
        removeServerPIDFile(tmpPath);
        log.warn("write server pid file", "path", path, "error", errMessage(err));
        return "";
    }
    return path;
}

function replaceServerPIDFile(tmpPath: string, path: string): void {
    for (let attempt = 0; ; attempt++) {
        try {
            renameSync(tmpPath, path);
            return;
        } catch (err) {
            if (attempt >= maxRenameAttempts - 1 || !isTransientPIDReplaceError(err)) throw err;
            sleepServerPIDRenameRetry();
        }
    }
}

/** Deletes path, silently ignoring missing files. */
export function removeServerPIDFile(path: string): void {
    if (path === "") return;
    try {
        rmSync(path, { force: false });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        log.warn("remove server pid file", "path", path, "error", errMessage(err));
    }
}

/**
 * Reports whether err is the brief Windows rename collision that can surface
 * while another process still has the destination PID file open (Go's
 * `syscall.Errno(5)` access-denied / `Errno(32)` sharing-violation).
 */
export function isTransientPIDReplaceError(err: unknown): boolean {
    if (process.platform !== "win32") return false;
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Reports whether err is the brief Windows open sharing collision (Errno 32). */
export function isTransientPIDOpenError(err: unknown): boolean {
    if (process.platform !== "win32") return false;
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "EBUSY";
}

function marshalServerPIDInfo(info: ServerPIDInfo): Record<string, unknown> {
    const out: Record<string, unknown> = { pid: info.pid };
    if (info.owner) out.owner = info.owner;
    if (info.ownerPID) out.owner_pid = info.ownerPID;
    if (info.ownerStartedAt) out.owner_started_at = info.ownerStartedAt.toISOString();
    out.agent = info.agent;
    out.bin = info.bin;
    out.port = info.port;
    out.started_at = info.startedAt.toISOString();
    return out;
}

/** Synchronous sleep, used only on the rare Windows rename-collision retry. */
function sleepMillis(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
