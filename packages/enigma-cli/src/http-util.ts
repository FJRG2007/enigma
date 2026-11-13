/**
 * The two HTTP primitives every enigma server shares (`enigma api`, `enigma serve`): a capped
 * request-body reader and a JSON response writer. Node built-ins only, so they run unchanged
 * under Node and inside the Bun binary.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Thrown by readBody when the body exceeds its cap; carries a stable message callers map to 413. */
export class PayloadTooLargeError extends Error {
    constructor(limit: number) {
        super(`payload too large (limit ${limit} bytes)`);
        this.name = "PayloadTooLargeError";
    }
}

/**
 * Read a request body as UTF-8, refusing once it passes `limit` bytes (or declares more up
 * front), so a client cannot make the server buffer an unbounded upload. The stream is paused,
 * not destroyed, so the caller can still answer 413; send that answer with `connection: close`
 * and the socket goes away with it.
 */
export function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limit) { req.pause(); reject(new PayloadTooLargeError(limit)); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        let refused = false;
        req.on("data", (c: Buffer) => {
            if (refused) return;
            size += c.length;
            if (size > limit) { refused = true; chunks.length = 0; req.pause(); reject(new PayloadTooLargeError(limit)); return; }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

/** Write `body` as a JSON response with an exact content-length. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
}
