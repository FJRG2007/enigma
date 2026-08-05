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
