/**
 * The guard's shared detection helpers (reused by the commit guard AND the prompt
 * secret guard) and the global guard-config list persistence. These are the pure,
 * git-independent parts: glob translation, secret matching/redaction, and the
 * block/allow/secret-pattern lists written to ~/.enigma-guard.json.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegExp, buildSecretMatchers, findSecrets, redactSecrets } from "../src/guard";
import { readGlobalGuard, setGuardList, setGuardProtection } from "../src/guard-config";

// Built at runtime by concatenation so this test file does not itself trip enigma's
// own commit guard (which scans tracked files for literal credential patterns).
const ANTHRO_KEY = "sk-ant-" + "api03-" + "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

test("globToRegExp matches basenames for slash-less globs and full paths otherwise", () => {
    expect(globToRegExp("*.env.local").test("config/db.env.local")).toBe(true); // basename anchored
    expect(globToRegExp("*.env.local").test("notes.txt")).toBe(false);
    expect(globToRegExp("secrets/*.json").test("secrets/api.json")).toBe(true); // path anchored
    expect(globToRegExp("secrets/*.json").test("app/secrets/api.json")).toBe(false); // * does not cross /
    expect(globToRegExp("tests/fixtures/**").test("tests/fixtures/deep/a.key")).toBe(true); // ** crosses /
});

test("built-in matchers detect a real credential and ignore clean text", () => {
    const m = buildSecretMatchers();
    expect(findSecrets("here is " + ANTHRO_KEY, m)).toContain("Anthropic API key");
    expect(findSecrets("just a normal sentence", m)).toEqual([]);
});

test("custom patterns extend detection; bad regex sources are skipped", () => {
    const m = buildSecretMatchers(["mycorp_[a-z0-9]{8}", "((("]); // second is invalid, must not throw
    expect(findSecrets("token mycorp_abcd1234 ok", m)).toContain("custom secret");
});

test("redactSecrets replaces the secret with a labelled placeholder", () => {
    const m = buildSecretMatchers();
    const { text, hits } = redactSecrets("key=" + AWS_KEY + " done", m);
    expect(text).not.toContain(AWS_KEY);
    expect(text).toContain("[REDACTED: AWS access key id]");
    expect(hits).toContain("AWS access key id");
});

test("guard-config persists and dedupes user lists without dropping protections", () => {
    const HOME = mkdtempSync(join(tmpdir(), "enigma-guard-"));
    const prev = { home: process.env.HOME, profile: process.env.USERPROFILE };
    process.env.HOME = HOME; process.env.USERPROFILE = HOME;
    try {
        setGuardProtection("largeFiles", false);
        setGuardList("blockPaths", ["secrets/*.json", "secrets/*.json", " ", "*.local.env"]);
        setGuardList("secretPatterns", ["mycorp_[a-z0-9]{8}"]);
        const cfg = readGlobalGuard();
        expect(cfg.blockPaths).toEqual(["secrets/*.json", "*.local.env"]); // deduped + trimmed
        expect(cfg.secretPatterns).toEqual(["mycorp_[a-z0-9]{8}"]);
        expect(cfg.largeFiles).toBe(false);   // a list write must preserve the protections
        expect(cfg.secrets).toBe(true);       // untouched defaults remain on
    } finally {
        process.env.HOME = prev.home; process.env.USERPROFILE = prev.profile;
        rmSync(HOME, { recursive: true, force: true });
    }
});
