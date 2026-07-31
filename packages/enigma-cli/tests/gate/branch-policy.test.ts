/**
 * Which branches the gate will validate. The rule used to be hardcoded ("never the default
 * branch"); it is now the `gate-protected-branches` list, empty by default, so a run starts on
 * whatever branch the work is on. Two layers are covered: the pure match `preflightGuard` calls,
 * and the scoped list writes the CLI/TUI/dashboard perform.
 *
 * Temp HOME (set BEFORE the import) isolates ~/.enigma.json; the local scope resolves against
 * process.cwd(), so those cases run inside a temp dir and the cwd is always restored.
 * Must run under Bun: bun test tests/gate/branch-policy.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gate-branch-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const PROJECT = mkdtempSync(join(tmpdir(), "enigma-gate-project-"));
const CWD = process.cwd();
// bun test shares one process across files: leaving this pinned would send the NEXT file's
// global-config writes into this temp dir.
const PRIOR_CONFIG_HOME = process.env.ENIGMA_CONFIG_HOME;

const { isProtectedBranch } = await import("../../src/gate/cli/axiDrive");
const { readConfig, readEnigmaList, updateEnigmaList, CONFIG_DEFAULTS } = await import("../../src/config");

afterAll(() => {
    process.chdir(CWD);
    if (PRIOR_CONFIG_HOME === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = PRIOR_CONFIG_HOME;
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJECT, { recursive: true, force: true });
});

test("no branch is protected out of the box", () => {
    expect(CONFIG_DEFAULTS.gateProtectedBranches).toEqual([]);
    // The regression this pins: `main` was refused unconditionally, so a run on the branch the
    // user actually works on exited in two seconds and looked like the gate had been skipped.
    expect(isProtectedBranch("main", [])).toBe(false);
    expect(isProtectedBranch("feat/x", [])).toBe(false);
});

test("a protected branch matches by exact name, never by prefix", () => {
    expect(isProtectedBranch("main", ["main"])).toBe(true);
    expect(isProtectedBranch("main", ["  main  "])).toBe(true);
    expect(isProtectedBranch(" main ", ["main"])).toBe(true);
    expect(isProtectedBranch("main", ["master", "main"])).toBe(true);

    // A protected `main` must not drag unrelated branches in with it.
    expect(isProtectedBranch("mainline", ["main"])).toBe(false);
    expect(isProtectedBranch("feat/main", ["main"])).toBe(false);
    expect(isProtectedBranch("Main", ["main"])).toBe(false);
    // No glob support: an entry that looks like a pattern protects that literal name only.
    expect(isProtectedBranch("release/1.2", ["release/*"])).toBe(false);
    // A detached HEAD or an empty entry must not match anything.
    expect(isProtectedBranch("", ["main"])).toBe(false);
    expect(isProtectedBranch("main", [""])).toBe(false);
});

test("the global list round-trips through add and remove", () => {
    expect(readEnigmaList("gateProtectedBranches", "global")).toEqual([]);

    updateEnigmaList("gateProtectedBranches", "main", true, "global");
    updateEnigmaList("gateProtectedBranches", "release", true, "global");
    // Adding twice is idempotent: the list is a set, not an append log.
    updateEnigmaList("gateProtectedBranches", "main", true, "global");
    expect(readEnigmaList("gateProtectedBranches", "global")).toEqual(["main", "release"]);
    expect(readConfig().config.gateProtectedBranches).toEqual(["main", "release"]);

    updateEnigmaList("gateProtectedBranches", "release", false, "global");
    expect(readEnigmaList("gateProtectedBranches", "global")).toEqual(["main"]);
    // Removing an entry that was never there is a no-op rather than an error.
    updateEnigmaList("gateProtectedBranches", "nope", false, "global");
    expect(readEnigmaList("gateProtectedBranches", "global")).toEqual(["main"]);
});

test("a project's own list replaces the global one instead of extending it", () => {
    process.chdir(PROJECT);
    updateEnigmaList("gateProtectedBranches", "wip", true, "local");

    // The project file holds only what the project set - a local edit must never absorb the
    // global list, or removing an entry locally would silently re-add it everywhere else.
    expect(readEnigmaList("gateProtectedBranches", "local")).toEqual(["wip"]);
    expect(JSON.parse(readFileSync(join(PROJECT, ".enigma.json"), "utf8")).gateProtectedBranches).toEqual(["wip"]);
    expect(readEnigmaList("gateProtectedBranches", "global")).toEqual(["main"]);

    // What the gate reads is the merged view, nearest-wins: here `main` is fair game again.
    const effective = readConfig().config.gateProtectedBranches;
    expect(effective).toEqual(["wip"]);
    expect(isProtectedBranch("main", effective)).toBe(false);
    expect(isProtectedBranch("wip", effective)).toBe(true);
    process.chdir(CWD);
});
