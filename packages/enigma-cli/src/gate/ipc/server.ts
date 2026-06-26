/**
 * The gate IPC RPC server: accepts connections, frames newline-delimited JSON-RPC
 * 2.0 requests, and dispatches by method to injected handlers. Faithful port of
 * no-mistakes' `internal/ipc/server.go`, following `mcp.ts`'s pure-handler /
 * stateful-loop split.
 *
 * Wire framing (matches `client.go`/`server.go`): one JSON object per line on the
 * connection. A `subscribe` stream sends an initial `{ ok: true }` response, then
 * streams newline-delimited event frames over the same connection until the
 * handler returns, after which the connection closes.
 */

import { listen, readLines } from "./transport";
import type { Socket, Server as NetServer } from "node:net";
import {
    Event,
    Request,
    Response,
    ErrInternal,
    newResponse,
    encodeEvent,
    ErrParseError,
    ErrMethodNotFound,
    newErrorResponse
} from "./protocol";

/** Processes a JSON-RPC request and returns a result, or throws on failure. */
export type HandlerFunc = (params: unknown) => unknown | Promise<unknown>;

/**
 * Takes over a connection for streaming. `send` writes one event frame. The
 * function should block until streaming is complete and return (or throw) when
 * the client disconnects.
 */
export type StreamHandlerFunc = (params: unknown, send: (event: Event) => void) => Promise<void>;

/**
 * Dispatches a single non-stream request to its handler. Pure aside from invoking
 * the handler: unknown method -> method-not-found, a thrown handler -> internal
 * error, otherwise a success response. Mirrors `server.go`'s `dispatch`.
 */
export async function dispatchRequest(req: Request, handlers: Map<string, HandlerFunc>): Promise<Response> {
    const handler = handlers.get(req.method);
    if (!handler) return newErrorResponse(req.id, ErrMethodNotFound, `method not found: ${req.method}`);
    try {
        const result = await handler(req.params);
        return newResponse(req.id, result);
    } catch (e) {
        return newErrorResponse(req.id, ErrInternal, (e as Error).message);
    }
}

/** Listens on an IPC endpoint and dispatches JSON-RPC requests. */
export class Server {
    private readonly handlers = new Map<string, HandlerFunc>();
    private readonly streamHandlers = new Map<string, StreamHandlerFunc>();
    private readonly conns = new Set<Socket>();
    private listener: NetServer | null = null;
    private closed = false;
    private resolveServe: (() => void) | null = null;

    /** Registers a handler for a JSON-RPC method. */
    handle(method: string, fn: HandlerFunc): void {
        this.handlers.set(method, fn);
    }

    /** Registers a streaming handler for a JSON-RPC method. */
    handleStream(method: string, fn: StreamHandlerFunc): void {
        this.streamHandlers.set(method, fn);
    }

    /** Starts listening on the given socket path. Resolves when the server closes. */
    async serve(socketPath: string): Promise<void> {
        const ln = await listen(socketPath);
        this.listener = ln;
        ln.on("connection", (conn: Socket) => this.handleConn(conn));
        return new Promise((resolve) => {
            this.resolveServe = resolve;
            ln.on("close", () => resolve());
            if (this.closed) ln.close();
        });
    }

    /** Gracefully shuts down the server and all live connections. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const c of this.conns) c.destroy();
        this.listener?.close();
        this.resolveServe?.();
    }

    /**
     * Closes the underlying listener without signaling shutdown. New connections
     * stop being accepted while the server's `serve` promise still resolves.
     */
    closeListener(): void {
        this.listener?.close();
    }

    private handleConn(conn: Socket): void {
        this.conns.add(conn);
        let streaming = false;
        let chain: Promise<void> = Promise.resolve();
        const write = (obj: unknown) => {
            if (!conn.destroyed) conn.write(`${JSON.stringify(obj)}\n`);
        };
        conn.on("close", () => this.conns.delete(conn));
        conn.on("error", () => {
            // The connection loop ends on close; nothing to do.
        });
        readLines(conn, (line) => {
            if (streaming) return; // a stream handler owns the connection
            chain = chain.then(() => this.processLine(conn, line, write, () => {
                streaming = true;
            }));
        });
    }

    private async processLine(conn: Socket, line: string, write: (obj: unknown) => void, markStreaming: () => void): Promise<void> {
        if (line.length === 0) return;

        let req: Request;
        try {
            req = JSON.parse(line) as Request;
        } catch {
            write(newErrorResponse(0, ErrParseError, "invalid json"));
            return;
        }

        const streamHandler = this.streamHandlers.get(req.method);
        if (streamHandler) {
            markStreaming();
            // Send the initial OK response, then hand the connection to the stream.
            write(newResponse(req.id, { ok: true }));
            const send = (event: Event) => write(encodeEvent(event));
            try {
                await streamHandler(req.params, send);
            } catch {
                // Stream handler ended (client disconnected or completed).
            }
            conn.end(); // connection done after streaming
            return;
        }

        write(await dispatchRequest(req, this.handlers));
    }
}
