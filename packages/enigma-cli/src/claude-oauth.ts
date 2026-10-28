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
 * This module also owns detecting an Anthropic Console (API billing) sign-in: Claude Code keeps
 * that login OUTSIDE any `CLAUDE_CONFIG_DIR`, in a machine-wide profile store, and falls back to
 * it for any config dir with no claude.ai login of its own - see `consoleLogin`. That fallback
 * ran a signed-out account as whoever held the Console login, so a managed account gets its own
 * store instead (`consoleStoreDir`, migrated by `seedConsoleStore`).
 *
 * Leaf module: Node builtins only, imports nothing from enigma, never logs a token value.
 */

import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
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

/** Subscription plan recorded with a config dir's claude.ai login ("max", "pro"...), or undefined. */
export function sessionPlan(dir: string): string | undefined {
    const plan = readOAuth(dir)?.subscriptionType;
    return typeof plan === "string" && plan ? plan : undefined;
}

/**
 * An Anthropic Console sign-in (API billing). Claude Code keeps it OUTSIDE the config dir, in a
 * machine-wide profile store shared by every `CLAUDE_CONFIG_DIR`, and falls back to it whenever a
 * dir has no claude.ai login. So an account with an empty `.credentials.json` can still be signed
 * in - with API billing - which is why a reader of `.credentials.json` alone reports it signed out.
 */
export interface ConsoleLogin {
    state: "ok" | "refreshable" | "expired";
    profile: string;
    email?: string;
    organization?: string;
}

/**
 * The profile store's root, resolved the way Claude Code resolves it: ANTHROPIC_CONFIG_DIR, else
 * %APPDATA%\Anthropic on Windows, else $XDG_CONFIG_HOME/anthropic, else ~/.config/anthropic.
 */
export function anthropicConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
    const explicit = env.ANTHROPIC_CONFIG_DIR?.trim();
    if (explicit) return explicit;
    if (platform === "win32") {
        const appData = env.APPDATA?.trim();
        if (appData) return join(appData, "Anthropic");
        const profile = env.USERPROFILE?.trim();
        return profile ? join(profile, "AppData", "Roaming", "Anthropic") : null;
    }
    const xdg = env.XDG_CONFIG_HOME?.trim();
    if (xdg) return join(xdg, "anthropic");
    const home = env.HOME?.trim();
    return home ? join(home, ".config", "anthropic") : null;
}

const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

function readJsonFile<T>(file: string): T | null {
    try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}

interface ConsoleConfig { authentication?: { type?: string; credentials_path?: string; }; }
interface ConsoleCredentials { access_token?: string; refresh_token?: string; expires_at?: number; account_email?: string; organization_name?: string; }

/** The active OAuth profile of a Console profile store, with its files, or null when there is none. */
function resolveConsoleProfile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { profile: string; config: ConsoleConfig; cred: ConsoleCredentials; } | null {
    const root = anthropicConfigDir(env, platform);
    if (!root) return null;
    let active = "";
    try { active = readFileSync(join(root, "active_config"), "utf8").trim(); } catch { /* no pointer: default */ }
    const profile = env.ANTHROPIC_PROFILE?.trim() || active || "default";
    if (!PROFILE_NAME.test(profile) || profile === "." || profile === "..") return null;
    const config = readJsonFile<ConsoleConfig>(join(root, "configs", `${profile}.json`));
    if (config?.authentication?.type !== "user_oauth") return null;
    const custom = config.authentication.credentials_path?.trim();
    const credFile = custom ? (isAbsolute(custom) ? custom : join(root, custom)) : join(root, "credentials", `${profile}.json`);
    const cred = readJsonFile<ConsoleCredentials>(credFile);
    if (!cred || (!cred.access_token && !cred.refresh_token)) return null;
    return { profile, config, cred };
}

/**
 * The Console sign-in Claude Code would use, or null when there is none. The profile is
 * ANTHROPIC_PROFILE, else the store's `active_config`, else "default" - the same order Claude
 * Code applies. Only an OAuth profile is reported; its tokens are read for presence and expiry,
 * never returned.
 */
