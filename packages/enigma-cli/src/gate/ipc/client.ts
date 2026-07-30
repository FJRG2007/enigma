/**
 * The gate IPC RPC client: dials the daemon, sends newline-delimited JSON-RPC 2.0
 * requests, and awaits the matching response by ID. Faithful port of
 * upstream's `internal/ipc/client.go`.
 *
 * `Client` reuses one connection for unary calls (each call carries an
 * auto-incremented ID, so responses are matched deterministically and a 30s
 * timeout bounds each one, mirroring the Go read deadline). `subscribe` opens a
 * dedicated connection, reads the initial OK response, then yields streamed event
 * frames until the run completes, the connection drops, or `cancel` is called.
 */

import * as proto from "./protocol";
import type { Socket } from "node:net";
import { dial, readLines } from "./transport";

/** Read deadline for a unary call, matching the Go client's 30s read deadline. */
const CALL_TIMEOUT_MS = 30_000;

interface Pending {
    resolve: (resp: proto.Response) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Connects to the IPC server over the platform transport for unary calls. */
export class Client {
    private readonly pending = new Map<number, Pending>();
    private closed = false;

    private constructor(private readonly socket: Socket) {
        readLines(socket, (line) => this.onLine(line));
        socket.on("close", () => this.failAll(new Error("read response: connection closed")));
        socket.on("error", (err) => this.failAll(err));
    }

    /** Dials the IPC server at the given socket path. */
    static async dial(socketPath: string): Promise<Client> {
        let socket: Socket;
        try {
            socket = await dial(socketPath);
        } catch (e) {
            throw new Error(`dial ipc: ${(e as Error).message}`);
        }
        return new Client(socket);
    }

    /** Disconnects from the server, failing any in-flight calls. */
    close(): void {
        this.closed = true;
        this.failAll(new Error("read response: connection closed"));
        this.socket.destroy();
    }

    /** Notifies the daemon a push arrived and returns the created run ID. */
    async pushReceived(params: proto.PushReceivedParams): Promise<string> {
        const raw = await this.call(proto.MethodPushReceived, proto.encodePushReceivedParams(params));
        return proto.decodePushReceivedResult(raw).runId;
    }

    /** Returns a single run by ID, or null when absent. */
    async getRun(runId: string): Promise<proto.RunInfo | null> {
        const raw = await this.call(proto.MethodGetRun, proto.encodeGetRunParams({ runId }));
        return proto.decodeGetRunResult(raw).run;
    }

    /** Returns all runs for a repo. */
    async getRuns(repoId: string): Promise<proto.RunInfo[]> {
        const raw = await this.call(proto.MethodGetRuns, proto.encodeGetRunsParams({ repoId }));
        return proto.decodeGetRunsResult(raw).runs;
    }

    /** Returns the active run for a repo (preferring `branch`), or null when none. */
    async getActiveRun(params: proto.GetActiveRunParams): Promise<proto.RunInfo | null> {
        const raw = await this.call(proto.MethodGetActiveRun, proto.encodeGetActiveRunParams(params));
        return proto.decodeGetActiveRunResult(raw).run;
    }

    /** Requests a new run for the latest gate head on a branch; returns the run ID. */
    async rerun(params: proto.RerunParams): Promise<string> {
        const raw = await this.call(proto.MethodRerun, proto.encodeRerunParams(params));
        return proto.decodeRerunResult(raw).runId;
    }

    /** Sends a user action for a step awaiting approval; returns whether accepted. */
    async respond(params: proto.RespondParams): Promise<boolean> {
        const raw = await this.call(proto.MethodRespond, proto.encodeRespondParams(params));
        return proto.decodeRespondResult(raw).ok;
    }

    /** Cancels an active pipeline run; returns whether the request was accepted. */
    async cancelRun(runId: string): Promise<boolean> {
        const raw = await this.call(proto.MethodCancelRun, proto.encodeCancelRunParams({ runId }));
        return proto.decodeCancelRunResult(raw).ok;
    }

    /** Pings the daemon and returns its reported status. */
    async health(): Promise<string> {
        const raw = await this.call(proto.MethodHealth, {});
        return proto.decodeHealthResult(raw).status;
    }

    /** Asks the daemon to shut down; returns whether shutdown was initiated. */
    async shutdown(): Promise<boolean> {
        try {
            const raw = await this.call(proto.MethodShutdown, {});
            return proto.decodeShutdownResult(raw).ok;
        } catch (err) {
            // The daemon closes the connection as it shuts down, so the socket
            // closing without a response IS the shutdown confirmation, not a failure.
            if (err instanceof Error && err.message.includes("connection closed")) return true;
            throw err;
        }
    }

