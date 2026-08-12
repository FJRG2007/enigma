/**
 * Dashboard memory editor engine (skills.ts): listing memory groups for a project,
 * saving a custom edit (which marks the file edited so the overwrite/keep policy can
 * preserve it), reading it back, and resetting to the managed render. Project scope is
 * used because it does not depend on which agents are installed on the host. Runs against
 * a temp HOME (set BEFORE importing - skills.ts resolves the sync-state path at import).
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-memory-edit-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { listMemoryGroups, readMemoryGroup, saveMemoryGroup, resetMemoryGroup } = await import("../src/skills");

const PROJECT = mkdtempSync(join(tmpdir(), "enigma-memory-proj-"));

afterAll(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(PROJECT, { recursive: true, force: true }); });

test("project memory groups dedupe by file (claude=CLAUDE.md, the AGENTS.md agents share one)", () => {
    const groups = listMemoryGroups(PROJECT);
    const claude = groups.find((g) => g.file === "CLAUDE.md");
    const agents = groups.find((g) => g.file === "AGENTS.md");
    expect(claude).toBeTruthy();
    expect(agents).toBeTruthy();
    // codex, kimi and opencode all read <project>/AGENTS.md, so the file appears once with all of them.
    expect(agents!.agents.map((a) => a.name).sort()).toEqual(["codex", "kimi", "opencode"]);
    expect(claude!.deployed).toBe(false); // nothing written yet
});

test("save marks the file edited; read returns it; reset restores the managed version", () => {
    const custom = "# My project rules\n\nDo the thing.\n";
    const res = saveMemoryGroup("claude", custom, PROJECT);
    expect(res.ok).toBe(true);
    expect(res.labels).toContain("Claude Code");

    const dest = join(PROJECT, "CLAUDE.md");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe(custom);
    expect(readMemoryGroup("claude", PROJECT)).toBe(custom);

    const after = listMemoryGroups(PROJECT).find((g) => g.file === "CLAUDE.md")!;
    expect(after.deployed).toBe(true);
    expect(after.edited).toBe(true); // the keep policy can now preserve it

    // Reset restores enigma's managed render and clears the edit marker.
    const reset = resetMemoryGroup("claude", PROJECT);
    expect(reset.ok).toBe(true);
    expect(readFileSync(dest, "utf8")).not.toBe(custom);
    const restored = listMemoryGroups(PROJECT).find((g) => g.file === "CLAUDE.md")!;
    expect(restored.edited).toBe(false);
    expect(restored.managed).toBe(true);
});

test("a shared AGENTS.md edit reports every agent that reads it", () => {
    const res = saveMemoryGroup("codex", "# shared agents memory\n", PROJECT);
    expect(res.ok).toBe(true);
    expect(res.labels.sort()).toEqual(["Kimi Code", "OpenAI Codex", "OpenCode"]);
    expect(existsSync(join(PROJECT, "AGENTS.md"))).toBe(true);
});
