/**
 * Account rotation for the local API server (`enigma api`).
 *
 * When a request names no account/profile/pack and rotation is on, the server picks one of the
 * tool's accounts per request instead of always using the same login. The strategies follow what
 * multi-account routers (OmniRoute's account fallback, claude-swap) converged on:
 *   - round-robin: cycle the pool in order.
 *   - least-used:  the account with the least token use in its current 5h window.
 *   - fill-first:  stay on the first account until it hits a limit, then move to the next.
 *   - random:      uniform pick.
 * Every strategy skips an account that is cooling down after a usage limit or an auth failure,
 * and the server retries a limited request on the next account (failover). Cooldowns follow
 * OmniRoute's account-level backoff: the reset time the agent reported when there is one, else
 * 2 min doubling per repeat, capped at 30 min.
 *
 * State (cursor, cooldowns, token ledger, session bindings) is in-process and bounded: it lives
 * as long as the server and is rebuilt from nothing on restart, which is safe because a cold
 * start only loses the cursor position and the cooldowns re-learn on the first limited reply.
 * The picker is pure over its inputs so tests never touch real accounts.
 */
import type { ApiRotation } from "./config";

/** One candidate account and the facts a strategy ranks it by. */
export interface Candidate {
    name: string;
    /** Tokens used in the account's current 5h window (transcripts + what this server sent since). */
    windowTokens: number;
    /** Requests this server is running on the account right now. */
    inFlight: number;
}

/** Why an account is cooling down. */
export type CooldownReason = "limit" | "auth";

interface Cooldown { until: number; level: number; reason: CooldownReason; }

const BASE_COOLDOWN_MS = 2 * 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;
const AUTH_COOLDOWN_MS = 30 * 60_000;
const WINDOW_MS = 5 * 3600_000;
const MAX_LEDGER = 10_000;
const MAX_SESSION_BINDINGS = 1024;

// Usage-limit wording from Claude Code and the Anthropic API ("Claude AI usage limit reached|<epoch>",
// "5-hour limit reached", "You've hit your limit", rate_limit_error, HTTP 429) and from the other CLIs.
const LIMIT_RE = /usage limit|limit reached|hit your (?:usage )?limit|rate[_ -]?limit|\b429\b|out of (?:extra )?usage|quota exceeded|insufficient_quota|credit balance is too low/i;
// A login that no longer works is an account fault too: rotate away instead of failing every request.
const AUTH_RE = /please run \/login|invalid api key|oauth token (?:has )?(?:expired|been revoked)|not logged in|authentication_error|invalid x-api-key/i;

/** Classify an agent error as an account-level fault worth rotating away from, or null. */
export function classifyAccountError(message: string | undefined): CooldownReason | null {
    if (!message) return null;
    if (AUTH_RE.test(message)) return "auth";
    if (LIMIT_RE.test(message)) return "limit";
    return null;
}

/** The reset time a limit message carries ("...limit reached|1717000000"), in epoch ms, or 0. */
export function parseResetAt(message: string): number {
    const m = /\|(\d{10})(?!\d)/.exec(message);
    return m ? Number(m[1]) * 1000 : 0;
}

/**
 * Pick an account for one request. Returns null when every candidate is excluded or cooling
 * down - the caller then fails the request instead of hammering a limited login.
 */
export function pickCandidate(strategy: Exclude<ApiRotation, "off">, candidates: Candidate[], cursor: number, random: () => number = Math.random): { name: string; cursor: number; } | null {
    if (!candidates.length) return null;
    switch (strategy) {
        case "fill-first":
            return { name: candidates[0]!.name, cursor };
        case "random":
            return { name: candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!.name, cursor };
        case "least-used": {
            // Fewest tokens in the window; ties go to the account with less work in flight, then
            // pool order, so a burst before the usage numbers move still spreads across accounts.
            let best = candidates[0]!;
            for (const c of candidates.slice(1)) {
                if (c.windowTokens < best.windowTokens || (c.windowTokens === best.windowTokens && c.inFlight < best.inFlight)) best = c;
            }
            return { name: best.name, cursor };
        }
        case "round-robin":
        default: {
            const i = ((cursor % candidates.length) + candidates.length) % candidates.length;
            return { name: candidates[i]!.name, cursor: cursor + 1 };
        }
    }
}

/**
 * Order the tool's accounts by the configured pool. An empty pool means every account in the
 * tool's own order; pool names that are not accounts of this tool are dropped (a pool can list
 * accounts of several tools).
 */
export function poolOrder(accounts: string[], pool: string[]): string[] {
    if (!pool.length) return [...accounts];
    const have = new Set(accounts);
    return [...new Set(pool)].filter((n) => have.has(n));
}

/** Point-in-time view of the rotation for /health and the dashboard. */
export interface RotationSnapshot {
    strategy: ApiRotation;
    pool: string[];
    cooldowns: Array<{ tool: string; account: string; reason: CooldownReason; until: number; }>;
    inFlight: Record<string, number>;
    lastServed: Record<string, string>;
}

