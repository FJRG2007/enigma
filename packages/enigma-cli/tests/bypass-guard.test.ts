/**
 * The destructive-command guard that rides with the permission bypass: exact-match deny rules
 * for wiping a machine or force-pushing a shared default branch. Added when bypass is turned on,
 * re-asserted on sync for an install that already had it, carried to accounts, removed with it.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-bypass-guard-"));

// claude.ts resolves the settings path through enigmaHome() on every call, which prefers
// ENIGMA_CONFIG_HOME; bun on Linux ignores a reassigned HOME, and other test files point the
// variable at their own dirs. Pinned per test and restored, like claude-settings.test.ts does.
let priorConfigHome: string | undefined;
beforeEach(() => {
    priorConfigHome = process.env.ENIGMA_CONFIG_HOME;
    process.env.ENIGMA_CONFIG_HOME = HOME;
});
afterEach(() => {
    if (priorConfigHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorConfigHome;
});

const { enableClaudeBypass, ensureClaudeBypassGuard, mirrorClaudeSettings, BYPASS_GUARD_DENY } = await import("../src/claude");

const GLOBAL = join(HOME, ".claude", "settings.json");
mkdirSync(join(HOME, ".claude"), { recursive: true });
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const read = (path: string): { permissions?: { defaultMode?: string; deny?: string[]; allow?: string[]; }; } => JSON.parse(readFileSync(path, "utf8"));

test("turning the bypass on adds the guard next to the user's own rules", () => {
    writeFileSync(GLOBAL, JSON.stringify({ permissions: { deny: ["Bash(curl * | sh)"], allow: ["Bash(npm test)"] } }));
    expect(enableClaudeBypass("global", false).changed).toBe(true);
    const settings = read(GLOBAL);
    expect(settings.permissions?.defaultMode).toBe("bypassPermissions");
    expect(settings.permissions?.deny?.[0]).toBe("Bash(curl * | sh)");
    for (const rule of BYPASS_GUARD_DENY) expect(settings.permissions?.deny).toContain(rule);
    expect(settings.permissions?.allow).toEqual(["Bash(npm test)"]);
    // Idempotent, so it can run on every sync.
    expect(enableClaudeBypass("global", false).changed).toBe(false);
});

test("an install that already had the bypass receives the guard on sync; one without it does not", () => {
    writeFileSync(GLOBAL, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
    expect(ensureClaudeBypassGuard("global")).toBe(true);
    expect(read(GLOBAL).permissions?.deny).toEqual(BYPASS_GUARD_DENY);
    expect(ensureClaudeBypassGuard("global")).toBe(false);

    writeFileSync(GLOBAL, JSON.stringify({ permissions: { defaultMode: "default" } }));
    expect(ensureClaudeBypassGuard("global")).toBe(false);
    expect(read(GLOBAL).permissions?.deny).toBeUndefined();
});

test("every rule is an exact command, never a prefix that would catch ordinary work", () => {
    // Claude Code reads `*` in a rule as a wildcard: `Bash(rm -rf /*)` would also refuse
    // `rm -rf /tmp/build`. So no rule may carry one, nor the `:*` prefix form.
    for (const rule of BYPASS_GUARD_DENY) expect(rule).not.toContain("*");
});

test("an account launched with the bypass carries the same guard", () => {
    writeFileSync(GLOBAL, JSON.stringify({ permissions: { defaultMode: "bypassPermissions", deny: [...BYPASS_GUARD_DENY] } }));
    const account = join(HOME, "account");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(make deploy)"] } }));
    mirrorClaudeSettings(account);
    const mirrored = read(join(account, "settings.json"));
    expect(mirrored.permissions?.defaultMode).toBe("bypassPermissions");
    expect(mirrored.permissions?.deny?.[0]).toBe("Bash(make deploy)");
    for (const rule of BYPASS_GUARD_DENY) expect(mirrored.permissions?.deny).toContain(rule);
});

test("turning the bypass off takes the guard with it and leaves the user's rules", async () => {
    const { setClaudeBypass } = await import("../src/claude");
    writeFileSync(GLOBAL, JSON.stringify({ permissions: { defaultMode: "bypassPermissions", deny: ["Bash(make deploy)", ...BYPASS_GUARD_DENY] } }));
    expect(setClaudeBypass("global", false, false).changed).toBe(true);
    expect(read(GLOBAL).permissions).toEqual({ deny: ["Bash(make deploy)"] });
});
