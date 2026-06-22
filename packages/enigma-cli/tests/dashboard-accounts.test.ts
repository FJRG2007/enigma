/**
 * Dashboard account/profile bridge: serialize + apply one mutation, mirroring the TUI hub.
 * Temp HOME (set BEFORE import) isolates the registry under ~/.enigma. Covers create,
 * activate, rename, remove and a profile mapping; the interactive LOGIN is out of scope
 * (the browser cannot host it - the UI surfaces the command instead).
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-dashacc-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { serializeAccounts, applyAccountAction } = await import("../src/dashboard-accounts");

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
