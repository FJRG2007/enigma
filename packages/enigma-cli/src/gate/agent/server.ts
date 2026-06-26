/**
 * Managed HTTP server lifecycle for the rovodev and opencode backends.
 *
 * Faithful port of the Go `internal/agent/server.go` plus its two platform
 * files (`server_unix.go`, `server_windows.go`): spawn a persistent server
 * process, wait for its health endpoint, and shut it down gracefully (SIGTERM
 * then SIGKILL) on demand. The process outlives individual Run calls and is not
 * tied to a request's AbortSignal; the signal only bounds the health check.
 *
 * Divergences (intentional):
 * - Go's `*exec.Cmd` becomes a Node `ChildProcess` spawned via `spawnConfigured`
 *   (POSIX `detached: true` == Setpgid; no signal is wired so the server is not
 *   killed on request abort, matching Go's `exec.Command` (not CommandContext)).
 * - Process-group signalling: POSIX signals the negative pid (SIGTERM/SIGKILL);
 *   Windows hard-kills the tree (`killTree`), mirroring Go's Windows path that
 *   always calls `Process.Kill()` regardless of the graceful flag.
 * - The managed-server output sink is a Node WritableStream (default stderr).
 */

import { log } from "../log";
import { gitSafeEnv } from "./env";
import { createServer } from "node:net";
import type { Stream } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { spawnConfigured, killTree } from "../shellenv";
import {
    writeServerPIDFile,
    removeServerPIDFile,
    currentServerPIDsDir,
    currentServerPIDOwner,
    currentProcessStartedAt
} from "./serverpid";

/**
 * Generous health-check deadline. Opencode has been observed taking 15s+ to
 * emit its first log line under host load, so cold starts must be absorbed.
 */
const DEFAULT_HEALTH_TIMEOUT = 60 * 1000;

let managedServerOutput: Stream = process.stderr;

/**
 * Routes future managed-server stdout/stderr to w. Passing null resets to the
 * default (stderr). Only affects servers started after this call.
 */
export function setManagedServerOutput(w: Stream | null): void {
    managedServerOutput = w ?? process.stderr;
}

function currentManagedServerOutput(): Stream {
    return managedServerOutput;
}

/** Finds an ephemeral port by binding to :0 on loopback and releasing. */
export function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once("error", err => reject(new Error(`allocate port: ${err.message}`)));
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            if (addr === null || typeof addr === "string") {
                srv.close();
                reject(new Error("allocate port: no address"));
                return;
            }
            const port = addr.port;
            srv.close(() => resolve(port));
        });
    });
}

/** Manages a persistent HTTP server process (rovodev and opencode agents). */
export class ManagedServer {
    private readonly child: ChildProcess;
    private readonly portNumber: number;
    private readonly pidFile: string;
    private readonly healthTimeout: number;
    private exited = false;
    private waitErr: unknown;
    private readonly exitedPromise: Promise<void>;

    private constructor(child: ChildProcess, port: number, pidFile: string, healthTimeout: number) {
        this.child = child;
        this.portNumber = port;
        this.pidFile = pidFile;
        this.healthTimeout = healthTimeout;
        this.exitedPromise = new Promise<void>(resolve => {
            const done = (err?: unknown): void => {
                if (this.exited) return;
                this.exited = true;
                this.waitErr = err;
                resolve();
            };
            child.once("exit", (code, sig) => done(exitError(code, sig)));
            child.once("error", err => done(err));
        });
    }

    /**
     * Spawns the server process on a given port and waits for health. The
     * process outlives individual Run calls and is stopped via shutdown(). The
     * signal only bounds the health check. agentName tags the PID tracking file
     * so crash-recovery can identify orphans.
     */
    static async start(
        signal: AbortSignal | undefined,
        agentName: string,
        bin: string,
        args: string[],
        cwd: string,
        healthPath: string,
        port: number
    ): Promise<ManagedServer> {
        const out = currentManagedServerOutput();
        let child: ChildProcess;
        try {
            child = spawnConfigured(bin, args, {
                cwd,
                env: gitSafeEnv(cwd),
                stdio: ["ignore", out, out]
            });
        } catch (err) {
            throw new Error(`start server ${bin}: ${errMessage(err)}`);
        }
        if (child.pid === undefined) {
            throw new Error(`start server ${bin}: no pid`);
        }

        const pidFile = writeServerPIDFile(currentServerPIDsDir(), {
            pid: child.pid,
            owner: currentServerPIDOwner(),
            ownerPID: process.pid,
            ownerStartedAt: currentProcessStartedAt(),
            agent: agentName,
            bin,
            port,
            startedAt: new Date()
        });

        const srv = new ManagedServer(child, port, pidFile, DEFAULT_HEALTH_TIMEOUT);
        try {
            await srv.waitForHealth(signal, healthPath);
        } catch (err) {
            await srv.shutdown();
            throw err;
        }
        return srv;
    }

