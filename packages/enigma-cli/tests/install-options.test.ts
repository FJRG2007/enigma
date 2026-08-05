/**
 * Install options that exist for automated environments: which hook classes an install is
 * allowed to wire (`--hooks` / `--no-hooks`), and reading the assets from a staged tree
 * (`--assets-from`). Both are the difference between "enigma installs skills here" and
 * "enigma also writes into settings a harness already owns / reaches the network".
 */
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { HOOK_CLASSES, parseHookClasses, useAssetsFrom, assetsRoot, inspectSkills } from "../src/skills";

test("parseHookClasses reads all / none / a subset, and rejects an unknown class", () => {
    expect(parseHookClasses("all")).toEqual([...HOOK_CLASSES]);
    expect(parseHookClasses("none")).toEqual([]);
    expect(parseHookClasses("")).toEqual([]);
    expect(parseHookClasses("post-edit")).toEqual(["post-edit"]);
    expect(parseHookClasses(" STOP , post-edit ")).toEqual(["stop", "post-edit"]); // trimmed, case-free
    // `none` anywhere wins: the safe reading of a contradictory list is to write nothing.
    expect(parseHookClasses("post-edit,none")).toEqual([]);
    expect(() => parseHookClasses("pre-commit")).toThrow(/Unknown hook class 'pre-commit'/);
});

test("--assets-from installs from a staged tree, and refuses one that is not an assets tree", () => {
    const original = assetsRoot();
    const staged = mkdtempSync(join(tmpdir(), "enigma-staged-assets-"));
    try {
        // A directory that is not an assets tree must fail loudly: silently installing
        // nothing is the failure mode a staged tree exists to avoid.
        expect(() => useAssetsFrom(staged)).toThrow(/No skills directory/);

        mkdirSync(join(staged, "skills", "only-policy"), { recursive: true });
        writeFileSync(join(staged, "skills", "only-policy", "SKILL.md"), "---\nname: only-policy\n---\n\nBody.\n");
        const meta = { name: "only-policy", version: "1.0.0", provider: "FJRG2007/enigma" };
        writeFileSync(join(staged, "skills", "only-policy", "skill.json"), `${JSON.stringify(meta, null, 2)}\n`);

        useAssetsFrom(staged);
        expect(assetsRoot()).toBe(resolve(staged));
        // The staged tree is the whole source; the bundled skills are not merged in.
        expect(inspectSkills().map((s) => s.name)).toEqual(["only-policy"]);
    } finally {
        useAssetsFrom(original);
        rmSync(staged, { recursive: true, force: true });
    }
});

