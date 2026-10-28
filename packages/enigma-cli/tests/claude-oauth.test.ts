/**
 * Claude session (OAuth credential) reuse between config dirs. Pure file operations over temp
 * dirs - no HOME, no network, no spawn - so each case just writes .credentials.json / .claude.json
 * into a scratch dir and asserts the state classification and copy/transfer behavior.
 * Run under Bun: bun test tests/claude-oauth.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as oauth from "../src/claude-oauth";
import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const ROOT = mkdtempSync(join(tmpdir(), "enigma-oauth-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
/** A fresh empty config dir. */
function dir(): string {
    const d = join(ROOT, `d${seq++}`);
    mkdirSync(d, { recursive: true });
    return d;
}
/** Write a `.credentials.json` with the given OAuth fields into `d`. */
function creds(d: string, o: { access?: string; refresh?: string; expiresAt?: number; }): void {
    writeFileSync(join(d, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: o.access ?? "", refreshToken: o.refresh ?? "", expiresAt: o.expiresAt ?? 0 },
    }));
}
/** Write a `.claude.json` identity into `d`. */
function identity(d: string, email: string, onboarded = true): void {
    writeFileSync(join(d, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email }, hasCompletedOnboarding: onboarded, userID: `u-${email}` }));
}

const FUTURE = Date.now() + 3600_000;
const PAST = 1;

test("sessionState classifies every credential shape", () => {
    const d = dir();
    expect(oauth.sessionState(d)).toBe("absent");                                   // no file
    creds(d, { access: "", refresh: "" });
    expect(oauth.sessionState(d)).toBe("empty");                                    // blanked / logged out
    creds(d, { access: "a", refresh: "r", expiresAt: FUTURE });
    expect(oauth.sessionState(d)).toBe("ok");                                       // valid access token
    creds(d, { access: "a", refresh: "r", expiresAt: PAST });
    expect(oauth.sessionState(d)).toBe("refreshable");                              // access expired, refresh present
    creds(d, { access: "a", refresh: "", expiresAt: PAST });
    expect(oauth.sessionState(d)).toBe("expired");                                  // access expired, no refresh
    creds(d, { access: "a", refresh: "", expiresAt: FUTURE });
    expect(oauth.sessionState(d)).toBe("ok");                                       // access valid, no refresh (usable now)
});

test("isUsableSession: ok and refreshable are launchable/transferable, the rest are not", () => {
    expect(oauth.isUsableSession("ok")).toBe(true);
    expect(oauth.isUsableSession("refreshable")).toBe(true);
    expect(oauth.isUsableSession("expired")).toBe(false);
    expect(oauth.isUsableSession("empty")).toBe(false);
    expect(oauth.isUsableSession("absent")).toBe(false);
});

