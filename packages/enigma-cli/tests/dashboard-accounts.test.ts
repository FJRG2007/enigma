/**
 * Dashboard account/profile bridge: serialize + apply one mutation, mirroring the TUI hub.
 * Temp HOME (set BEFORE import) isolates the registry under ~/.enigma. Covers create,
 * activate, rename, remove and a profile mapping; the interactive LOGIN is out of scope
 * (the browser cannot host it - the UI surfaces the command instead).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-dashacc-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_NO_TERMINAL = "1"; // account.login must never open a real terminal in tests

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
    expect(r.error).toContain("enigma claude");
});
