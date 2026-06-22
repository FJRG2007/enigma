/**
 * Config export/import: the dashboard bundle round-trips the runtime config and the guard
 * config (the account/profile structure is covered by the accounts tests). It must be
 * secret-free and resilient. Temp HOME (set BEFORE import) isolates ~/.enigma.json and
 * ~/.enigma-guard.json; the data layer resolves those paths lazily per call.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-io-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { exportBundle, importBundle, BUNDLE_KIND } = await import("../src/dashboard-config-io");
const { setEnigmaValue, readConfig } = await import("../src/config");
const { setGuardProtection, setGuardList, readGlobalGuard } = await import("../src/guard-config");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("exports a secret-free bundle and re-imports config + guard verbatim", async () => {
    setEnigmaValue("tokenPrice", 7, "global");
    setEnigmaValue("promptSecretGuard", true, "global");
    setGuardProtection("largeFiles", false);
    setGuardList("blockPaths", ["secrets/*.json"]);
    setGuardList("secretPatterns", ["mycorp_[a-z0-9]{8}"]);

    const bundle = exportBundle();
    expect(bundle.kind).toBe(BUNDLE_KIND);
    expect(bundle.config.tokenPrice).toBe(7);
    expect(bundle.config.promptSecretGuard).toBe(true);
    expect(bundle.guard.blockPaths).toEqual(["secrets/*.json"]);
    // The bundle carries account STRUCTURE only - no auth/credential fields.
    const flat = JSON.stringify(bundle).toLowerCase();
    expect(flat).not.toContain("access_token");
    expect(flat).not.toContain("oauth");
    expect(flat).not.toContain("apikey");
    expect(bundle.accounts).toBeDefined();

    // Mutate everything, then import the bundle and confirm it is restored.
    setEnigmaValue("tokenPrice", 0, "global");
    setEnigmaValue("promptSecretGuard", false, "global");
    setGuardProtection("largeFiles", true);
    setGuardList("blockPaths", []);
    setGuardList("secretPatterns", []);

    const res = await importBundle(bundle);
    expect(res.ok).toBe(true);
    expect(readConfig().config.tokenPrice).toBe(7);
    expect(readConfig().config.promptSecretGuard).toBe(true);
    expect(readGlobalGuard().largeFiles).toBe(false);
    expect(readGlobalGuard().blockPaths).toEqual(["secrets/*.json"]);
    expect(readGlobalGuard().secretPatterns).toEqual(["mycorp_[a-z0-9]{8}"]);
});

test("rejects a non-bundle and ignores unknown config keys", async () => {
    const bad = await importBundle({ hello: "world" });
    expect(bad.ok).toBe(false);

    const res = await importBundle({ kind: BUNDLE_KIND, version: 1, config: { tokenPrice: 3, somethingBogus: 1 }, guard: {}, accounts: { tools: {}, profiles: { active: null, items: {} } } });
    expect(res.ok).toBe(true);
    expect(readConfig().config.tokenPrice).toBe(3);
    expect(res.skipped.some((s) => s.includes("somethingBogus"))).toBe(true);
});
