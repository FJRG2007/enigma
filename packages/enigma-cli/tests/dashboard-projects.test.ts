/**
 * Per-project dashboard management: registry CRUD, project-local config writes, and
 * per-project skill deploy/remove - all path-scoped, never touching process.cwd().
 * ENIGMA_CONFIG_HOME (set BEFORE import) anchors the registry + agent dirs to a temp
 * home (enigmaHome / os.homedir() ignores a runtime $HOME on bun/Linux). The two spawn
 * actions (git hooks, gate init/eject) are deliberately not tested here - like the
 * resources killers, they would run the real CLI/git; only the pure logic is covered.
 * Must run under Bun: bun test tests/dashboard-projects.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-projects-"));
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// Make Claude Code count as "installed" so per-project skill deploy has a target agent.
mkdirSync(join(HOME, ".claude"), { recursive: true });

const PROJECT = mkdtempSync(join(tmpdir(), "enigma-proj-"));

const { listProjects, addProject, removeProject, projectDetail, applyProjectAction } = await import("../src/dashboard-projects");
const { readProjectConfig } = await import("../src/config");

afterAll(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(PROJECT, { recursive: true, force: true }); });

test("addProject rejects a non-directory and accepts a real one (idempotent)", () => {
    expect(addProject(join(HOME, "does-not-exist")).ok).toBe(false);
    const out = addProject(PROJECT, "My Project");
    expect(out.ok).toBe(true);
    expect(out.projects.some((p) => p.path === PROJECT && p.label === "My Project")).toBe(true);
    addProject(PROJECT); // dedupe
    expect(listProjects().filter((p) => p.path === PROJECT).length).toBe(1);
});

test("project-local config writes to the project's .enigma.json and can be unset", async () => {
    await applyProjectAction(PROJECT, { op: "config-set", key: "gate", value: true });
    expect(readProjectConfig(PROJECT).gate).toBe(true);
    const detail = projectDetail(PROJECT) as { config: { key: string; value: boolean; overridden: boolean }[] };
    expect(detail.config.find((c) => c.key === "gate")).toMatchObject({ value: true, overridden: true });

    await applyProjectAction(PROJECT, { op: "config-unset", key: "gate" });
    expect("gate" in readProjectConfig(PROJECT)).toBe(false);
});

test("an invalid choice value is rejected", async () => {
    const out = await applyProjectAction(PROJECT, { op: "config-set", key: "output-style", value: "bogus" });
    expect(out.ok).toBe(false);
});

test("per-project skill enable/disable deploys then removes the skill dir", async () => {
    const detail = projectDetail(PROJECT) as { available: { name: string }[] };
    const skill = detail.available[0]?.name;
    expect(typeof skill).toBe("string");

    const on = await applyProjectAction(PROJECT, { op: "skill", name: skill, on: true });
    expect(on.ok).toBe(true);
    expect(existsSync(join(PROJECT, ".claude", "skills", skill))).toBe(true);

    const off = await applyProjectAction(PROJECT, { op: "skill", name: skill, on: false });
    expect(off.ok).toBe(true);
    expect(existsSync(join(PROJECT, ".claude", "skills", skill))).toBe(false);
});

test("detail/action refuse an unregistered path", async () => {
    const stray = mkdtempSync(join(tmpdir(), "enigma-stray-"));
    expect("error" in projectDetail(stray)).toBe(true);
    expect((await applyProjectAction(stray, { op: "config-set", key: "gate", value: true })).ok).toBe(false);
    rmSync(stray, { recursive: true, force: true });
});

test("removeProject drops it from the registry", () => {
    removeProject(PROJECT);
    expect(listProjects().some((p) => p.path === PROJECT)).toBe(false);
});
