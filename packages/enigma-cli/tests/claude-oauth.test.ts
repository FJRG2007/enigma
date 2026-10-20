/**
 * Claude session (OAuth credential) reuse between config dirs. Pure file operations over temp
 * dirs - no HOME, no network, no spawn - so each case just writes .credentials.json / .claude.json
 * into a scratch dir and asserts the state classification and copy/transfer behavior.
 * Run under Bun: bun test tests/claude-oauth.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

import { sessionState, isUsableSession, transferSession, copyIfFresher, sessionEmail, anthropicConfigDir, consoleLogin } from "../src/claude-oauth";

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
    expect(sessionState(d)).toBe("absent");                                   // no file
    creds(d, { access: "", refresh: "" });
    expect(sessionState(d)).toBe("empty");                                    // blanked / logged out
    creds(d, { access: "a", refresh: "r", expiresAt: FUTURE });
    expect(sessionState(d)).toBe("ok");                                       // valid access token
    creds(d, { access: "a", refresh: "r", expiresAt: PAST });
    expect(sessionState(d)).toBe("refreshable");                              // access expired, refresh present
    creds(d, { access: "a", refresh: "", expiresAt: PAST });
    expect(sessionState(d)).toBe("expired");                                  // access expired, no refresh
    creds(d, { access: "a", refresh: "", expiresAt: FUTURE });
    expect(sessionState(d)).toBe("ok");                                       // access valid, no refresh (usable now)
});

test("isUsableSession: ok and refreshable are launchable/transferable, the rest are not", () => {
    expect(isUsableSession("ok")).toBe(true);
    expect(isUsableSession("refreshable")).toBe(true);
    expect(isUsableSession("expired")).toBe(false);
    expect(isUsableSession("empty")).toBe(false);
    expect(isUsableSession("absent")).toBe(false);
});

test("transferSession heals a signed-out account from a live one, without a re-login", () => {
    const from = dir(), to = dir();
    creds(from, { access: "LIVE", refresh: "LIVE_R", expiresAt: FUTURE });
    identity(from, "user@example.com");
    // Target is blanked (the ping-pong victim) and has no identity yet.
    creds(to, { access: "", refresh: "" });

    const res = transferSession(from, to);
    expect(res.ok).toBe(true);
    expect(res.state).toBe("ok");
    // The refresh-token-bearing credentials were copied in verbatim.
    expect(JSON.parse(readFileSync(join(to, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("LIVE_R");
    // The identity was aligned so the agent treats it as the same signed-in install.
    const cfg = JSON.parse(readFileSync(join(to, ".claude.json"), "utf8"));
    expect(cfg.oauthAccount.emailAddress).toBe("user@example.com");
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(sessionEmail(to)).toBe("user@example.com");
});

test("transferSession refuses an unusable source and a self-transfer", () => {
    const from = dir(), to = dir();
    creds(from, { access: "", refresh: "" });        // blanked source: nothing to move
    creds(to, { access: "x", refresh: "y", expiresAt: FUTURE });
    expect(transferSession(from, to).ok).toBe(false);

    const same = dir();
    creds(same, { access: "x", refresh: "y", expiresAt: FUTURE });
    expect(transferSession(same, same).ok).toBe(false);
});

test("transferSession preserves the target's own config keys (projects, mcpServers)", () => {
    const from = dir(), to = dir();
    creds(from, { access: "A", refresh: "AR", expiresAt: FUTURE });
    identity(from, "a@x");
    creds(to, { access: "", refresh: "" });
    writeFileSync(join(to, ".claude.json"), JSON.stringify({ projects: { "/p": 1 }, mcpServers: { keep: { command: "x" } } }));
    transferSession(from, to);
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
    expect(copyIfFresher(account, context)).toBe(true);
    expect(JSON.parse(readFileSync(join(context, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("ACC");

    // Context then refreshes (later expiry) -> copy-back heals the account.
    creds(context, { access: "NEW", refresh: "NEW_R", expiresAt: FUTURE + 10_000 });
    expect(copyIfFresher(context, account)).toBe(true);
    expect(JSON.parse(readFileSync(join(account, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("NEW");

    // Now both hold the same fresh token -> no direction is strictly fresher: no-op.
    expect(copyIfFresher(account, context)).toBe(false);
    expect(copyIfFresher(context, account)).toBe(false);
});

test("copyIfFresher heals a blanked account and refuses an unusable source", () => {
    const account = dir(), context = dir();
    // Account blanked (the exact signed-out symptom), context still alive -> heal the account.
    creds(account, { access: "", refresh: "", expiresAt: 0 });
    creds(context, { access: "CTX", refresh: "CTX_R", expiresAt: FUTURE });
    identity(context, "user@example.com");
    expect(copyIfFresher(context, account)).toBe(true);
    expect(sessionState(account)).toBe("ok");
    expect(sessionEmail(account)).toBe("user@example.com");

    // A blanked source can never displace a live target.
    const blanked = dir();
    creds(blanked, { access: "", refresh: "" });
    expect(copyIfFresher(blanked, account)).toBe(false);
    expect(sessionState(account)).toBe("ok");
});

test("anthropicConfigDir resolves the Console store the way Claude Code does", () => {
    expect(anthropicConfigDir({ ANTHROPIC_CONFIG_DIR: "/x/store", APPDATA: "/appdata" }, "win32")).toBe("/x/store");
    expect(anthropicConfigDir({ APPDATA: "/appdata" }, "win32")).toBe(join("/appdata", "Anthropic"));
    expect(anthropicConfigDir({ USERPROFILE: "/user" }, "win32")).toBe(join("/user", "AppData", "Roaming", "Anthropic"));
    expect(anthropicConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" }, "linux")).toBe(join("/xdg", "anthropic"));
    expect(anthropicConfigDir({ HOME: "/h" }, "darwin")).toBe(join("/h", ".config", "anthropic"));
    expect(anthropicConfigDir({}, "linux")).toBeNull();
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
        const got = consoleLogin({ ANTHROPIC_CONFIG_DIR: root }, "linux", NOW);
        expect(got).toEqual({ state: "ok", profile: "default", email: "dev@example.com", organization: "Example Org" });
    });

    test("reads expires_at as seconds: expired with a refresh token is refreshable, without one expired", () => {
        const past = NOW / 1000 - 60;
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", refresh_token: "R", expires_at: past }) }, "linux", NOW)!.state).toBe("refreshable");
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", expires_at: past }) }, "linux", NOW)!.state).toBe("expired");
    });

    test("follows ANTHROPIC_PROFILE first, then active_config, then default", () => {
        const root = store("work", { access_token: "A", expires_at: LATER });
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: root }, "linux", NOW)).toBeNull();
        writeFileSync(join(root, "active_config"), "work\n");
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: root }, "linux", NOW)!.profile).toBe("work");
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: root, ANTHROPIC_PROFILE: "other" }, "linux", NOW)).toBeNull();
    });

    test("is null for a missing store, an API-key profile, empty credentials or a path-like profile name", () => {
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: join(ROOT, "nope") }, "linux", NOW)).toBeNull();
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", expires_at: LATER }, "api_key") }, "linux", NOW)).toBeNull();
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", {}) }, "linux", NOW)).toBeNull();
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", null) }, "linux", NOW)).toBeNull();
        expect(consoleLogin({ ANTHROPIC_CONFIG_DIR: store("default", { access_token: "A", expires_at: LATER }), ANTHROPIC_PROFILE: "../default" }, "linux", NOW)).toBeNull();
    });
});
