/**
 * `enigma serve --http`: a headless JSON API over enigma's tools (recall, code graph, compression,
 * stats) for a host that has no CLI home - a chat backend calling from its own server.
 *
 * Contract:
 *   - Every /v1 route but /v1/health needs `Authorization: Bearer <token>`, where the token is read
 *     from --token-file (re-read when the file changes, so rotation needs no restart).
 *   - Every tool route needs `X-Enigma-Tenant: <id>`; its data lives under
 *     <data-dir>/tenants/<id>/ and no request can reach another tenant's.
 *   - Bodies are capped (--max-body), lists are paginated and capped, rendered text is capped.
 *   - Errors are `{ "error": { "code", "message" } }` with a stable code.
 *
 * Scaling: requests are handled one at a time per process (the stores are synchronous). Several
 * replicas may serve reads against shared storage, but recall (SQLite in WAL mode) and the code
 * graph index are single-writer PER TENANT: route each tenant to one replica (sticky by tenant id),
 * and never put the data dir on a network filesystem SQLite cannot lock (NFS, SMB).
 */

import { resolve } from "node:path";
import { parseBody } from "./schema";
import { recallAvailable } from "../recall/db";
import { readFileSync, statSync } from "node:fs";
import { bearerOf, tokenMatches } from "../dashboard-token";
import { tenantDir, tenantIdError, withTenant } from "./tenant";
import { ROUTES, ServeError, type RouteContext } from "./routes";
import { PayloadTooLargeError, readBody, sendJson } from "../http-util";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ServeOptions {
    dataDir: string;
    tokenFile: string;
    host: string;
    port: number;
    /** Root of per-tenant code workspaces (`<root>/<tenant>/...`); null disables indexing. */
    workspaceRoot: string | null;
    /** Largest request body, in bytes. */
    maxBody: number;
    /** Largest rendered text in a response, in characters. */
    maxText: number;
    version: string;
    /** Per-request access log line (no bodies, no tokens); off in tests. */
    log?: (line: string) => void;
}

export const SERVE_DEFAULTS = { host: "127.0.0.1", port: 24290, maxBody: 1024 * 1024, maxText: 256 * 1024 } as const;

/** Shortest token accepted: anything weaker is guessable over the network. */
const MIN_TOKEN_LENGTH = 32;

/**
 * Read the bearer token from its file, refusing an empty or short one. The file holds one line;
 * surrounding whitespace (the trailing newline every editor adds) is not part of the token.
 */
export function readTokenFile(path: string): string {
    const token = readFileSync(path, "utf8").trim();
    if (!token) throw new Error(`token file ${path} is empty`);
    if (/\s/.test(token)) throw new Error(`token file ${path} must hold one token on one line`);
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`token in ${path} is shorter than ${MIN_TOKEN_LENGTH} characters`);
    return token;
}

/** The token, re-read only when the file's mtime or size moved. */
function tokenSource(path: string): () => string {
    let stamp = "";
    let token = readTokenFile(path);
    return () => {
        try {
            const st = statSync(path);
            const now = `${st.mtimeMs}:${st.size}`;
            if (now !== stamp) { token = readTokenFile(path); stamp = now; }
        } catch { /* keep the last good token; a rotation mid-write must not lock everyone out */ }
        return token;
    };
}

const SECURITY_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function fail(res: ServerResponse, status: number, code: string, message: string): void {
    sendJson(res, status, { error: { code, message } }, SECURITY_HEADERS);
}

/** Build the request handler (exported for tests, which drive it without a socket). */
export function createServeHandler(options: ServeOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    const token = tokenSource(options.tokenFile);
    const workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : null;

    return async (req, res) => {
        const started = Date.now();
        const path = (req.url || "/").split("?")[0]!;
        const method = req.method || "GET";
        let tenant = "-";
        res.on("finish", () => options.log?.(`${method} ${path} ${res.statusCode} ${Date.now() - started}ms tenant=${tenant}`));
        try {
            if (path === "/v1/health" || path === "/health") {
                if (method !== "GET") return fail(res, 405, "method_not_allowed", "use GET");
                return sendJson(res, 200, { status: "ok", service: "enigma-serve", version: options.version, recall: recallAvailable() }, SECURITY_HEADERS);
            }
            if (!tokenMatches(token(), bearerOf(req.headers.authorization))) {
                return fail(res, 401, "unauthorized", "missing or wrong bearer token");
            }
            const route = ROUTES[path];
            if (!route) return fail(res, 404, "not_found", `no route ${path}`);
            if (method !== route.method) return fail(res, 405, "method_not_allowed", `use ${route.method}`);
            const tenantHeader = req.headers["x-enigma-tenant"];
            const tenantId = Array.isArray(tenantHeader) ? undefined : tenantHeader;
            const tenantError = tenantIdError(tenantId);
            if (tenantError) return fail(res, 400, tenantId ? "invalid_tenant" : "missing_tenant", tenantError);
            tenant = tenantId!;

            let body: Record<string, unknown> = {};
            if (route.method === "POST") {
                const type = (req.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
                if (type !== "application/json") return fail(res, 415, "unsupported_media_type", "send Content-Type: application/json");
                const raw = await readBody(req, options.maxBody);
                let json: unknown;
                try { json = raw ? JSON.parse(raw) : {}; } catch { return fail(res, 400, "invalid_json", "the body is not valid JSON"); }
                const parsed = parseBody(route.schema ?? {}, json);
                if (!parsed.ok) return fail(res, 400, "invalid_body", parsed.message);
                body = parsed.value;
            }

            const dir = tenantDir(options.dataDir, tenant);
            const ctx: RouteContext = { tenant, workspaceRoot, maxText: options.maxText, dir };
            const result = route.runAsync ? await route.runAsync(body, ctx) : withTenant(dir, () => route.run(body, ctx));
            return sendJson(res, 200, result ?? null, SECURITY_HEADERS);
        } catch (err) {
            if (err instanceof ServeError) return fail(res, err.status, err.code, err.message);
            if (err instanceof PayloadTooLargeError) {
                // Close the connection with the answer: the rest of the upload is never read.
                return sendJson(res, 413, { error: { code: "payload_too_large", message: err.message } }, { ...SECURITY_HEADERS, connection: "close" });
            }
            // An unexpected failure is logged here and reported without internals.
            options.log?.(`error ${method} ${path}: ${(err as Error).stack || err}`);
            return fail(res, 500, "internal", "the request failed on the server");
        }
    };
}

/** Start listening. Resolves once bound; the returned server closes on close(). */
export function startServeServer(options: ServeOptions): Promise<Server> {
    const handler = createServeHandler(options);
    const server = createServer((req, res) => { void handler(req, res); });
    server.requestTimeout = 120_000;
    server.headersTimeout = 30_000;
    return new Promise((resolveStart, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => { server.off("error", reject); resolveStart(server); });
    });
}