    /** The server's base URL. */
    baseURL(): string {
        return `http://127.0.0.1:${this.portNumber}`;
    }

    /**
     * Polls the health endpoint until it returns 200 or timeout. Returns
     * immediately with an exit error if the process dies before becoming
     * healthy, and with the abort reason if the signal fires.
     */
    private async waitForHealth(signal: AbortSignal | undefined, path: string): Promise<void> {
        const url = this.baseURL() + path;
        const timeout = this.healthTimeout > 0 ? this.healthTimeout : DEFAULT_HEALTH_TIMEOUT;
        const deadline = Date.now() + timeout;

        for (;;) {
            if (signal?.aborted) throw abortReason(signal);
            if (this.exited) throw new Error(`server exited before becoming healthy: ${errMessage(this.waitErr)}`);
            if (Date.now() >= deadline) {
                throw new Error(`server health check timed out after ${formatHealthTimeout(timeout)}`);
            }

            try {
                const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
                if (resp.status === 200) return;
            } catch { /* not healthy yet */ }

            if (this.exited) throw new Error(`server exited before becoming healthy: ${errMessage(this.waitErr)}`);
            await this.sleepOrExit(250);
        }
    }

    /**
     * Gracefully stops the server process: SIGTERM, wait 3s, then SIGKILL, wait
     * 5s. The PID tracking file is removed only after the process is confirmed
     * exited, so an unreaped process leaves the file for a future daemon.
     */
    async shutdown(): Promise<void> {
        if (this.child.pid === undefined || this.exited) {
            removeServerPIDFile(this.pidFile);
            return;
        }

        this.signalProcess(false);
        if (await this.waitExit(3000)) {
            removeServerPIDFile(this.pidFile);
            return;
        }

        log.warn("server did not exit gracefully, sending SIGKILL", "pid", this.child.pid);
        this.signalProcess(true);
        if (await this.waitExit(5000)) {
            removeServerPIDFile(this.pidFile);
        } else {
            log.warn("server process did not exit after SIGKILL", "pid", this.child.pid);
        }
    }

    /** Signals the managed process group (POSIX) or hard-kills the tree (win). */
    private signalProcess(force: boolean): void {
        const pid = this.child.pid;
        if (pid === undefined) return;
        if (process.platform === "win32") {
            killTree(this.child);
            return;
        }
        const sig = force ? "SIGKILL" : "SIGTERM";
        try {
            process.kill(-pid, sig);
        } catch {
            try {
                this.child.kill(sig);
            } catch { /* already gone */ }
        }
    }

    /** Resolves true if the process exited within ms, false on timeout. */
    private waitExit(ms: number): Promise<boolean> {
        if (this.exited) return Promise.resolve(true);
        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => resolve(false), ms);
            this.exitedPromise.then(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    /** Sleeps up to ms, returning early when the process exits. */
    private sleepOrExit(ms: number): Promise<void> {
        return new Promise<void>(resolve => {
            const timer = setTimeout(resolve, ms);
            this.exitedPromise.then(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

/**
 * Renders a health-check deadline for error messages, preferring a plain
 * seconds form (e.g. "60s") over a verbose duration.
 */
function formatHealthTimeout(ms: number): string {
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
}

function exitError(code: number | null, sig: NodeJS.Signals | null): Error | undefined {
    if (code === 0) return undefined;
    if (sig !== null) return new Error(`process killed with ${sig}`);
    if (code !== null) return new Error(`process exited with code ${code}`);
    return new Error("process exited");
}

function abortReason(signal: AbortSignal): unknown {
    const reason = signal.reason;
    if (reason !== undefined && reason !== null) return reason;
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
}

function errMessage(err: unknown): string {
    if (err === undefined || err === null) return "";
    return err instanceof Error ? err.message : String(err);
}