test("transferSession heals a signed-out account from a live one, without a re-login", () => {
    const from = dir(), to = dir();
    creds(from, { access: "LIVE", refresh: "LIVE_R", expiresAt: FUTURE });
    identity(from, "user@example.com");
    // Target is blanked (the ping-pong victim) and has no identity yet.
    creds(to, { access: "", refresh: "" });

    const res = oauth.transferSession(from, to);
    expect(res.ok).toBe(true);
    expect(res.state).toBe("ok");
    // The refresh-token-bearing credentials were copied in verbatim.
    expect(JSON.parse(readFileSync(join(to, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("LIVE_R");
    // The identity was aligned so the agent treats it as the same signed-in install.
    const cfg = JSON.parse(readFileSync(join(to, ".claude.json"), "utf8"));
    expect(cfg.oauthAccount.emailAddress).toBe("user@example.com");
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(oauth.sessionEmail(to)).toBe("user@example.com");
});

test("transferSession refuses an unusable source and a self-transfer", () => {
    const from = dir(), to = dir();
    creds(from, { access: "", refresh: "" });        // blanked source: nothing to move
    creds(to, { access: "x", refresh: "y", expiresAt: FUTURE });
    expect(oauth.transferSession(from, to).ok).toBe(false);

    const same = dir();
    creds(same, { access: "x", refresh: "y", expiresAt: FUTURE });
    expect(oauth.transferSession(same, same).ok).toBe(false);
});

test("transferSession preserves the target's own config keys (projects, mcpServers)", () => {
    const from = dir(), to = dir();
    creds(from, { access: "A", refresh: "AR", expiresAt: FUTURE });
    identity(from, "a@x");
    creds(to, { access: "", refresh: "" });
    writeFileSync(join(to, ".claude.json"), JSON.stringify({ projects: { "/p": 1 }, mcpServers: { keep: { command: "x" } } }));
    oauth.transferSession(from, to);
    const cfg = JSON.parse(readFileSync(join(to, ".claude.json"), "utf8"));
    expect(cfg.projects["/p"]).toBe(1);
    expect(cfg.mcpServers.keep.command).toBe("x");
    expect(cfg.oauthAccount.emailAddress).toBe("a@x");
});

test("copyIfFresher only propagates a strictly fresher token, never overwrites a newer one", () => {
    const account = dir(), context = dir();
    // Account fresh, context blanked -> account seeds the context.
    creds(account, { access: "ACC", refresh: "ACC_R", expiresAt: FUTURE });
    identity(account, "a@x");
    creds(context, { access: "", refresh: "" });
    expect(oauth.copyIfFresher(account, context)).toBe(true);
    expect(JSON.parse(readFileSync(join(context, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("ACC");

    // Context then refreshes (later expiry) -> copy-back heals the account.
    creds(context, { access: "NEW", refresh: "NEW_R", expiresAt: FUTURE + 10_000 });
    expect(oauth.copyIfFresher(context, account)).toBe(true);
    expect(JSON.parse(readFileSync(join(account, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("NEW");

    // Now both hold the same fresh token -> no direction is strictly fresher: no-op.
    expect(oauth.copyIfFresher(account, context)).toBe(false);
    expect(oauth.copyIfFresher(context, account)).toBe(false);
});

test("copyIfFresher heals a blanked account and refuses an unusable source", () => {
    const account = dir(), context = dir();
    // Account blanked (the exact signed-out symptom), context still alive -> heal the account.
    creds(account, { access: "", refresh: "", expiresAt: 0 });
    creds(context, { access: "CTX", refresh: "CTX_R", expiresAt: FUTURE });
    identity(context, "user@example.com");
    expect(oauth.copyIfFresher(context, account)).toBe(true);
    expect(oauth.sessionState(account)).toBe("ok");
    expect(oauth.sessionEmail(account)).toBe("user@example.com");

    // A blanked source can never displace a live target.
    const blanked = dir();
    creds(blanked, { access: "", refresh: "" });
    expect(oauth.copyIfFresher(blanked, account)).toBe(false);
    expect(oauth.sessionState(account)).toBe("ok");
});

test("anthropicConfigDir resolves the Console store the way Claude Code does", () => {
    expect(oauth.anthropicConfigDir({ ANTHROPIC_CONFIG_DIR: "/x/store", APPDATA: "/appdata" }, "win32")).toBe("/x/store");
    expect(oauth.anthropicConfigDir({ APPDATA: "/appdata" }, "win32")).toBe(join("/appdata", "Anthropic"));
    expect(oauth.anthropicConfigDir({ USERPROFILE: "/user" }, "win32")).toBe(join("/user", "AppData", "Roaming", "Anthropic"));
    expect(oauth.anthropicConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" }, "linux")).toBe(join("/xdg", "anthropic"));
    expect(oauth.anthropicConfigDir({ HOME: "/h" }, "darwin")).toBe(join("/h", ".config", "anthropic"));
    expect(oauth.anthropicConfigDir({}, "linux")).toBeNull();
});

describe("consoleLogin", () => {
    /** A Console store with one profile; `cred` is written as that profile's credentials. */
    function store(profile: string, cred: Record<string, unknown> | null, auth = "user_oauth"): string {
        const root = dir();
        mkdirSync(join(root, "configs"));
        mkdirSync(join(root, "credentials"));
        writeFileSync(join(root, "configs", `${profile}.json`), JSON.stringify({ authentication: { type: auth } }));
        if (cred) writeFileSync(join(root, "credentials", `${profile}.json`), JSON.stringify(cred));
        return root;
    }
    const NOW = 1_700_000_000_000;
    const LATER = NOW / 1000 + 3600; // expires_at is in seconds

    test("reports a live sign-in with its email and organization, never the tokens", () => {
        const root = store("default", { access_token: "A", refresh_token: "R", expires_at: LATER, account_email: "dev@example.com", organization_name: "Example Org" });
        const got = oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: root }, "linux", NOW);
        expect(got).toEqual({ state: "ok", profile: "default", email: "dev@example.com", organization: "Example Org" });
    });

    test("reads expires_at as seconds: expired with a refresh token is refreshable, without one expired", () => {
        const past = NOW / 1000 - 60;
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", refresh_token: "R", expires_at: past }) }, "linux", NOW)!.state).toBe("refreshable");
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", expires_at: past }) }, "linux", NOW)!.state).toBe("expired");
    });

    test("follows ANTHROPIC_PROFILE first, then active_config, then default", () => {
        const root = store("work", { access_token: "A", expires_at: LATER });
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: root }, "linux", NOW)).toBeNull();
        writeFileSync(join(root, "active_config"), "work\n");
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: root }, "linux", NOW)!.profile).toBe("work");
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: root, ANTHROPIC_PROFILE: "other" }, "linux", NOW)).toBeNull();
    });

    test("is null for a missing store, an API-key profile, empty credentials or a path-like profile name", () => {
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: join(ROOT, "nope") }, "linux", NOW)).toBeNull();
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", expires_at: LATER }, "api_key") }, "linux", NOW)).toBeNull();
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", {}) }, "linux", NOW)).toBeNull();
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", null) }, "linux", NOW)).toBeNull();
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", expires_at: LATER }), ANTHROPIC_PROFILE: "../default" }, "linux", NOW)).toBeNull();
    });
});

