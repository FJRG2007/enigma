/**
 * The `enigma update` delivery path. Assets (skills, memory, commands) are bundled INTO the
 * binary, so the sync `enigma update` runs before npm replaces that binary can only deploy the
 * OLD ones. The fix is the hidden `__sync` command, which the update spawns on the NEWLY
 * installed binary; this exercises it end to end against a temp HOME with a fabricated global
 * Claude deployment, and asserts the file that lands is this version's asset.
 *
 * Must run under Bun: bun test tests/update-sync.test.ts
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");
const HOME = mkdtempSync(join(tmpdir(), "enigma-update-sync-"));

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("__sync deploys this version's assets into an existing deployment", () => {
    // One managed skill in the global skills dir is what hasDeployment looks for.
    const skills = join(HOME, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    cpSync(join(ASSETS, "skills", "git-policy"), join(skills, "git-policy"), { recursive: true });
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");

    const run = spawnSync(process.execPath, [join(ROOT, "src", "bin", "enigma.ts"), "__sync"], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, HOME, USERPROFILE: HOME, ENIGMA_CONFIG_HOME: HOME },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("item(s) updated");
    // The point of the command: the deployed copy is byte-identical to the asset shipped by the
    // version that ran it, so an updated CLI never leaves the previous release's policies behind.
    for (const skill of ["validation-policy", "frontend-policy", "database-expert"]) {
        expect(readFileSync(join(skills, skill, "SKILL.md"), "utf8"))
            .toBe(readFileSync(join(ASSETS, "skills", skill, "SKILL.md"), "utf8"));
    }
});

test("a home with no deployment is left untouched", () => {
    const empty = mkdtempSync(join(tmpdir(), "enigma-update-sync-empty-"));
    const run = spawnSync(process.execPath, [join(ROOT, "src", "bin", "enigma.ts"), "__sync"], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, HOME: empty, USERPROFILE: empty, ENIGMA_CONFIG_HOME: empty },
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("");
    rmSync(empty, { recursive: true, force: true });
});