test("a populated remote cache reaches neither a staged tree nor an offline run", async () => {
    const { computeContentSha } = await import("../src/util");
    const original = assetsRoot();
    const home = mkdtempSync(join(tmpdir(), "enigma-cache-home-"));
    const staged = mkdtempSync(join(tmpdir(), "enigma-staged-assets-"));
    const prev = {
        home: process.env.HOME, profile: process.env.USERPROFILE,
        config: process.env.ENIGMA_CONFIG_HOME, offline: process.env.ENIGMA_OFFLINE,
    };
    try {
        process.env.HOME = home; process.env.USERPROFILE = home; process.env.ENIGMA_CONFIG_HOME = home;
        delete process.env.ENIGMA_OFFLINE;

        // Exactly what one earlier online install leaves behind: a verified GitHub cache entry.
        const cached = join(home, ".enigma", "skills-cache", "skills", "cached-policy");
        mkdirSync(cached, { recursive: true });
        writeFileSync(join(cached, "SKILL.md"), "---\nname: cached-policy\n---\n\nFetched from GitHub.\n");
        const cachedMeta = { name: "cached-policy", version: "9.9.9", provider: "FJRG2007/enigma", sha: computeContentSha(cached) };
        writeFileSync(join(cached, "skill.json"), `${JSON.stringify(cachedMeta, null, 2)}\n`);
        // Baseline: online, bundled assets - the overlay is live, so the entry IS in the plan.
        // Without it the two assertions below would pass on an empty cache and prove nothing.
        expect(inspectSkills().map((s) => s.name)).toContain("cached-policy");

        mkdirSync(join(staged, "skills", "only-policy"), { recursive: true });
        writeFileSync(join(staged, "skills", "only-policy", "SKILL.md"), "---\nname: only-policy\n---\n\nBody.\n");
        const meta = { name: "only-policy", version: "1.0.0", provider: "FJRG2007/enigma" };
        writeFileSync(join(staged, "skills", "only-policy", "skill.json"), `${JSON.stringify(meta, null, 2)}\n`);

        // A staged tree is the whole source: stopping the fetch is not enough when a cache
        // is already on disk, and "Skills source: bundled with enigma-cli X" would be a lie.
        useAssetsFrom(staged);
        expect(inspectSkills().map((s) => s.name)).toEqual(["only-policy"]);
        useAssetsFrom(original);

        // Offline, bundled assets: nothing fetched from GitHub may reach the plan either.
        process.env.ENIGMA_OFFLINE = "1";
        expect(inspectSkills().map((s) => s.name)).not.toContain("cached-policy");
    } finally {
        useAssetsFrom(original);
        for (const [key, value] of [["HOME", prev.home], ["USERPROFILE", prev.profile], ["ENIGMA_CONFIG_HOME", prev.config], ["ENIGMA_OFFLINE", prev.offline]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(staged, { recursive: true, force: true });
    }
});

test("the adopted count is what the plan took, not what the cache happens to hold", async () => {
    const { computeContentSha } = await import("../src/util");
    const { adoptedRemoteSkills } = await import("../src/skills");
    const home = mkdtempSync(join(tmpdir(), "enigma-adopted-home-"));
    const prev = {
        home: process.env.HOME, profile: process.env.USERPROFILE,
        config: process.env.ENIGMA_CONFIG_HOME, offline: process.env.ENIGMA_OFFLINE,
    };
    const seal = (dir: string, name: string, version: string): void => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\nFetched from GitHub.\n`);
        const meta = { name, version, provider: "FJRG2007/enigma", sha: computeContentSha(dir) };
        writeFileSync(join(dir, "skill.json"), `${JSON.stringify(meta, null, 2)}\n`);
    };
    try {
        process.env.HOME = home; process.env.USERPROFILE = home; process.env.ENIGMA_CONFIG_HOME = home;
        delete process.env.ENIGMA_OFFLINE;
        expect(adoptedRemoteSkills()).toEqual([]); // empty cache

        // A cache entry the bundle has caught up with. It stays on disk until a refresh
        // prunes it, and a run inside the check throttle performs no refresh - so counting
        // cache entries reported "N skill(s) over the bundle" for a purely bundled install.
        const cacheDir = join(home, ".enigma", "skills-cache", "skills");
        const bundled = inspectSkills()[0]!;
        seal(join(cacheDir, bundled.name), bundled.name, "0.0.1");
        expect(adoptedRemoteSkills()).toEqual([]);
        expect(inspectSkills().find((s) => s.name === bundled.name)!.src).toBe(bundled.src);

        // A skill this package does not bundle IS adopted, and is counted.
        seal(join(cacheDir, "cached-policy"), "cached-policy", "1.0.0");
        expect(adoptedRemoteSkills()).toEqual(["cached-policy"]);
    } finally {
        for (const [key, value] of [["HOME", prev.home], ["USERPROFILE", prev.profile], ["ENIGMA_CONFIG_HOME", prev.config], ["ENIGMA_OFFLINE", prev.offline]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    }
});

test("--offline stands every outbound call down, including the detached ones", async () => {
    const { isOffline } = await import("../src/util");
    const { shouldCheckRemote } = await import("../src/skills-remote");
    const prev = process.env.ENIGMA_OFFLINE;
    try {
        delete process.env.ENIGMA_OFFLINE;
        expect(isOffline()).toBe(false);

        process.env.ENIGMA_OFFLINE = "1";
        expect(isOffline()).toBe(true);
        // Even `force`, which normally bypasses the throttle, must not reach GitHub.
        expect(shouldCheckRemote(true)).toBe(false);
    } finally {
        if (prev === undefined) delete process.env.ENIGMA_OFFLINE; else process.env.ENIGMA_OFFLINE = prev;
    }
});
