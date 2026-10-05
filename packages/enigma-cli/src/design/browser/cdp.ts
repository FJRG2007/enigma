/**
 * A minimal Chrome DevTools Protocol client over the runtime's built-in WebSocket:
 * request/response by id, events by method, and flattened target sessions (one socket,
 * many tabs, each command tagged with its `sessionId`).
 */

const COMMAND_TIMEOUT_MS = 60_000;

type Listener = (params: Record<string, unknown>) => void;

interface Pending {
    resolve: (value: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class CdpConnection {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Map<string, Set<Listener>>();
    private closed: Error | null = null;

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener("message", (event) => this.onMessage(String((event as MessageEvent).data)));
        socket.addEventListener("close", () => this.fail(new Error("browser connection closed")));
        socket.addEventListener("error", () => this.fail(new Error("browser connection failed")));
    }

    static connect(endpoint: string): Promise<CdpConnection> {
        if (typeof WebSocket !== "function") return Promise.reject(new Error("this runtime has no WebSocket; browser features need Node 22+ or the enigma binary"));
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(endpoint);
            socket.addEventListener("open", () => resolve(new CdpConnection(socket)), { once: true });
            socket.addEventListener("error", () => reject(new Error(`cannot connect to ${endpoint}`)), { once: true });
        });
    }

    private onMessage(raw: string): void {
        let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string; }; sessionId?: string; };
        try { msg = JSON.parse(raw); } catch { return; }
        if (typeof msg.id === "number") {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
            else p.resolve(msg.result ?? {});
            return;
        }
        if (msg.method) {
            for (const key of [`${msg.sessionId ?? ""}:${msg.method}`, `*:${msg.method}`]) {
                for (const listener of this.listeners.get(key) ?? []) listener(msg.params ?? {});
            }
        }
    }

    private fail(err: Error): void {
        if (this.closed) return;
        this.closed = err;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
    }

    send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
        if (this.closed) return Promise.reject(this.closed);
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }

    /** Subscribe to `method` events of one session (or of all, with `"*"`); returns the unsubscribe. */
    on(sessionId: string, method: string, listener: Listener): () => void {
        const key = `${sessionId}:${method}`;
        const set = this.listeners.get(key) ?? new Set();
        set.add(listener);
        this.listeners.set(key, set);
        return () => set.delete(listener);
    }

    /** Resolve on the next `method` event of the session, or reject after `timeoutMs`. */
    waitFor(sessionId: string, method: string, timeoutMs: number): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const off = this.on(sessionId, method, (params) => { clearTimeout(timer); off(); resolve(params); });
            const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
        });
    }

    close(): void {
        this.fail(new Error("browser connection closed"));
        try { this.socket.close(); } catch { /* already closed */ }
    }
}
