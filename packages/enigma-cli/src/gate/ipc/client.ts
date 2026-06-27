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

import type { Socket } from "node:net";
import { dial, readLines } from "./transport";
import {
    Event,
    RPCError,
    RunInfo,
    Request,
    Response,
    newRequest,
    decodeEvent,
    RerunParams,
    MethodRerun,
    MethodHealth,
    RespondParams,
    MethodGetRun,
    MethodRespond,
    MethodGetRuns,
    MethodShutdown,
    decodeRunInfo,
    MethodSubscribe,
    MethodCancelRun,
    SubscribeParams,
    encodeRerunParams,
    decodeRerunResult,
    decodeHealthResult,
    encodeGetRunParams,
    encodeRespondParams,
    decodeGetRunResult,
    MethodGetActiveRun,
    encodeGetRunsParams,
    PushReceivedParams,
    MethodPushReceived,
    decodeRespondResult,
    decodeGetRunsResult,
    decodeShutdownResult,
    encodeSubscribeParams,
    encodeCancelRunParams,
    decodeCancelRunResult,
    GetActiveRunParams,
    encodeGetActiveRunParams,
    decodeGetActiveRunResult,
    encodePushReceivedParams,
    decodePushReceivedResult
} from "./protocol";

/** Read deadline for a unary call, matching the Go client's 30s read deadline. */
const CALL_TIMEOUT_MS = 30_000;

interface Pending {
    resolve: (resp: Response) => void;
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
    async pushReceived(params: PushReceivedParams): Promise<string> {
        const raw = await this.call(MethodPushReceived, encodePushReceivedParams(params));
        return decodePushReceivedResult(raw).runId;
    }

    /** Returns a single run by ID, or null when absent. */
    async getRun(runId: string): Promise<RunInfo | null> {
        const raw = await this.call(MethodGetRun, encodeGetRunParams({ runId }));
        return decodeGetRunResult(raw).run;
    }

    /** Returns all runs for a repo. */
    async getRuns(repoId: string): Promise<RunInfo[]> {
        const raw = await this.call(MethodGetRuns, encodeGetRunsParams({ repoId }));
        return decodeGetRunsResult(raw).runs;
    }

    /** Returns the active run for a repo (preferring `branch`), or null when none. */
    async getActiveRun(params: GetActiveRunParams): Promise<RunInfo | null> {
        const raw = await this.call(MethodGetActiveRun, encodeGetActiveRunParams(params));
        return decodeGetActiveRunResult(raw).run;
    }

    /** Requests a new run for the latest gate head on a branch; returns the run ID. */
    async rerun(params: RerunParams): Promise<string> {
        const raw = await this.call(MethodRerun, encodeRerunParams(params));
        return decodeRerunResult(raw).runId;
    }

    /** Sends a user action for a step awaiting approval; returns whether accepted. */
    async respond(params: RespondParams): Promise<boolean> {
        const raw = await this.call(MethodRespond, encodeRespondParams(params));
        return decodeRespondResult(raw).ok;
    }

    /** Cancels an active pipeline run; returns whether the request was accepted. */
    async cancelRun(runId: string): Promise<boolean> {
        const raw = await this.call(MethodCancelRun, encodeCancelRunParams({ runId }));
        return decodeCancelRunResult(raw).ok;
    }

    /** Pings the daemon and returns its reported status. */
    async health(): Promise<string> {
        const raw = await this.call(MethodHealth, {});
        return decodeHealthResult(raw).status;
    }

    /** Asks the daemon to shut down; returns whether shutdown was initiated. */
    async shutdown(): Promise<boolean> {
        try {
            const raw = await this.call(MethodShutdown, {});
            return decodeShutdownResult(raw).ok;
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
            const req = newRequest(method, params);
            const timer = setTimeout(() => {
                if (this.pending.delete(req.id)) reject(new Error("read response: timeout"));
            }, CALL_TIMEOUT_MS);
            timer.unref?.();
            this.pending.set(req.id, {
                timer,
                reject,
                resolve: (resp) => {
                    if (resp.error) reject(new RPCError(resp.error.code, resp.error.message));
                    else resolve(resp.result);
                }
            });
            this.socket.write(`${JSON.stringify(req)}\n`);
        });
    }

    private onLine(line: string): void {
        if (line.length === 0) return;
        let resp: Response;
        try {
            resp = JSON.parse(line) as Response;
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
    events: AsyncIterableIterator<Event>;
    cancel: () => void;
}

/**
 * Opens a dedicated connection and subscribes to events for a run. Resolves once
 * the daemon acknowledges the subscription; the returned `events` stream ends
 * when the run completes, the connection drops, or `cancel` is called. A JSON-RPC
 * error on the initial response rejects.
 */
export async function subscribe(socketPath: string, params: SubscribeParams): Promise<Subscription> {
    let socket: Socket;
    try {
        socket = await dial(socketPath);
    } catch (e) {
        throw new Error(`dial ipc: ${(e as Error).message}`);
    }

    const queue: Event[] = [];
    let waiting: ((res: IteratorResult<Event>) => void) | null = null;
    let done = false;
    let cancelled = false;

    const endStream = () => {
        done = true;
        if (waiting) {
            waiting({ value: undefined as unknown as Event, done: true });
            waiting = null;
        }
    };
    const pushEvent = (e: Event) => {
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

    const events: AsyncIterableIterator<Event> = {
        [Symbol.asyncIterator]() {
            return this;
        },
        next(): Promise<IteratorResult<Event>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined as unknown as Event, done: true });
            return new Promise((res) => {
                waiting = res;
            });
        },
        return(): Promise<IteratorResult<Event>> {
            cancel();
            return Promise.resolve({ value: undefined as unknown as Event, done: true });
        }
    };

    // Send the subscribe request and await the initial response before streaming.
    await new Promise<void>((resolve, reject) => {
        let gotInitial = false;
        readLines(socket, (line) => {
            if (!gotInitial) {
                gotInitial = true;
                let resp: Response;
                try {
                    resp = JSON.parse(line) as Response;
                } catch (e) {
                    reject(new Error(`parse response: ${(e as Error).message}`));
                    socket.destroy();
                    return;
                }
                if (resp.error) {
                    reject(new RPCError(resp.error.code, resp.error.message));
                    socket.destroy();
                    return;
                }
                resolve();
                return;
            }
            try {
                pushEvent(decodeEvent(JSON.parse(line)));
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
        const req = newRequest(MethodSubscribe, encodeSubscribeParams(params));
        socket.write(`${JSON.stringify(req)}\n`);
    });

    return { events, cancel };
}
