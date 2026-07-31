/**
 * Claude Code session (OAuth credential) reuse across config directories.
 *
 * Claude Code stores its login as a `.credentials.json` file inside its config dir (the dir
 * `CLAUDE_CONFIG_DIR` points at). When enigma manages several config dirs for the SAME
 * Anthropic account - a managed account dir and an isolated pack context, say - each dir holds
 * its own copy of the OAuth credential. Anthropic ROTATES the refresh token on every refresh
 * and invalidates the previous one, so two independent copies of one login undercut each other:
 * whichever refreshes last keeps working, the other's refresh token goes stale and Claude Code
 * eventually blanks that file (a silent logout). That is the "ping-pong" that leaves
 * `enigma claude` signed out while `enigma helio` (a pack context) still works, or vice versa.
 *
 * The fix is to REUSE one session instead of duplicating it. The key realisation is that the
 * problem is the refresh token, not the access token: as long as a config dir holds a valid
 * refresh token, Claude Code refreshes the access token itself. So "moving a session" is just
 * copying the `.credentials.json` (which carries the refresh token) plus aligning the identity
 * in `.claude.json` so the target treats it as the same signed-in install - no network call,
 * no re-login. This module owns those file operations; higher layers decide when to run them
 * (a pack keeps its context and account in lockstep; the dashboard/CLI expose a manual transfer).
 *
 * Leaf module: Node builtins only, imports nothing from enigma, never logs a token value.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** The OAuth payload Claude Code stores under `claudeAiOauth` in `.credentials.json`. */
interface ClaudeOAuth {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
}

/**
 * Usability of a config dir's Claude session:
 *  - `ok`          - a valid access token (present and not past expiry).
 *  - `refreshable` - the access token is expired/absent but a refresh token is present, so
 *                    Claude Code will mint a new access token itself. Still a usable login.
 *  - `expired`     - an access token past expiry with NO refresh token: unusable, dead.
 *  - `empty`       - the file exists but carries no tokens (a blanked / logged-out file).
 *  - `absent`      - no `.credentials.json` at all.
 */
export type SessionState = "ok" | "refreshable" | "expired" | "empty" | "absent";

/** Path of a config dir's Claude credentials file. */
export function credentialsPath(dir: string): string {
    return join(dir, ".credentials.json");
}

/** Path of a config dir's Claude global config (identity / onboarding). */
export function claudeConfigPath(dir: string): string {
    return join(dir, ".claude.json");
}

/** Read and parse the OAuth payload of a config dir, or null when absent/unreadable. */
function readOAuth(dir: string): ClaudeOAuth | null {
    try {
        const parsed = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as { claudeAiOauth?: ClaudeOAuth; };
        return parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object" ? parsed.claudeAiOauth : null;
    } catch {
        return null;
    }
}

/** Classify a config dir's Claude session (see SessionState). Never throws. */
export function sessionState(dir: string, now: number = Date.now()): SessionState {
    if (!existsSync(credentialsPath(dir))) return "absent";
    const oauth = readOAuth(dir);
    if (!oauth || (!oauth.accessToken && !oauth.refreshToken)) return "empty";
    const hasAccess = Boolean(oauth.accessToken);
    const hasRefresh = Boolean(oauth.refreshToken);
    const past = typeof oauth.expiresAt === "number" && oauth.expiresAt > 0 && oauth.expiresAt <= now;
    if (hasRefresh) return hasAccess && !past ? "ok" : "refreshable";
    // No refresh token: usable only while the access token is still valid.
    return hasAccess && !past ? "ok" : "expired";
}

/** Whether a config dir holds a session that can be launched or transferred (ok | refreshable). */
export function isUsableSession(state: SessionState): boolean {
    return state === "ok" || state === "refreshable";
}

/**
 * A comparable freshness score for a config dir's session, higher = keep. A dir with a refresh
 * token always beats one without (it survives access-token expiry), then later expiry wins. An
 * unusable dir scores -Infinity so it never displaces a usable one.
 */
function freshnessScore(dir: string): number {
    const oauth = readOAuth(dir);
    if (!oauth || (!oauth.accessToken && !oauth.refreshToken)) return -Infinity;
    const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
    // Bias so any refresh-token dir outranks any refresh-less one regardless of expiry.
    return (oauth.refreshToken ? 1e15 : 0) + expiresAt;
}

