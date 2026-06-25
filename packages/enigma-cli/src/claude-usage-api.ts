/**
 * Active usage probe for Claude Code. The dashboard's usage windows show the REAL %/reset
 * Anthropic reports (the same numbers Claude Code's own UI shows), but the measuring proxy
 * only captures those from genuine traffic - so they stay blank until you happen to launch
 * `enigma claude` with the proxy on. This module fills that gap.
 *
 * How: using the local Claude Code OAuth token, it sends ONE minimal `/v1/messages` request
 * to api.anthropic.com and reads the `anthropic-ratelimit-unified-*` response headers. The
 * dedicated `/api/oauth/usage` endpoint is disabled for CLI OAuth tokens, so a tiny probe is
 * how Claude's own UI and community trackers obtain the windows. The captured headers are
 * written to the SAME limits.json the proxy uses (recordLimits), so computeWindows overlays
 * them with no extra wiring - the bars show the live % without a manual plan limit.
 *
 * Consent + safety:
 *  - Opt-in (usageApi, default off): it makes a network call with the user's OAuth token and
 *    consumes a tiny amount of quota (one 1-token message), so it stays an explicit choice.
 *  - Read-only on credentials: it reads ~/.claude/.credentials.json but NEVER writes it and
 *    never refreshes/rotates the token (that risks corrupting Claude Code's own auth). An
 *    expired token simply means no probe until the next `claude` run refreshes it.
 *  - The token is sent ONLY to api.anthropic.com (its rightful audience) and is never logged,
 *    stored, or written to any enigma file.
 *  - Throttled to PROBE_INTERVAL_MS via an on-disk stamp shared across processes, with the
 *    `claude-code/<ver>` User-Agent so it never hits the aggressively rate-limited bucket.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readConfig } from "./config";
import { recordLimits } from "./proxy";

const UPSTREAM_HOST = "api.anthropic.com";
/** Anthropic's aggressively rate-limited bucket is avoided only with a claude-code/* UA. */
const PROBE_UA = "claude-code/2.1.5";
/** Minimum gap between probes; the headers move slowly and the call costs quota. */
const PROBE_INTERVAL_MS = 180_000;
/** Cheapest model: the body is throwaway, we only want the rate-limit response headers. */
const PROBE_MODEL = "claude-haiku-4-5-20251001";

/** One Claude config dir that may hold OAuth credentials (default + managed accounts). */
interface CredSource { account: string; dir: string; }

/**
 * Every Claude config dir to look for `.credentials.json`: the default dir (CLAUDE_CONFIG_DIR
 * or ~/.claude) plus each enigma-managed account under ~/.enigma/claude/<name>.
 */
function credSources(): CredSource[] {
    const out: CredSource[] = [{ account: "default", dir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") }];
    const base = join(homedir(), ".enigma", "claude");
    try {
        for (const e of readdirSync(base, { withFileTypes: true })) {
            if (e.isDirectory()) out.push({ account: e.name, dir: join(base, e.name) });
        }
    } catch { /* no managed accounts */ }
    return out;
}

/** A usable OAuth access token read from a Claude config dir. */
export interface OAuthToken { token: string; expiresAt: number; account: string; }

/**
 * The first non-expired Claude Code OAuth access token on disk (default account preferred).
 * expiresAt is epoch ms; a token within 60s of expiry is treated as already gone. Returns
 * null when no credentials exist or all are expired (read-only; never refreshes).
 */
export function readOAuthToken(now = Date.now()): OAuthToken | null {
    for (const src of credSources()) {
        let raw: string;
        try { raw = readFileSync(join(src.dir, ".credentials.json"), "utf8"); } catch { continue; }
        let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
        try { oauth = (JSON.parse(raw) as { claudeAiOauth?: typeof oauth }).claudeAiOauth; } catch { continue; }
        const token = oauth && typeof oauth.accessToken === "string" ? oauth.accessToken : "";
        if (!token) continue;
        const expiresAt = oauth && typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
        if (expiresAt && expiresAt < now + 60_000) continue; // expired or about to
        return { token, expiresAt, account: src.account };
    }
    return null;
}

function probeDir(): string {
    return process.env.ENIGMA_PROXY_DIR || join(homedir(), ".enigma", "proxy");
}

function stampPath(): string {
    return join(probeDir(), "probe.json");
}

/** Epoch ms of the last probe attempt (success or failure), 0 if never. */
function lastProbeAt(): number {
    try { return Number((JSON.parse(readFileSync(stampPath(), "utf8")) as { at?: number }).at) || 0; }
    catch { return 0; }
}

/** Stamp a probe attempt up-front so an offline/expired-token machine is throttled like a success. */
function stampProbe(at: number): void {
    try {
        const dir = probeDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(stampPath(), JSON.stringify({ at }));
    } catch { /* best-effort */ }
}

let probing = false;

/**
 * Send one minimal /v1/messages request and persist the rate-limit windows it returns.
 * Resolves true when headers were captured. Best-effort: any network/HTTP error resolves
 * false and is swallowed (the dashboard keeps its previous/estimated windows).
 */
export function probeUsageLimits(tok: OAuthToken): Promise<boolean> {
    const body = JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
        const req = httpsRequest(
            {
                host: UPSTREAM_HOST, port: 443, method: "POST", path: "/v1/messages",
                headers: {
                    "authorization": `Bearer ${tok.token}`,
                    "anthropic-beta": "oauth-2025-04-20",
                    "anthropic-version": "2023-06-01",
                    "user-agent": PROBE_UA,
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                },
            },
            (res) => {
                // The rate-limit windows ride the response headers regardless of the body; we
                // do not need a 200, just the headers. Drain and discard the body.
                try { recordLimits(res.headers); } catch { /* best-effort */ }
                res.on("data", () => { /* discard */ });
                res.on("end", () => done(true));
                res.on("error", () => done(false));
            },
        );
        req.on("error", () => done(false));
        req.setTimeout(8000, () => { try { req.destroy(); } catch { /* */ } done(false); });
        req.end(body);
    });
}

/**
 * Fire a throttled probe in the background when the feature is enabled and a token exists.
 * Returns immediately; callers (e.g. buildUsage) invoke it without awaiting so the usage
 * report is never blocked. Gated by usageApi (+usageStats, since the windows only surface
 * when usage reading is on). No-op when throttled, disabled, already running, or no token.
 */
export function maybeProbeUsage(now = Date.now()): void {
    if (probing) return;
    const cfg = readConfig().config;
    if (!cfg.usageApi || !cfg.usageStats) return;
    if (now - lastProbeAt() < PROBE_INTERVAL_MS) return;
    const tok = readOAuthToken(now);
    if (!tok) return;
    probing = true;
    stampProbe(now); // stamp before the call so a failure still throttles the next attempt
    probeUsageLimits(tok).finally(() => { probing = false; });
}
