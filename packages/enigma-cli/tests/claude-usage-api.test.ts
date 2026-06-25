/**
 * Active usage probe: the deterministic, network-free parts. readOAuthToken reads the local
 * Claude Code credentials (default account preferred, expired tokens skipped) and never
 * touches the network; maybeProbeUsage only fires when the feature is on, a token exists, and
 * the throttle has elapsed - so the gating is asserted by whether it stamps an attempt, never
 * by making a real call. Temp HOME + CLAUDE_CONFIG_DIR (set BEFORE import) isolate everything.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-usageapi-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
const CLAUDE_DIR = join(HOME, ".claude");
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
const PROXY_DIR = join(HOME, ".enigma", "proxy");
process.env.ENIGMA_PROXY_DIR = PROXY_DIR;
mkdirSync(CLAUDE_DIR, { recursive: true });
mkdirSync(PROXY_DIR, { recursive: true });

const { readOAuthToken, maybeProbeUsage } = await import("../src/claude-usage-api");
const { setEnigmaValue } = await import("../src/config");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const credPath = join(CLAUDE_DIR, ".credentials.json");
const stampPath = join(PROXY_DIR, "probe.json");
const writeCreds = (accessToken: string, expiresAt: number): void =>
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } }));

test("readOAuthToken returns null with no credentials file", () => {
    rmSync(credPath, { force: true });
    expect(readOAuthToken()).toBeNull();
});

test("readOAuthToken reads a valid (unexpired) token", () => {
    const now = 1_000_000;
    writeCreds("sk-ant-oat-test", now + 3_600_000);
    const tok = readOAuthToken(now);
    expect(tok).not.toBeNull();
    expect(tok!.token).toBe("sk-ant-oat-test");
    expect(tok!.account).toBe("default");
});

test("readOAuthToken skips an expired token", () => {
    const now = 2_000_000;
    writeCreds("sk-ant-oat-old", now - 1); // already past
    expect(readOAuthToken(now)).toBeNull();
});

test("maybeProbeUsage is a no-op (no probe stamp) when the feature is off", () => {
    rmSync(stampPath, { force: true });
    writeCreds("sk-ant-oat-test", Date.now() + 3_600_000);
    setEnigmaValue("usageApi", false, "global");
    setEnigmaValue("usageStats", true, "global");
    maybeProbeUsage();
    expect(existsSync(stampPath)).toBe(false);
});

test("maybeProbeUsage respects the throttle (does not re-stamp within the interval)", () => {
    const fresh = Date.now();
    writeFileSync(stampPath, JSON.stringify({ at: fresh }));
    writeCreds("sk-ant-oat-test", Date.now() + 3_600_000);
    setEnigmaValue("usageApi", true, "global");
    setEnigmaValue("usageStats", true, "global");
    maybeProbeUsage();
    // Still throttled: the stamp is unchanged and no network call was made.
    expect(Number(JSON.parse(readFileSync(stampPath, "utf8")).at)).toBe(fresh);
});