/** Usage of one account's current window from the transcript report, or 0 when unknown. */
export type WindowUsage = (tool: string, account: string) => { tokens: number; asOf: number; };

/** In-process rotation state for one server. */
export class AccountRotator {
    private cursors = new Map<string, number>();
    private cooldowns = new Map<string, Cooldown>();
    private inFlight = new Map<string, number>();
    private ledger: Array<{ key: string; at: number; tokens: number; }> = [];
    private lastServed = new Map<string, string>();
    private sessions = new Map<string, string>();

    constructor(
        public strategy: ApiRotation,
        public pool: string[],
        private usage: WindowUsage = () => ({ tokens: 0, asOf: 0 }),
        private random: () => number = Math.random,
    ) {}

    get enabled(): boolean { return this.strategy !== "off"; }

    /**
     * Pick an account among `accounts` (the tool's account names), skipping cooled-down and
     * `exclude`d ones. Null when nothing is left to try.
     */
    pick(tool: string, accounts: string[], exclude: ReadonlySet<string> = new Set(), now = Date.now()): string | null {
        if (this.strategy === "off") return null;
        const names = poolOrder(accounts, this.pool).filter((n) => !exclude.has(n) && !this.coolingDown(tool, n, now));
        const candidates = names.map((name) => ({ name, windowTokens: this.windowTokens(tool, name, now), inFlight: this.inFlight.get(`${tool}:${name}`) ?? 0 }));
        const out = pickCandidate(this.strategy, candidates, this.cursors.get(tool) ?? 0, this.random);
        if (!out) return null;
        this.cursors.set(tool, out.cursor);
        return out.name;
    }

    /** Mark the start of a request on an account; the returned function ends it and records its tokens. */
    begin(tool: string, account: string): (tokens: number) => void {
        const key = `${tool}:${account}`;
        this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
        this.lastServed.set(tool, account);
        let done = false;
        return (tokens: number) => {
            if (done) return;
            done = true;
            const left = (this.inFlight.get(key) ?? 1) - 1;
            if (left > 0) this.inFlight.set(key, left); else this.inFlight.delete(key);
            if (tokens > 0) this.record(key, tokens, Date.now());
        };
    }

    /** Put an account on cooldown after an account-level fault (usage limit or broken login). */
    markFault(tool: string, account: string, reason: CooldownReason, message = "", now = Date.now()): void {
        const key = `${tool}:${account}`;
        const prev = this.cooldowns.get(key);
        const level = prev && prev.until > now - MAX_COOLDOWN_MS ? prev.level + 1 : 0;
        let until: number;
        if (reason === "auth") until = now + AUTH_COOLDOWN_MS;
        else {
            const reset = parseResetAt(message);
            until = reset > now ? reset : now + Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** level);
        }
        this.cooldowns.set(key, { until, level, reason });
    }

    /** True while the account is cooling down. */
    coolingDown(tool: string, account: string, now = Date.now()): boolean {
        const c = this.cooldowns.get(`${tool}:${account}`);
        return Boolean(c && c.until > now);
    }

    /** The account a warm session was started on, so its later turns stay on the same login. */
    sessionAccount(sessionId: string): string | undefined { return this.sessions.get(sessionId); }

    bindSession(sessionId: string, account: string): void {
        this.sessions.delete(sessionId);
        this.sessions.set(sessionId, account);
        // Oldest-first eviction keeps the map bounded; an evicted session just re-picks, and the
        // session runtime still refuses to resume it under a different login.
        while (this.sessions.size > MAX_SESSION_BINDINGS) this.sessions.delete(this.sessions.keys().next().value!);
    }

    snapshot(now = Date.now()): RotationSnapshot {
        const cooldowns: RotationSnapshot["cooldowns"] = [];
        for (const [key, c] of this.cooldowns) {
            if (c.until <= now) continue;
            const i = key.indexOf(":");
            cooldowns.push({ tool: key.slice(0, i), account: key.slice(i + 1), reason: c.reason, until: c.until });
        }
        return { strategy: this.strategy, pool: [...this.pool], cooldowns, inFlight: Object.fromEntries(this.inFlight), lastServed: Object.fromEntries(this.lastServed) };
    }

    private windowTokens(tool: string, account: string, now: number): number {
        const key = `${tool}:${account}`;
        const { tokens, asOf } = this.usage(tool, account);
        // The transcript report lags; add what this server sent through the account since it was built.
        const since = Math.max(asOf, now - WINDOW_MS);
        let recent = 0;
        for (const e of this.ledger) if (e.key === key && e.at > since) recent += e.tokens;
        return tokens + recent;
    }

    private record(key: string, tokens: number, now: number): void {
        this.ledger.push({ key, at: now, tokens });
        const cutoff = now - WINDOW_MS;
        if (this.ledger.length > MAX_LEDGER || (this.ledger[0] && this.ledger[0].at < cutoff)) {
            this.ledger = this.ledger.filter((e) => e.at >= cutoff).slice(-MAX_LEDGER);
        }
    }
}
