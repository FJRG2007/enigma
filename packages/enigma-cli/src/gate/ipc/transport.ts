/**
 * Platform transport for the gate IPC endpoint: a listen/dial abstraction over a
 * filesystem socket. Faithful port of no-mistakes' `transport_unix.go` /
 * `transport_windows.go`, with one deliberate divergence on Windows.
 *
 * POSIX: a Unix domain socket at the socket path (`node:net` IPC). A leftover
 * socket file is removed before listening (mirrors the Go `os.Remove`), and the
 * socket is chmod'd to 0o600 for the private-socket intent (Go uses umask 0o077).
 *
 * Windows: a named pipe whose name is derived deterministically from the socket
 * path (`\\.\pipe\enigma-gate-<sanitized-path>`). The Go port instead used a
 * loopback TCP listener with a token file and a Win32 ACL/PID gate; that path
 * needs `golang.org/x/sys/windows` (file ACLs, OpenProcess), which has no Node
 * builtin equivalent and would break enigma's zero-dependency rule. A named pipe
 * is the idiomatic `node:net` Windows IPC primitive and keeps the same per-path
 * isolation a Unix socket gives, so it is the faithful in-spirit substitute.
 */

import { rmSync, chmodSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import type { Socket, Server as NetServer } from "node:net";

const isWindows = process.platform === "win32";

/** Maximum bytes buffered for a single line before the connection is torn down. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Derives a deterministic Windows named-pipe name from a socket path. */
function pipeName(socketPath: string): string {
    const slug = socketPath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `\\\\.\\pipe\\enigma-gate-${slug}`;
}

/** Maps a socket path to the platform endpoint address used by `node:net`. */
function endpointAddress(socketPath: string): string {
    return isWindows ? pipeName(socketPath) : socketPath;
}

/** Listens on the gate IPC endpoint for the given socket path. */
export function listen(socketPath: string): Promise<NetServer> {
    return new Promise((resolve, reject) => {
        if (!isWindows) {
            try {
                rmSync(socketPath, { force: true });
            } catch {
                // A stale socket file may be absent; ignore.
            }
        }
        const server = createServer();
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(endpointAddress(socketPath), () => {
            server.removeListener("error", onError);
            if (!isWindows) {
                try {
                    chmodSync(socketPath, 0o600);
                } catch {
                    // Best-effort private-socket permissions.
                }
            }
            resolve(server);
        });
    });
}

/** Dials the gate IPC endpoint at the given socket path. */
export function dial(socketPath: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(endpointAddress(socketPath));
        const onError = (err: Error) => reject(err);
        socket.once("error", onError);
        socket.once("connect", () => {
            socket.removeListener("error", onError);
            resolve(socket);
        });
    });
}

/**
 * Reads newline-delimited lines off a socket, invoking `onLine` per line (without
 * the trailing newline). A line that exceeds `MAX_LINE_BYTES` without a newline
 * tears the connection down via `onError`, mirroring Go's 1MB scanner cap.
 */
export function readLines(socket: Socket, onLine: (line: string) => void, onError?: (err: Error) => void): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE_BYTES && buffer.indexOf("\n") < 0) {
            buffer = "";
            onError?.(new Error("line exceeds 1MB limit"));
            socket.destroy();
            return;
        }
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            onLine(line);
        }
    });
}
