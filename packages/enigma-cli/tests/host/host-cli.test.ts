/**
 * The machine-facing CLI surface end to end: one JSON document on stdout, the stable error shape,
 * no prompts, and no dependency on a home directory.
 * Run alone: bun test tests/host/host-cli.test.ts
 */
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";

const ENTRY = resolve(import.meta.dir, "..", "..", "src", "bin", "enigma.ts");
const PKG = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version: string; };

/** Run the CLI with stdin closed (never a TTY) in `home`. `home: null` points HOME at nothing. */
function cli(args: string[], home: string | null): { status: number | null; stdout: string; stderr: string; json: any; } {
    const dir = home ?? mkdtempSync(join(tmpdir(), "enigma-nohome-cwd-"));
    const missing = join(dir, "does-not-exist");
    const h = home ?? missing;
    const env = { ...process.env, HOME: h, USERPROFILE: h, ENIGMA_CONFIG_HOME: h, ENIGMA_OFFLINE: "1", ENIGMA_VERSION: "" };
    const run = spawnSync("bun", [ENTRY, ...args], { cwd: dir, env, encoding: "utf8", input: "", shell: process.platform === "win32" });
    let json: unknown = null;
    try { json = JSON.parse(run.stdout); } catch { /* not JSON */ }
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

test("skills list --json works with no home: versioned envelope, nothing disabled", () => {
    const r = cli(["skills", "list", "--json"], null);
    expect(r.status).toBe(0);
    expect(r.json.schemaVersion).toBe(1);
    expect(r.json.enigmaVersion).toBe(PKG.version);
    expect(r.json.skills.length).toBeGreaterThan(10);
    for (const s of r.json.skills) {
        expect(Object.keys(s)).toEqual(expect.arrayContaining(["name", "description", "version", "provider", "disableable", "disabled"]));
        expect(s.disabled).toBe(false);
    }
});

test("skills list --json <agent> reflects that agent's opt-outs", () => {
    const home = mkdtempSync(join(tmpdir(), "enigma-host-cli-"));
    expect(cli(["skills", "disable", "git-policy", "ci-policy", "codex", "--json"], home).status).toBe(0);
    const codex = cli(["skills", "list", "--json", "codex"], home).json.skills;
    const claude = cli(["skills", "list", "--json", "claude"], home).json.skills;
    expect(codex.filter((s: any) => s.disabled).map((s: any) => s.name).sort()).toEqual(["ci-policy", "git-policy"]);
    expect(claude.filter((s: any) => s.disabled)).toEqual([]);
});

test("skills disable with one unknown name changes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "enigma-host-cli-"));
    const r = cli(["skills", "disable", "git-policy", "no-such-skill", "--json"], home);
    expect(r.status).toBe(1);
    expect(r.json.error.code).toBe("unknown_skill");
    expect(cli(["skills", "list", "--json"], home).json.skills.some((s: any) => s.disabled)).toBe(false);
});

test("config --json works with no home and reports defaults", () => {
    const r = cli(["config", "--json"], null);
    expect(r.status).toBe(0);
    expect(r.json.source).toBe("defaults");
    // enigma's own settings sit at their defaults; an external one reports its tool's own state.
    for (const s of r.json.settings.filter((x: any) => x.storage === "enigma")) expect(s.current).toEqual(s.default);
    // --defaults reads nothing at all: every current is its default, externals included.
    for (const s of cli(["config", "--json", "--defaults"], null).json.settings) expect(s.current).toEqual(s.default);
});

test("config set and config apply write in one process; a bad batch writes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "enigma-host-cli-"));
    const bad = cli(["config", "set", "gate=off", "relay-at=banana", "--json"], home);
    expect(bad.status).toBe(1);
    expect(bad.json.error.code).toBe("invalid_batch");
    expect(cli(["config", "--json"], home).json.settings.find((s: any) => s.key === "gate").current).toBe(true);

    expect(cli(["config", "set", "gate=off", "output-style=lite", "--json"], home).status).toBe(0);
    writeFileSync(join(home, "s.json"), JSON.stringify({ "minimal-code": "ultra", verify: false }));
    const applied = cli(["config", "apply", "--file", join(home, "s.json"), "--json"], home);
    expect(applied.json.applied.length).toBe(2);
    const now = Object.fromEntries(cli(["config", "--json"], home).json.settings.map((s: any) => [s.key, s.current]));
    expect([now.gate, now["output-style"], now["minimal-code"], now.verify]).toEqual([false, "lite", "ultra", false]);
});

test("memory render --json is deterministic for a version and settings", () => {
    const a = cli(["memory", "render", "--target", "generic", "--compact", "--json"], null).json;
    const b = cli(["memory", "render", "--target", "generic", "--compact", "--json"], null).json;
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.byteLength(a.text)).toBe(a.bytes);
});

test("usage errors under --json use the error shape and never prompt", () => {
    for (const [args, code] of [
        [["config", "--bogus", "--json"], "unknown_option"],
        [["memory", "render", "--target", "chat", "--json"], "invalid_target"],
        [["serve", "--json"], "usage"],
        [["serve", "--http", "--data-dir", "x", "--token-file", "nope", "--json"], "invalid_token_file"],
        [["config", "apply", "--json"], "usage"],
    ] as const) {
        const r = cli([...args], null);
        expect(r.status).not.toBe(0);
        expect(r.json?.error?.code).toBe(code);
        expect(typeof r.json.error.message).toBe("string");
    }
});
