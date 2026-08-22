/**
 * Marketplace packs: isolated deployment of an optional harness pack into a dedicated agent
 * context, plus the enable/disable and MCP-setup lifecycle. Temp HOME + ENIGMA_CONFIG_HOME
 * isolate the config/registry; ENIGMA_PACKS_DIR isolates the managed install + context; and
 * ENIGMA_HELIO_ASSETS points the resolver at the in-repo vendored assets so nothing is fetched
 * from npm. Network-free and spawn-free (the actual agent launch is never invoked).
 * Run under Bun: bun test tests/packs.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-packs-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_PACKS_DIR = join(HOME, "packs");
// Resolve the Helio pack from the in-repo vendored assets (no npm fetch).
process.env.ENIGMA_HELIO_ASSETS = join(__dirname, "..", "..", "helio", "assets");

const packs = await import("../src/packs");
const { readConfig } = await import("../src/config");
const { addAccount } = await import("../src/accounts");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("lists the Helio pack, resolved from the vendored assets", () => {
    const list = packs.listPacks();
    const helio = list.find((p) => p.id === "helio");
    expect(helio).toBeTruthy();
    expect(helio!.installed).toBe(true); // assets resolvable -> counts as installed
    expect(helio!.enabled).toBe(false);
});

test("deploys ONLY into the isolated context dir (skills, commands, agents, memory)", () => {
    const ctx = packs.deployPack("helio", "claude");
    expect(ctx).toBeTruthy();
    // The context lives under the managed packs dir, never in the user's ~/.claude.
    expect(ctx!.startsWith(join(HOME, "packs"))).toBe(true);
    expect(existsSync(join(ctx!, "skills", "bug-bounty", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ctx!, "commands"))).toBe(true);
    expect(existsSync(join(ctx!, "agents"))).toBe(true);
    // Memory carries the harness instructions.
    const memory = readFileSync(join(ctx!, "CLAUDE.md"), "utf8");
    expect(memory).toContain("Helio");
    // The normal agent home is untouched.
    expect(existsSync(join(HOME, ".claude", "skills", "bug-bounty"))).toBe(false);
});

test("deploy enables Claude permission bypass in the pack context by default", () => {
    packs.deployPack("helio", "claude");
    const settings = JSON.parse(readFileSync(join(HOME, "packs", "helio", "context", "claude", "settings.json"), "utf8"));
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
});

test("deploy mirrors the user's enigma-managed Claude settings into the pack context", () => {
    // The user disabled commit attribution + the feedback survey in their global Claude settings.
    const globalSettings = join(HOME, ".claude", "settings.json");
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    writeFileSync(globalSettings, JSON.stringify({
        attribution: { commit: "", pr: "", sessionUrl: false },
        includeCoAuthoredBy: false,
        env: { CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1" },
    }));
    // Force a re-deploy (the version marker may already match from earlier tests).
    rmSync(join(HOME, "packs", "helio", "context", "claude", ".enigma-pack-version"), { force: true });
    packs.deployPack("helio", "claude");
    const settings = JSON.parse(readFileSync(join(HOME, "packs", "helio", "context", "claude", "settings.json"), "utf8"));
    expect(settings.attribution.commit).toBe("");
    expect(settings.attribution.pr).toBe("");
    expect(settings.attribution.sessionUrl).toBe(false);
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe("1");
    // The pack's forced bypass default still wins over the mirror.
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    rmSync(globalSettings, { force: true });
});

test("re-deploy is version-gated (idempotent no-op when the marker matches)", () => {
    const ctx = packs.deployPack("helio", "claude")!;
    const marker = join(ctx, ".enigma-pack-version");
    const before = readFileSync(marker, "utf8");
    const again = packs.deployPack("helio", "claude")!;
    expect(again).toBe(ctx);
    expect(readFileSync(marker, "utf8")).toBe(before);
});

test("enable/disable toggles config.packs and disable removes the managed tree", () => {
    packs.enablePack("helio");
    expect(readConfig().config.packs).toContain("helio");
    expect(packs.isPackEnabled("helio")).toBe(true);

    packs.disablePack("helio");
    expect(readConfig().config.packs).not.toContain("helio");
    expect(existsSync(join(HOME, "packs", "helio"))).toBe(false);
});

test("seeding account: defaults to the active account, can be pinned to any account, and cleared", () => {
    // With no pin and only the synthetic default account, the pack follows "default".
    expect(packs.resolvePackAccount("helio", "claude")).toBe("default");
    expect(packs.getPackAccount("helio", "claude")).toBeNull();

    // Pin a real, user-configured account.
    addAccount("claude", "pentest");
    packs.setPackDefaultAccount("helio", "claude", "pentest");
    expect(packs.getPackAccount("helio", "claude")).toBe("pentest");
    expect(packs.resolvePackAccount("helio", "claude")).toBe("pentest");
    // An explicit choice still wins over the pin.
    expect(packs.resolvePackAccount("helio", "claude", "default")).toBe("default");

    // Clearing falls back to the active account again.
    packs.setPackDefaultAccount("helio", "claude", null);
    expect(packs.getPackAccount("helio", "claude")).toBeNull();
    expect(packs.resolvePackAccount("helio", "claude")).toBe("default");

    // An unknown account is rejected (never silently seeds the wrong login).
    expect(() => packs.setPackDefaultAccount("helio", "claude", "ghost")).toThrow();
    expect(() => packs.resolvePackAccount("helio", "claude", "ghost")).toThrow();
});

test("launchPack refuses an unknown explicit account before spawning anything", async () => {
    const code = await packs.launchPack("helio", "claude", [], "does-not-exist");
    expect(code).toBe(1);
});

test("credential seeding never clobbers a refreshed context token (the re-login bug)", () => {
    // Give the 'pentest' account a usable stored token.
    const acct = addAccount("claude", "seedtest");
    const cred = (access: string, refresh: string) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 0 } });
    writeFileSync(join(acct.dir, ".credentials.json"), cred("ACCT_ACCESS", "ACCT_REFRESH"));
    packs.deployPack("helio", "claude");
    const ctxCred = join(HOME, "packs", "helio", "context", "claude", ".credentials.json");

    // First seed (context empty) copies the account's token in.
    packs.seedCredentials("helio", "claude", "seedtest");
    expect(JSON.parse(readFileSync(ctxCred, "utf8")).claudeAiOauth.accessToken).toBe("ACCT_ACCESS");

    // Simulate the agent refreshing its token in the context (rotation).
    writeFileSync(ctxCred, cred("REFRESHED_ACCESS", "REFRESHED_REFRESH"));
    // A second launch must NOT overwrite the refreshed token with the account's older one.
    packs.seedCredentials("helio", "claude", "seedtest");
    expect(JSON.parse(readFileSync(ctxCred, "utf8")).claudeAiOauth.accessToken).toBe("REFRESHED_ACCESS");

    // But a blanked/logged-out context token IS re-seeded (recovery).
    writeFileSync(ctxCred, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }));
    packs.seedCredentials("helio", "claude", "seedtest");
    expect(JSON.parse(readFileSync(ctxCred, "utf8")).claudeAiOauth.accessToken).toBe("ACCT_ACCESS");
});

test("re-seeds when the pinned account changes (replaces a previous account's token)", () => {
    const cred = (a: string) => JSON.stringify({ claudeAiOauth: { accessToken: a, refreshToken: `${a}_R`, expiresAt: Date.now() + 3600_000 }, oauthAccount: { emailAddress: `${a}@x` } });
    const a = addAccount("claude", "acctA");
    const b = addAccount("claude", "acctB");
    writeFileSync(join(a.dir, ".credentials.json"), cred("AAA"));
    writeFileSync(join(a.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@x" }, hasCompletedOnboarding: true }));
    writeFileSync(join(b.dir, ".credentials.json"), cred("BBB"));
    writeFileSync(join(b.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "b@x" }, hasCompletedOnboarding: true }));
    packs.deployPack("helio", "claude");
    const ctxDir = join(HOME, "packs", "helio", "context", "claude");
    const ctxCred = join(ctxDir, ".credentials.json");
    rmSync(ctxCred, { force: true });
    rmSync(join(ctxDir, ".enigma-pack-account"), { force: true });

    packs.seedCredentials("helio", "claude", "acctA");
    expect(JSON.parse(readFileSync(ctxCred, "utf8")).claudeAiOauth.accessToken).toBe("AAA");
    // Switching to acctB must replace the (usable) acctA token AND align the context identity.
    packs.seedCredentials("helio", "claude", "acctB");
    expect(JSON.parse(readFileSync(ctxCred, "utf8")).claudeAiOauth.accessToken).toBe("BBB");
    const ctxJson = JSON.parse(readFileSync(join(ctxDir, ".claude.json"), "utf8"));
    expect((ctxJson.oauthAccount || {}).emailAddress).toBe("b@x");
    // The onboarding flag is mirrored too, so the agent treats the context as already set up
    // (a missing flag makes it run onboarding + login despite a valid token).
    expect(ctxJson.hasCompletedOnboarding).toBe(true);
});

test("credential seeding never plants a blanked source token (keychain-stored logins)", () => {
    // Account whose file token is blanked (its real token lives in the OS keychain).
    const acct = addAccount("claude", "keychainacct");
    writeFileSync(join(acct.dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }));
    packs.deployPack("helio", "claude");
    const ctxCred = join(HOME, "packs", "helio", "context", "claude", ".credentials.json");
    rmSync(ctxCred, { force: true });
    // Seeding from a blanked source must NOT create an empty token file in the context
    // (an empty file would block the agent's own keychain/session resolution).
    packs.seedCredentials("helio", "claude", "keychainacct");
    expect(existsSync(ctxCred)).toBe(false);
});

test("accountTokenState: a past-expiry token with a refresh token is OK (auto-refreshes)", () => {
    const acct = addAccount("claude", "statetest");
    const write = (o: object) => writeFileSync(join(acct.dir, ".credentials.json"), JSON.stringify(o));
    expect(packs.accountTokenState("claude", "statetest")).toBe("absent");
    write({ claudeAiOauth: { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 3600_000 } });
    expect(packs.accountTokenState("claude", "statetest")).toBe("ok");
    // Past expiry but a refresh token present -> still OK (the agent refreshes it).
    write({ claudeAiOauth: { accessToken: "x", refreshToken: "y", expiresAt: 1 } });
    expect(packs.accountTokenState("claude", "statetest")).toBe("ok");
    // Past expiry AND no refresh token -> genuinely expired.
    write({ claudeAiOauth: { accessToken: "x", refreshToken: "", expiresAt: 1 } });
    expect(packs.accountTokenState("claude", "statetest")).toBe("expired");
    // No access token -> signed out.
    write({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } });
    expect(packs.accountTokenState("claude", "statetest")).toBe("empty");
});

test("reconcilePackSession heals a blanked account from the live pack context (ping-pong fix)", () => {
    // The exact reported symptom: the pack context holds a live token, the managed account it was
    // seeded from went blank (logged out by OAuth rotation), so `enigma claude` shows signed out.
    const acct = addAccount("claude", "pingpong");
    const ctxDir = join(HOME, "packs", "helio", "context", "claude");
    const ctxCred = join(ctxDir, ".credentials.json");
    mkdirSync(ctxDir, { recursive: true });
    // Account credentials blanked; context alive with a valid refresh token.
    writeFileSync(join(acct.dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }));
    writeFileSync(ctxCred, JSON.stringify({ claudeAiOauth: { accessToken: "LIVE", refreshToken: "LIVE_R", expiresAt: Date.now() + 3600_000 } }));
    writeFileSync(join(ctxDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "user@example.com" }, hasCompletedOnboarding: true }));

    packs.reconcilePackSession("helio", "claude", "pingpong");

    // The account is healed from the context - signed in again, no /login needed.
    expect(packs.accountTokenState("claude", "pingpong")).toBe("ok");
    expect(JSON.parse(readFileSync(join(acct.dir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("LIVE_R");
    expect(JSON.parse(readFileSync(join(acct.dir, ".claude.json"), "utf8")).oauthAccount.emailAddress).toBe("user@example.com");
});

test("reconcilePackSession pushes a fresher account token into the context, and never writes the default account", () => {
    const acct = addAccount("claude", "reconpush");
    const ctxDir = join(HOME, "packs", "helio", "context", "claude");
    const ctxCred = join(ctxDir, ".credentials.json");
    mkdirSync(ctxDir, { recursive: true });
    // Account fresher (later expiry) than the context.
    writeFileSync(join(acct.dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "ACCT", refreshToken: "ACCT_R", expiresAt: Date.now() + 7200_000 } }));
    writeFileSync(ctxCred, JSON.stringify({ claudeAiOauth: { accessToken: "OLD", refreshToken: "OLD_R", expiresAt: Date.now() + 60_000 } }));
    packs.reconcilePackSession("helio", "claude", "reconpush");
    expect(JSON.parse(readFileSync(ctxCred, "utf8")).claudeAiOauth.accessToken).toBe("ACCT");

    // The synthetic "default" account (the user's own ~/.claude) is never written to.
    const defaultCred = join(HOME, ".claude", ".credentials.json");
    rmSync(defaultCred, { force: true });
    packs.reconcilePackSession("helio", "claude", "default");
    expect(existsSync(defaultCred)).toBe(false);
});

test("packSessionSources lists pack contexts that hold a credentials file", () => {
    const ctxDir = join(HOME, "packs", "helio", "context", "claude");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 3600_000 } }));
    const sources = packs.packSessionSources("claude");
    expect(sources.find((s) => s.id === "helio")).toBeTruthy();
    expect(sources.find((s) => s.id === "helio")!.dir).toBe(ctxDir);
});

test("setup registers the pack's MCP servers into the isolated context only", () => {
    packs.deployPack("helio", "claude");
    const added = packs.setupPackMcp("helio", "claude");
    expect(added).toContain("helio-hackerone");
    const cfg = JSON.parse(readFileSync(join(HOME, "packs", "helio", "context", "claude", ".claude.json"), "utf8"));
    expect(cfg.mcpServers["helio-hackerone"].command).toMatch(/python/);
    // The server path points inside the pack assets, and into the agent's own config only.
    expect(cfg.mcpServers["helio-hackerone"].args[0]).toContain("hackerone-mcp");
});
