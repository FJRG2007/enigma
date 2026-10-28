/**
 * Dashboard account/profile bridge: serialize + apply one mutation, mirroring the TUI hub.
 * Temp HOME (set BEFORE import) isolates the registry under ~/.enigma. Covers create,
 * activate, rename, remove and a profile mapping; the interactive LOGIN is out of scope
 * (the browser cannot host it - the UI surfaces the command instead).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-dashacc-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_NO_TERMINAL = "1"; // account.login must never open a real terminal in tests
// The machine-wide Anthropic Console store, pointed into the temp HOME so a real sign-in on the
// test machine can never mark an account as logged in.
const ANTHROPIC = join(HOME, "anthropic");
process.env.ANTHROPIC_CONFIG_DIR = ANTHROPIC;
delete process.env.ANTHROPIC_PROFILE;

const { serializeAccounts, applyAccountAction } = await import("../src/dashboard-accounts");
const { addAccount, resolveConfigDir } = await import("../src/accounts");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("serializes the synthetic default accounts for every tool", () => {
    const d = serializeAccounts();
    expect(d.tools.length).toBeGreaterThan(0);
    // Each tool has a non-removable, synthetic "default" account.
    expect(d.accounts.some((a) => a.tool === "claude" && a.name === "default" && !a.removable)).toBe(true);
});

test("creates, activates, renames and removes a managed account", async () => {
    let r = await applyAccountAction("account.add", { tool: "claude", name: "work" });
    expect(r.ok).toBe(true);
    expect(r.data.accounts.some((a) => a.tool === "claude" && a.name === "work" && a.removable)).toBe(true);

    r = await applyAccountAction("account.activate", { tool: "claude", name: "work" });
    expect(r.data.accounts.find((a) => a.tool === "claude" && a.name === "work")!.active).toBe(true);

    r = await applyAccountAction("account.rename", { tool: "claude", name: "work", newName: "office" });
    expect(r.ok).toBe(true);
    expect(r.data.accounts.some((a) => a.name === "office")).toBe(true);
    expect(r.data.accounts.some((a) => a.name === "work")).toBe(false);

    r = await applyAccountAction("account.remove", { tool: "claude", name: "office" });
    expect(r.ok).toBe(true);
    expect(r.data.accounts.some((a) => a.name === "office")).toBe(false);

    // A duplicate / invalid name comes back as an error, not a throw.
    const bad = await applyAccountAction("account.add", { tool: "claude", name: "default" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
});

test("manages a profile and pins a tool account", async () => {
    await applyAccountAction("account.add", { tool: "claude", name: "p1" });
    let r = await applyAccountAction("profile.add", { name: "team" });
    expect(r.ok).toBe(true);
    expect(r.data.profiles.some((p) => p.name === "team")).toBe(true);

    r = await applyAccountAction("profile.setAccount", { profile: "team", tool: "claude", account: "p1" });
    expect(r.ok).toBe(true);
    expect(r.data.profiles.find((p) => p.name === "team")!.accounts.claude).toBe("p1");

    r = await applyAccountAction("profile.setAccount", { profile: "team", tool: "claude", account: null });
    expect(r.data.profiles.find((p) => p.name === "team")!.accounts.claude).toBeUndefined();

    r = await applyAccountAction("profile.remove", { name: "team" });
    expect(r.data.profiles.some((p) => p.name === "team")).toBe(false);
});

test("Claude accounts report a login state (a cached email is not 'logged in' without a token)", () => {
    const d = serializeAccounts();
    const def = d.accounts.find((a) => a.tool === "claude" && a.name === "default")!;
    // No credentials file in the temp HOME -> not a usable session.
    expect(def.loginState).toBe("absent");
    expect(def.loggedIn).toBe(false);
});

test("account.transfer reuses a live session into a signed-out account (no re-login)", async () => {
    // A source account with a live token, and a target that is signed out.
    const src = addAccount("claude", "livesrc");
    const dst = addAccount("claude", "deadtarget");
    writeFileSync(join(src.dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "L", refreshToken: "LR", expiresAt: Date.now() + 3600_000 } }));
    writeFileSync(join(src.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "live@x" }, hasCompletedOnboarding: true }));
    writeFileSync(join(dst.dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }));

    // The source shows up as a usable session; the target is empty.
    const before = serializeAccounts();
    expect(before.sessionSources.find((s) => s.id === "account:livesrc")!.usable).toBe(true);
    expect(before.accounts.find((a) => a.name === "deadtarget")!.loggedIn).toBe(false);

    const r = await applyAccountAction("account.transfer", { tool: "claude", name: "deadtarget", source: "account:livesrc" });
    expect(r.ok).toBe(true);
    // The target is signed in now, sharing the moved login.
    expect(r.data.accounts.find((a) => a.name === "deadtarget")!.loggedIn).toBe(true);
    expect(JSON.parse(readFileSync(join(resolveConfigDir("claude", "deadtarget"), ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("LR");

    // Unknown source id and a non-claude tool are rejected, not thrown.
    expect((await applyAccountAction("account.transfer", { tool: "claude", name: "deadtarget", source: "account:ghost" })).ok).toBe(false);
    expect((await applyAccountAction("account.transfer", { tool: "codex", name: "default", source: "account:livesrc" })).ok).toBe(false);
});

test("account.login is offered for any account and never throws (terminal suppressed in tests)", async () => {
    const r = await applyAccountAction("account.login", { tool: "claude", name: "default" });
    // ENIGMA_NO_TERMINAL=1 makes the spawn a no-op, so it falls back to the command hint.
    expect(r.ok).toBe(false);
    // It names the account, so `default` cannot land in whichever account is the default.
    expect(r.error).toContain("enigma account login default --tool claude");
});

test("every account carries the command that opens it", () => {
    const d = serializeAccounts();
    for (const a of d.accounts) expect(a.launch).toBe(`enigma ${a.tool} ${a.name}`);
});

test("a Claude account with no claude.ai login is signed in through its own Console sign-in", async () => {
    const acc = addAccount("claude", "apikey");
    writeFileSync(join(acc.dir, ".credentials.json"), "{}");
    writeFileSync(join(acc.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "dev@example.com" } }));
    // Another identity with no login of its own must NOT be shown on that Console sign-in.
    const other = addAccount("claude", "otherid");
    writeFileSync(join(other.dir, ".credentials.json"), "{}");
    writeFileSync(join(other.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" } }));
    let a = serializeAccounts().accounts.find((x) => x.name === "apikey")!;
    expect(a.loggedIn).toBe(false);

    mkdirSync(join(ANTHROPIC, "configs"), { recursive: true });
    mkdirSync(join(ANTHROPIC, "credentials"), { recursive: true });
    writeFileSync(join(ANTHROPIC, "configs", "default.json"), JSON.stringify({ authentication: { type: "user_oauth" } }));
    writeFileSync(join(ANTHROPIC, "credentials", "default.json"), JSON.stringify({ access_token: "A", refresh_token: "R", expires_at: Math.floor(Date.now() / 1000) + 3600, account_email: "dev@example.com", organization_name: "Example Org" }));
    a = serializeAccounts().accounts.find((x) => x.name === "apikey")!;
    expect(a.loggedIn).toBe(true);
    expect(a.loginMethod).toBe("console");
    expect(a.organization).toBe("Example Org");
    expect(a.email).toBe("dev@example.com");
    const o = serializeAccounts().accounts.find((x) => x.name === "otherid")!;
    expect(o.loggedIn).toBe(false);
    expect(o.loginMethod).toBeUndefined();

    // An account on another provider runs on that provider's token, never the Console.
    addAccount("claude", "proxied");
    await applyAccountAction("account.provider", { tool: "claude", name: "proxied", provider: { preset: "minimax", token: "T" } });
    a = serializeAccounts().accounts.find((x) => x.name === "proxied")!;
    expect(a.loginMethod).toBeUndefined();
    expect(a.organization).toBeUndefined();

    // An expired claude.ai login stays expired so it can be re-authenticated.
    const stale = addAccount("claude", "stale");
    writeFileSync(join(stale.dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "S", expiresAt: Date.now() - 3600_000 } }));
    a = serializeAccounts().accounts.find((x) => x.name === "stale")!;
    expect(a.loginState).toBe("expired");
    expect(a.loginMethod).toBeUndefined();

    // An account with its own live claude.ai login keeps it: the Console is only the fallback.
    writeFileSync(join(acc.dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "S", refreshToken: "SR", expiresAt: Date.now() + 3600_000, subscriptionType: "max" } }));
    a = serializeAccounts().accounts.find((x) => x.name === "apikey")!;
    expect(a.loginMethod).toBe("subscription");
    expect(a.plan).toBe("max");
    expect(a.organization).toBeUndefined();
    rmSync(ANTHROPIC, { recursive: true, force: true });
});

// The dashboard's name field refuses a command name as it is typed, from the server's own list.
test("the accounts payload carries the reserved command names", () => {
    const names = serializeAccounts().reservedNames;
    for (const n of ["update", "claude", "helio", "gate"]) expect(names).toContain(n);
});
