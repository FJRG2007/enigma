/**
 * `enigma config --json` and the batch writers (`config set`, `config apply`).
 * Run alone: bun test tests/host/settings-host.test.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

const home = mkdtempSync(join(tmpdir(), "enigma-settings-host-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ENIGMA_CONFIG_HOME = home;
process.env.ENIGMA_OFFLINE = "1";
process.chdir(home);

let host: typeof import("../../src/settings-host");
let registry: typeof import("../../src/settings-registry");
let settings: typeof import("../../src/settings");
let config: typeof import("../../src/config");

beforeAll(async () => {
    host = await import("../../src/settings-host");
    registry = await import("../../src/settings-registry");
    settings = await import("../../src/settings");
    config = await import("../../src/config");
});

/** Settings whose value lives in another tool's config, so they have no .enigma.json default. */
const EXTERNAL = /^(claude-attribution|claude-survey|gh-telemetry|auto-lint|guard-.+|bypass-.+)$/;

test("every registry setting and value key is described exactly once", () => {
    const rows = host.describeSettings(true);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of registry.ALL_SETTINGS) expect(keys).toContain(s.key);
    for (const k of settings.VALUE_CONFIG_KEYS) expect(keys).toContain(k);
});

test("a setting either maps to an .enigma.json default or is a known external one", () => {
    // Drift guard: a new setting whose key does not follow the kebab-to-camel convention would
    // otherwise silently report no default to the host's form.
    for (const row of host.describeSettings(true)) {
        if (row.storage === "external") expect(row.key).toMatch(EXTERNAL);
        else if (!row.secret) expect(row.default).not.toBeNull();
    }
});

test("defaults mode reports current = default and the documented field set", () => {
    for (const row of host.describeSettings(true)) {
        expect(row.current).toEqual(row.default);
        for (const field of ["key", "description", "default", "current", "scope", "kind", "storage"]) expect(row).toHaveProperty(field);
        expect(["global", "any"]).toContain(row.scope);
    }
});

test("live mode reflects a written value", () => {
    config.setEnigmaValue("outputStyle", "ultra", "global");
    const row = host.describeSettings(false).find((r) => r.key === "output-style")!;
    expect(row.current).toBe("ultra");
    expect(row.default).toBe("off");
});

test("a secret is never echoed", () => {
    const row = host.describeSettings(false).find((r) => r.key === "recall-api-key")!;
    expect(row.secret).toBe(true);
    expect(row.current).toBeNull();
    expect(row.default).toBeNull();
});

test("parsePairs splits on the first '=' and refuses a pair without one", () => {
    expect(host.parsePairs(["recall-api-base=https://x.test/v1?a=b"])).toEqual([{ key: "recall-api-base", value: "https://x.test/v1?a=b" }]);
    expect(() => host.parsePairs(["gate"])).toThrow(/not <key>=<value>/);
    expect(() => host.parsePairs([])).toThrow(/Usage/);
});

test("checkChange accepts what the single-key command accepts and nothing else", () => {
    expect(host.checkChange({ key: "gate", value: "off" })).toBeNull();
    expect(host.checkChange({ key: "gate", value: "maybe" })).toMatch(/on or off/);
    expect(host.checkChange({ key: "output-style", value: "ultra" })).toBeNull();
    expect(host.checkChange({ key: "output-style", value: "loud" })).toMatch(/one of/);
    expect(host.checkChange({ key: "relay-at", value: "banana" })).toMatch(/relay-at/);
    expect(host.checkChange({ key: "token-price", value: "-1" })).toMatch(/invalid value/);
    expect(host.checkChange({ key: "statusline-refresh", value: "61" })).toMatch(/invalid value/);
    expect(host.checkChange({ key: "guard-block-paths", value: "x" })).toMatch(/is a list/);
    expect(host.checkChange({ key: "no-such-key", value: "on" })).toMatch(/unknown config key/);
});

test("a batch with one bad pair writes nothing", async () => {
    const path = config.configFilePath("global");
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    await expect(host.applyBatch([{ key: "commit-emoji", value: "off" }, { key: "relay-at", value: "banana" }], "global", true)).rejects.toThrow(/nothing was written/);
    expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(before);
});

test("a duplicated key is refused, not last-wins", async () => {
    await expect(host.applyBatch([{ key: "gate", value: "off" }, { key: "gate", value: "on" }], "global", true)).rejects.toThrow(/more than once/);
});

test("a valid batch writes every pair in one call", async () => {
    const r = await host.applyBatch([{ key: "commit-emoji", value: "off" }, { key: "token-price", value: "3" }, { key: "minimal-code", value: "lite" }], "global", true);
    expect(r.applied.map((c) => c.key)).toEqual(["commit-emoji", "token-price", "minimal-code"]);
    const cfg = config.readConfig().config;
    expect(cfg.commitEmoji).toBe(false);
    expect(cfg.tokenPrice).toBe(3);
    expect(cfg.minimalCode).toBe("lite");
});

test("readApplyFile maps booleans to on/off and refuses non-object files", () => {
    const good = join(home, "good.json");
    writeFileSync(good, JSON.stringify({ gate: false, "token-price": 2, "output-style": "lite" }));
    expect(host.readApplyFile(good)).toEqual([{ key: "gate", value: "off" }, { key: "token-price", value: "2" }, { key: "output-style", value: "lite" }]);
    const arr = join(home, "arr.json");
    writeFileSync(arr, "[]");
    expect(() => host.readApplyFile(arr)).toThrow(/JSON object/);
    const bad = join(home, "bad.json");
    writeFileSync(bad, "{nope");
    expect(() => host.readApplyFile(bad)).toThrow(/not valid JSON/);
    const nested = join(home, "nested.json");
    writeFileSync(nested, JSON.stringify({ gate: { on: true } }));
    expect(() => host.readApplyFile(nested)).toThrow(/string, a number or true\/false/);
});