describe("per-account Console store", () => {
    const NOW = 1_700_000_000_000;
    const LATER = NOW / 1000 + 3600;
    /** A machine-wide Console store signed in as `email`, with an optional custom credentials_path. */
    function shared(email: string, customPath?: string): string {
        const root = dir();
        mkdirSync(join(root, "configs"));
        mkdirSync(join(root, "credentials"));
        writeFileSync(join(root, "configs", "default.json"), JSON.stringify({ organization_id: "org", authentication: { type: "user_oauth", ...(customPath ? { credentials_path: customPath } : {}) } }));
        writeFileSync(customPath ?? join(root, "credentials", "default.json"), JSON.stringify({ access_token: "A", refresh_token: "R", expires_at: LATER, account_email: email }));
        return root;
    }

    test("a Console-only account of the same identity is migrated into its own store", () => {
        const root = shared("dev@example.com");
        const acct = dir();
        identity(acct, "dev@example.com");
        writeFileSync(join(acct, ".credentials.json"), "{}");
        expect(oauth.accountConsoleLogin(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux", NOW)?.email).toBe("dev@example.com");
        expect(oauth.seedConsoleStore(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux")).toBe(true);
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: oauth.consoleStoreDir(acct) }, "linux", NOW)?.email).toBe("dev@example.com");
        expect(oauth.seedConsoleStore(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux")).toBe(false); // one-time
    });

    test("a signed-out subscription account never inherits another identity's Console login", () => {
        const root = shared("other@example.com");
        const acct = dir();
        identity(acct, "me@example.com");
        creds(acct, { access: "", refresh: "" }); // blanked by Claude Code after a failed refresh
        expect(oauth.seedConsoleStore(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux")).toBe(false);
        expect(oauth.accountConsoleLogin(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux", NOW)).toBeNull();
        expect(existsSync(oauth.consoleStoreDir(acct))).toBe(false);
    });

    test("a blanked subscription is not moved onto API billing even with the same email", () => {
        const root = shared("me@example.com");
        const acct = dir();
        identity(acct, "me@example.com");
        creds(acct, { access: "", refresh: "" });
        expect(oauth.seedConsoleStore(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux")).toBe(false);
    });

    test("an account that already has its own store ignores the machine-wide one", () => {
        const root = shared("dev@example.com");
        const acct = dir();
        identity(acct, "dev@example.com");
        mkdirSync(oauth.consoleStoreDir(acct));
        expect(oauth.accountConsoleLogin(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux", NOW)).toBeNull();
        expect(oauth.seedConsoleStore(acct, { ANTHROPIC_CONFIG_DIR: root }, "linux")).toBe(false);
    });

    test("the migrated copy drops a custom credentials_path that would point back at the shared file", () => {
        const root = dir();
        const custom = join(root, "elsewhere.json");
        const machine = shared("dev@example.com", custom);
        const acct = dir();
        identity(acct, "dev@example.com");
        expect(oauth.seedConsoleStore(acct, { ANTHROPIC_CONFIG_DIR: machine }, "linux")).toBe(true);
        const config = JSON.parse(readFileSync(join(oauth.consoleStoreDir(acct), "configs", "default.json"), "utf8"));
        expect(config.authentication).toEqual({ type: "user_oauth" });
        expect(config.organization_id).toBe("org");
        expect(oauth.consoleLogin({ ANTHROPIC_CONFIG_DIR: oauth.consoleStoreDir(acct) }, "linux", NOW)?.state).toBe("ok");
    });
});