export function consoleLogin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, now: number = Date.now()): ConsoleLogin | null {
    const found = resolveConsoleProfile(env, platform);
    if (!found) return null;
    const { profile, cred } = found;
    // expires_at is in SECONDS here, unlike the milliseconds of `.credentials.json`.
    const live = Boolean(cred.access_token) && (typeof cred.expires_at !== "number" || cred.expires_at * 1000 > now);
    const state = live ? "ok" : cred.refresh_token ? "refreshable" : "expired";
    return { state, profile, email: cred.account_email || undefined, organization: cred.organization_name || undefined };
}

/**
 * The Console profile store owned by one config dir. A managed account launches with
 * ANTHROPIC_CONFIG_DIR pointed here, so a signed-out account shows Claude Code's login screen
 * instead of silently falling back to the machine-wide Console sign-in of ANOTHER identity
 * (the "enigma claude runs as the wrong email" bug).
 */
export function consoleStoreDir(dir: string): string {
    return join(dir, "anthropic");
}

function sameEmail(a: string | undefined, b: string | undefined): boolean {
    return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/**
 * Whether `dir` is a Console-only account that has not been given its own store yet and whose
 * identity is the machine-wide Console sign-in: no claude.ai login was EVER recorded in it (a
 * signed-out subscription keeps its `claudeAiOauth` block with blanked tokens, and must not be
 * moved onto API billing), and its `.claude.json` email is the Console login's.
 */
function inheritsSharedConsole(dir: string, shared: ConsoleCredentials): boolean {
    if (existsSync(consoleStoreDir(dir)) || readOAuth(dir)) return false;
    return sameEmail(shared.account_email, sessionEmail(dir));
}

/**
 * The Console sign-in a managed account's launch will use: its own store's, or - before its
 * first launch migrates it - the machine-wide one when `seedConsoleStore` would carry it over.
 * `env` is the user's own environment, whose store is the machine-wide one.
 */
export function accountConsoleLogin(dir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, now: number = Date.now()): ConsoleLogin | null {
    const own = consoleLogin({ ...env, ANTHROPIC_CONFIG_DIR: consoleStoreDir(dir) }, platform, now);
    if (own || existsSync(consoleStoreDir(dir))) return own;
    const shared = resolveConsoleProfile(env, platform);
    return shared && inheritsSharedConsole(dir, shared.cred) ? consoleLogin(env, platform, now) : null;
}

/**
 * One-time migration for an account that was signed in through the Console before accounts had
 * their own store: copy the machine-wide profile into `consoleStoreDir(dir)` so the account keeps
 * working once its launch stops reading the shared store. Only for the identity rule of
 * `inheritsSharedConsole`; any other account is left to sign in on its own. The copy drops a
 * custom `credentials_path` (it would point back at the shared file). The machine-wide store is
 * never modified. The copy shares the original's refresh token and a refresh rotates it, so
 * whichever side refreshes first (this account, or a plain `claude` and the `default` account on
 * the machine-wide store) leaves the other signed out until it runs /login once. Returns whether
 * it wrote. Best-effort, never throws.
 */
export function seedConsoleStore(dir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
    try {
        if (existsSync(consoleStoreDir(dir))) return false;
        const shared = resolveConsoleProfile(env, platform);
        if (!shared || !inheritsSharedConsole(dir, shared.cred)) return false;
        const store = consoleStoreDir(dir);
        const authentication = { ...shared.config.authentication };
        delete authentication.credentials_path;
        // Credentials first, then the config that activates them: a crash in between leaves no
        // profile pointing at a missing file. The pointer goes last.
        atomicWrite(join(store, "credentials", `${shared.profile}.json`), `${JSON.stringify(shared.cred, null, 2)}\n`, 0o600);
        atomicWrite(join(store, "configs", `${shared.profile}.json`), `${JSON.stringify({ ...shared.config, authentication }, null, 2)}\n`);
        atomicWrite(join(store, "active_config"), shared.profile);
        return true;
    } catch {
        return false;
    }
}

/** Atomically write `content` to `file` (temp + rename), creating the parent dir. */
function atomicWrite(file: string, content: string, mode?: number): void {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    try {
        writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
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
