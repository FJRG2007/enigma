/**
 * Kimi Code wiring: the workdir key enigma computes for a trust document, the trust write
 * itself, the `[[hooks]]` merge into config.toml, and the permission-bypass key.
 *
 * The workdir-key case is pinned against a key Kimi Code itself wrote (kimi 0.35.0, Windows):
 * a document filed under any other name is one Kimi never reads, so a silent drift here would
 * turn the whole pre-answer into a no-op that still reports success.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-kimi-"));
// ENIGMA_CONFIG_HOME is what kimi.ts resolves the data root against, and it is the only one
// that holds on every runtime: bun on Linux does not reflect a reassigned $HOME through
// os.homedir(), so a test that set HOME alone passed on Windows and failed in CI.
const priorConfigHome = process.env.ENIGMA_CONFIG_HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { encodeWorkDirKey, kimiTrustPath, trustKimiWorkspace, isKimiWorkspaceTrusted } = await import("../src/kimi");
const { applyKimiHook } = await import("../src/kimi-hooks");
const { applyKimiTrimHook } = await import("../src/trim-deploy");

afterAll(() => {
    // Every test file in this repo points the env at its own temp dir on import, so whichever
    // ran last would otherwise decide where a LATER file resolves its paths.
    if (priorConfigHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorConfigHome;
    rmSync(HOME, { recursive: true, force: true });
});

test("encodeWorkDirKey matches the key Kimi Code writes itself", () => {
    // Observed: ~/.kimi-code/workspace-trust/wd_portfolio_935eec9160da for this directory.
    expect(encodeWorkDirKey("C:\\Users\\admin\\Documents\\DEV\\FJRG2007\\portfolio"))
        .toBe("wd_portfolio_935eec9160da");
    // Same directory, already slash-normalized or with a trailing separator: one key.
    expect(encodeWorkDirKey("C:/Users/admin/Documents/DEV/FJRG2007/portfolio/"))
        .toBe("wd_portfolio_935eec9160da");
});

test("a name that is not slug-safe still yields a usable key", () => {
    const key = encodeWorkDirKey("C:\\work\\My Project (v2)");
    expect(key.startsWith("wd_my-project-v2_")).toBe(true);
    expect(key).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
});

test("trusting a workspace writes Kimi's own document shape, once", () => {
    const home = join(HOME, ".kimi-code");
    const project = join(HOME, "proj");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });

    expect(isKimiWorkspaceTrusted(home, project)).toBe(false);
    expect(trustKimiWorkspace(home, project)).toBe(true);
    expect(isKimiWorkspaceTrusted(home, project)).toBe(true);
    expect(trustKimiWorkspace(home, project)).toBe(false); // idempotent

    const doc = JSON.parse(readFileSync(kimiTrustPath(home, project), "utf8"));
    expect(doc.root).toBe(project);
    expect(typeof doc.trustedAt).toBe("number");
});

test("never creates a data root for a Kimi that has never run", () => {
    const home = join(HOME, "absent-kimi");
    expect(trustKimiWorkspace(home, HOME)).toBe(false);
    expect(existsSync(home)).toBe(false);
});

test("adds and removes a [[hooks]] rule idempotently, keeping the rest of config.toml", () => {
    const config = join(HOME, "config.toml");
    writeFileSync(config, "default_model = \"kimi-code/k3\"\n\n[thinking]\neffort = \"high\"\n");

    expect(applyKimiTrimHook(config, true)).toBe(true);
    const written = readFileSync(config, "utf8");
    expect(written).toContain("[[hooks]]");
    expect(written).toContain("event = \"PostToolUse\"");
    expect(written).toContain("matcher = \"Write|Edit\"");
    expect(written).toContain("enigma __trim-hook");
    // Everything the user had is still there, values intact.
    expect(written).toContain("default_model = \"kimi-code/k3\"");
    expect(written).toContain("[thinking]");
    expect(written).toContain("effort = \"high\"");
    // Only the four fields Kimi accepts in a hook rule.
    expect(written).not.toContain("type = ");

    expect(applyKimiTrimHook(config, true)).toBe(false); // fixed point
    expect(applyKimiTrimHook(config, false)).toBe(true);
    const after = readFileSync(config, "utf8");
    expect(after).not.toContain("[[hooks]]");
    expect(after).toContain("default_model = \"kimi-code/k3\"");
    expect(after).toContain("effort = \"high\"");
});

test("leaves a user's own hook rule alone", () => {
    const config = join(HOME, "user-hooks.toml");
    writeFileSync(config, "[[hooks]]\nevent = \"PreToolUse\"\nmatcher = \"Bash\"\ncommand = \"node check.mjs\"\n");

    applyKimiTrimHook(config, true);
    let content = readFileSync(config, "utf8");
    expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(2);

    applyKimiTrimHook(config, false);
    content = readFileSync(config, "utf8");
    expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(1);
    expect(content).toContain("node check.mjs");
});

test("never creates a config file just to record the absence of a hook", () => {
    const config = join(HOME, "never-written.toml");
    expect(applyKimiHook(config, "__trim-hook", { event: "PostToolUse", command: "enigma __trim-hook" }, false)).toBe("unchanged");
    expect(existsSync(config)).toBe(false);
});

test("permission bypass writes Kimi's yolo mode and removes it again", async () => {
    const { setBypass, getBypass, BYPASS_SUPPORTED, BYPASS_GLOBAL_ONLY } = await import("../src/permissions");
    expect(BYPASS_SUPPORTED).toContain("kimi");
    expect(BYPASS_GLOBAL_ONLY.kimi).toBe("~/.kimi-code/config.toml");

    const config = join(HOME, ".kimi-code", "config.toml");
    mkdirSync(join(HOME, ".kimi-code"), { recursive: true });
    writeFileSync(config, "default_model = \"kimi-code/k3\"\n");
    expect(getBypass("kimi", "global")).toBe(false);
    expect(setBypass("kimi", "global", true, false)?.changed).toBe(true);
    expect(readFileSync(config, "utf8")).toContain("default_permission_mode = \"yolo\"");
    expect(getBypass("kimi", "global")).toBe(true);
    // A local scope has nowhere else to go: it is the same global file, not a silent no-op.
    expect(setBypass("kimi", "local", false, false)?.path).toBe(config);
    expect(readFileSync(config, "utf8")).not.toContain("default_permission_mode");
    expect(readFileSync(config, "utf8")).toContain("default_model");
});