/** Email of the account signed into a config dir (from `.claude.json` oauthAccount), or undefined. */
export function sessionEmail(dir: string): string | undefined {
    try {
        const cfg = JSON.parse(readFileSync(claudeConfigPath(dir), "utf8")) as { oauthAccount?: { emailAddress?: string; }; };
        const email = cfg.oauthAccount?.emailAddress;
        return typeof email === "string" ? email : undefined;
    } catch {
        return undefined;
    }
}

/** Atomically write `content` to `file` (temp + rename), creating the parent dir. */
function atomicWrite(file: string, content: string): void {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    try {
        writeFileSync(tmp, content);
        renameSync(tmp, file);
    } catch (err) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* leftover temp is harmless */ }
        throw err;
    }
}

/**
 * Bring `toDir`'s identity in line with `fromDir` so Claude Code treats the copied credentials as
 * the same signed-in install. Copies only the account-identity keys Claude Code checks before
 * deciding to run onboarding/login (`oauthAccount`, `hasCompletedOnboarding`, `userID`), preserving
 * every other key in `toDir` (projects, mcpServers, settings). No-op when `fromDir` has no
 * oauthAccount, or when `toDir` already matches the same account and is onboarded.
 */
function alignIdentity(fromDir: string, toDir: string): void {
    let from: Record<string, unknown>;
    try { from = JSON.parse(readFileSync(claudeConfigPath(fromDir), "utf8")) as Record<string, unknown>; }
    catch { return; }
    const oauthAccount = from.oauthAccount;
    if (!oauthAccount || typeof oauthAccount !== "object") return;

    const toFile = claudeConfigPath(toDir);
    let to: Record<string, unknown> = {};
    try { if (existsSync(toFile)) to = JSON.parse(readFileSync(toFile, "utf8")) as Record<string, unknown>; }
    catch { to = {}; }

    const sameAccount = JSON.stringify(to.oauthAccount) === JSON.stringify(oauthAccount);
    if (sameAccount && to.hasCompletedOnboarding === true) return; // already aligned

    to.oauthAccount = oauthAccount;
    to.hasCompletedOnboarding = from.hasCompletedOnboarding === true ? true : (to.hasCompletedOnboarding ?? true);
    if (from.userID !== undefined) to.userID = from.userID;
    atomicWrite(toFile, `${JSON.stringify(to, null, 2)}\n`);
}

/** Outcome of a session transfer. `state` is the target's state afterwards. */
export interface TransferResult { ok: boolean; state: SessionState; error?: string; }

/**
 * Move (reuse) a Claude session from `fromDir` into `toDir` WITHOUT a re-login: copy the
 * `.credentials.json` (which carries the refresh token Claude Code needs) and align `toDir`'s
 * identity. Refuses when `fromDir` has no usable session, or when source and target are the same
 * dir. Writes only `toDir`; `fromDir` is left untouched (both dirs then hold the same login -
 * higher layers keep them in lockstep so they don't diverge again).
 */
export function transferSession(fromDir: string, toDir: string, now: number = Date.now()): TransferResult {
    if (fromDir === toDir) return { ok: false, state: sessionState(toDir, now), error: "source and target are the same account" };
    const fromState = sessionState(fromDir, now);
    if (!isUsableSession(fromState)) {
        return { ok: false, state: sessionState(toDir, now), error: `the source has no usable session (${fromState})` };
    }
    try {
        const creds = readFileSync(credentialsPath(fromDir), "utf8");
        atomicWrite(credentialsPath(toDir), creds);
        alignIdentity(fromDir, toDir);
        return { ok: true, state: sessionState(toDir, now) };
    } catch (err) {
        return { ok: false, state: sessionState(toDir, now), error: (err as Error).message };
    }
}

/**
 * Copy the session from `fromDir` into `toDir` only when it is strictly BETTER - `fromDir` is
 * usable and `toDir` is either unusable or holds an older token. This is the lockstep primitive:
 * seeding a fresh account token into a pack context on launch, and propagating the context's
 * refreshed token back to the account on exit, always converge on the freshest single session
 * without ever overwriting a newer token with an older one. Returns whether it wrote. Best-effort.
 */
export function copyIfFresher(fromDir: string, toDir: string, now: number = Date.now()): boolean {
    if (fromDir === toDir) return false;
    if (!isUsableSession(sessionState(fromDir, now))) return false;
    if (freshnessScore(fromDir) <= freshnessScore(toDir)) return false;
    return transferSession(fromDir, toDir, now).ok;
}
