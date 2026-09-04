/**
 * Auto-lint wiring: the toggle must write the shared runner, reconcile Claude's ONE merged
 * post-edit entry and add/remove the opencode plugin, idempotently and without clobbering
 * unrelated config. Claude has no lint entry of its own any more - the merged hook lints -
 * so what is pinned here is that none is written and that turning auto-lint off leaves the
 * merged entry alone while trim, guardrails or the graph still need it. Runs against a temp HOME (set BEFORE import, since
 * the module resolves paths at load). ENIGMA_LINT_DIR points at a stub install so
 * the background npm install never spawns during the test.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const PRIOR_ENV = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, ENIGMA_LINT_DIR: process.env.ENIGMA_LINT_DIR };
const HOME = mkdtempSync(join(tmpdir(), "enigma-lint-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_LINT_DIR = join(HOME, "lintdir");

// Stub the managed install so isLinterInstalled() is true (no npm, no spawn).
mkdirSync(join(HOME, "lintdir", "node_modules", "@enigmax", "linter"), { recursive: true });
writeFileSync(join(HOME, "lintdir", "node_modules", "@enigmax", "linter", "package.json"), "{}");

const lint = await import("../src/lint");

const claudeSettings = join(HOME, ".claude", "settings.json");
const opencodePlugin = join(HOME, ".config", "opencode", "plugins", "enigma-lint.js");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8"));

beforeAll(() => {
    // A pre-existing unrelated hook that must survive our enable/disable.
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    writeFileSync(claudeSettings, JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    }, null, 2) + "\n");
});

afterAll(() => {
    // Restore env so later test files don't inherit a HOME pointing at a deleted dir.
    for (const [key, value] of Object.entries(PRIOR_ENV)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(HOME, { recursive: true, force: true });
});

test("enabling auto-lint writes the runner and the merged entry, never a lint entry", () => {
    lint.setAutoLint("global", true);
    expect(lint.isAutoLintOn()).toBe(true);
    expect(existsSync(lint.LINT_RUNNER_PATH)).toBe(true);

    const groups = readJson(claudeSettings).hooks.PostToolUse as any[];
    const merged = groups.find((g) => g.hooks?.some((h: any) => h.command?.includes("__post-edit-hook")));
    expect(merged?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    // A second entry is a second process per edit, which is the whole reason the step moved.
    expect(groups.some((g) => g.hooks?.some((h: any) => h.command?.includes("lint-hook.mjs")))).toBe(false);
    // The unrelated Bash hook is preserved.
    expect(groups.some((g) => g.matcher === "Bash")).toBe(true);

    expect(existsSync(opencodePlugin)).toBe(true);
    expect(readFileSync(opencodePlugin, "utf8")).toContain("tool.execute.after");
});

test("re-applying the wiring is idempotent (no duplicate group)", () => {
    lint.applyLintWiring();
    const groups = readJson(claudeSettings).hooks.PostToolUse as any[];
    const ours = groups.filter((g) => g.hooks?.some((h: any) => h.command?.includes("__post-edit-hook")));
    expect(ours.length).toBe(1);
});

test("disabling auto-lint keeps the entry the other three steps still need", () => {
    lint.setAutoLint("global", false);
    expect(lint.isAutoLintOn()).toBe(false);

    const groups = readJson(claudeSettings).hooks.PostToolUse as any[];
    // trim, guardrails and the graph are on by default, so the group stays: deleting it here
    // is precisely the failure that made one shared entry need one owner.
    expect(groups.some((g) => g.hooks?.some((h: any) => h.command?.includes("__post-edit-hook")))).toBe(true);
    expect(groups.some((g) => g.matcher === "Bash")).toBe(true); // unrelated hook survives
    expect(existsSync(opencodePlugin)).toBe(false);
});

test("mirrorLintWiring reconciles the merged entry in a managed account dir", () => {
    const accountDir = join(HOME, ".enigma", "claude", "work");
    lint.setAutoLint("global", true);

    lint.mirrorLintWiring("claude", accountDir);
    const groups = readJson(join(accountDir, "settings.json")).hooks.PostToolUse as any[];
    expect(groups.some((g) => g.hooks?.some((h: any) => h.command?.includes("__post-edit-hook")))).toBe(true);
    // And an account that predates the merge is migrated by the same call, rather than keeping
    // a second entry nobody looks at that goes on paying a process start per edit.
    expect(groups.some((g) => g.hooks?.some((h: any) => h.command?.includes("lint-hook.mjs")))).toBe(false);
});