    /**
     * Sends a JSON-RPC request and resolves with the wire `result` object. A
     * JSON-RPC error response rejects with an `RPCError`.
     */
    call(method: string, params: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new Error("read response: connection closed"));
                return;
            }
            const req = proto.newRequest(method, params);
            const timer = setTimeout(() => {
                if (this.pending.delete(req.id)) reject(new Error("read response: timeout"));
            }, CALL_TIMEOUT_MS);
            timer.unref?.();
            this.pending.set(req.id, {
                timer,
                reject,
                resolve: (resp) => {
                    if (resp.error) reject(new proto.RPCError(resp.error.code, resp.error.message));
                    else resolve(resp.result);
                }
            });
            this.socket.write(`${JSON.stringify(req)}\n`);
        });
    }

    private onLine(line: string): void {
        if (line.length === 0) return;
        let resp: proto.Response;
        try {
            resp = JSON.parse(line) as proto.Response;
        } catch {
            return; // ignore unparseable frames
        }
        const pending = this.pending.get(resp.id);
        if (!pending) return;
        this.pending.delete(resp.id);
        clearTimeout(pending.timer);
        pending.resolve(resp);
    }

    private failAll(err: Error): void {
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            this.pending.delete(id);
            p.reject(err);
        }
    }
}

/** A live event subscription: an async stream of events plus a cancel function. */
export interface Subscription {
    events: AsyncIterableIterator<proto.Event>;
    cancel: () => void;
}

/**
 * Opens a dedicated connection and subscribes to events for a run. Resolves once
 * the daemon acknowledges the subscription; the returned `events` stream ends
 * when the run completes, the connection drops, or `cancel` is called. A JSON-RPC
 * error on the initial response rejects.
 */
export async function subscribe(socketPath: string, params: proto.SubscribeParams): Promise<Subscription> {
    let socket: Socket;
    try {
        socket = await dial(socketPath);
    } catch (e) {
        throw new Error(`dial ipc: ${(e as Error).message}`);
    }

    const queue: proto.Event[] = [];
    let waiting: ((res: IteratorResult<proto.Event>) => void) | null = null;
    let done = false;
    let cancelled = false;

    const endStream = () => {
        done = true;
        if (waiting) {
            waiting({ value: undefined as unknown as proto.Event, done: true });
            waiting = null;
        }
    };
    const pushEvent = (e: proto.Event) => {
        if (waiting) {
            waiting({ value: e, done: false });
            waiting = null;
        } else {
            queue.push(e);
        }
    };
    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        endStream();
        socket.destroy();
    };

    const events: AsyncIterableIterator<proto.Event> = {
        [Symbol.asyncIterator]() {
            return this;
        },
        next(): Promise<IteratorResult<proto.Event>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined as unknown as proto.Event, done: true });
            return new Promise((res) => {
                waiting = res;
            });
        },
        return(): Promise<IteratorResult<proto.Event>> {
            cancel();
            return Promise.resolve({ value: undefined as unknown as proto.Event, done: true });
        }
    };

    // Send the subscribe request and await the initial response before streaming.
    await new Promise<void>((resolve, reject) => {
        let gotInitial = false;
        readLines(socket, (line) => {
            if (!gotInitial) {
                gotInitial = true;
                let resp: proto.Response;
                try {
                    resp = JSON.parse(line) as proto.Response;
                } catch (e) {
                    reject(new Error(`parse response: ${(e as Error).message}`));
                    socket.destroy();
                    return;
                }
                if (resp.error) {
                    reject(new proto.RPCError(resp.error.code, resp.error.message));
                    socket.destroy();
                    return;
                }
                resolve();
                return;
            }
            try {
                pushEvent(proto.decodeEvent(JSON.parse(line)));
            } catch {
                // Skip malformed events.
            }
        });
        socket.on("close", () => {
            if (!gotInitial) reject(new Error("read response: connection closed"));
            else endStream();
        });
        socket.on("error", (err) => {
            if (!gotInitial) reject(err);
        });
        const req = proto.newRequest(proto.MethodSubscribe, proto.encodeSubscribeParams(params));
        socket.write(`${JSON.stringify(req)}\n`);
    });

    return { events, cancel };
}
