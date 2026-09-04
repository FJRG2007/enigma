/**
 * The merged Claude PostToolUse entry: one hook entry for the three features that write after an
 * edit (trim, guardrails, the code graph's blast radius), because Claude Code starts a process per
 * entry and three starts of the ~99 MB binary per edit is what a long session feels as input lag.
 *
 * What is actually load-bearing here, and what each test is guarding:
 *  - presence is a function of the THREE toggles, not one - turning a single feature off must not
 *    delete an entry the other two are still using, which is the bug three independent writers had;
 *  - the three legacy entries are removed on every reconcile, so an install that predates the merge
 *    migrates itself and never double-spawns;
 *  - a user's own PostToolUse hook survives both directions.
 *
 * The toggles are driven through a temp ENIGMA_CONFIG_HOME rather than mocked, so the test exercises
 * the same readConfig() path the deployed reconciler uses.
 */
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-post-edit-deploy-"));
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { applyClaudePostEditHook, isPostEditHookOn } = await import("../src/post-edit-deploy");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Set the three post-edit toggles in the global .enigma.json the reconciler reads. */
function toggles(trim: boolean, guardrails: boolean, codeGraph: boolean): void {
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ trim, guardrails, codeGraph }));
}

/** The PostToolUse groups of a settings.json, or [] when it has none. */
function groups(settings: string): { matcher?: string; hooks: { command: string; timeout?: number; }[]; }[] {
    if (!existsSync(settings)) return [];
    return JSON.parse(readFileSync(settings, "utf8")).hooks?.PostToolUse ?? [];
}

/** Every PostToolUse command in a settings.json, flattened. */
function commands(settings: string): string[] {
    return groups(settings).flatMap((g) => g.hooks.map((h) => h.command));
}

beforeEach(() => toggles(true, true, true));

test("writes one entry for all three steps, idempotently", () => {
    const settings = join(HOME, "one.json");
    expect(applyClaudePostEditHook(settings)).toBe(true);
    const found = groups(settings);
    expect(found.length).toBe(1);
    expect(found[0]!.hooks.length).toBe(1);
    expect(found[0]!.hooks[0]!.command).toBe("enigma __post-edit-hook");
    expect(found[0]!.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    // Sized for the measured worst case (cold start plus a graph load), not the median: a budget
    // the host kills discards the output and prints a warning, so the process cost buys noise.
    expect(found[0]!.hooks[0]!.timeout).toBe(45);
    expect(applyClaudePostEditHook(settings)).toBe(false);
});

test("presence follows the three toggles together, not any one of them", () => {
    const settings = join(HOME, "toggles.json");
    toggles(true, true, true);
    expect(isPostEditHookOn()).toBe(true);
    applyClaudePostEditHook(settings);
    expect(commands(settings).length).toBe(1);

    // The bug three independent writers had: turning ONE feature off deleted the entry the other
    // two were still using. Any single toggle keeps the entry alive.
    toggles(false, false, true);
    expect(isPostEditHookOn()).toBe(true);
    expect(applyClaudePostEditHook(settings)).toBe(false);
    expect(commands(settings).length).toBe(1);

    toggles(false, false, false);
    expect(isPostEditHookOn()).toBe(false);
    expect(applyClaudePostEditHook(settings)).toBe(true);
    expect(commands(settings)).toEqual([]);
});

test("migrates an install that predates the merge by removing the three legacy entries", () => {
    // Exactly what enigma used to write: three groups, same event, same matcher.
    const settings = join(HOME, "legacy.json");
    writeFileSync(settings, JSON.stringify({
        hooks: {
            PostToolUse: [
                { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "enigma __guardrails-hook", timeout: 30 }] },
                { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "enigma __codegraph-hook post-edit", timeout: 25 }] },
                { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "enigma __trim-hook", timeout: 10 }] },
            ],
        },
    }));
    expect(applyClaudePostEditHook(settings)).toBe(true);
    // All three gone and one in their place - a leftover would keep paying the process start the
    // merge exists to stop, invisibly.
    expect(commands(settings)).toEqual(["enigma __post-edit-hook"]);
});

test("leaves the code graph's other events alone", () => {
    // Its SessionStart, UserPromptSubmit and Stop entries share the command name with the post-edit
    // one, so a marker that matched the bare name would delete all three.
    const settings = join(HOME, "other-events.json");
    writeFileSync(settings, JSON.stringify({
        hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "enigma __codegraph-hook session-start" }] }],
            UserPromptSubmit: [{ hooks: [{ type: "command", command: "enigma __codegraph-hook prompt" }] }],
            Stop: [{ hooks: [{ type: "command", command: "enigma __codegraph-hook stop" }] }],
        },
    }));
    applyClaudePostEditHook(settings);
    const after = JSON.parse(readFileSync(settings, "utf8")).hooks;
    expect(JSON.stringify(after.SessionStart)).toContain("session-start");
    expect(JSON.stringify(after.UserPromptSubmit)).toContain("prompt");
    expect(JSON.stringify(after.Stop)).toContain("stop");
});

test("preserves a user's own PostToolUse hook in both directions", () => {
    const settings = join(HOME, "theirs.json");
    const theirs = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] }, other: 1 };
    writeFileSync(settings, JSON.stringify(theirs));
    applyClaudePostEditHook(settings);
    expect(commands(settings)).toEqual(["echo hi", "enigma __post-edit-hook"]);
    expect(JSON.parse(readFileSync(settings, "utf8")).other).toBe(1);

    toggles(false, false, false);
    applyClaudePostEditHook(settings);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(theirs);
});

test("refuses a settings file it cannot parse rather than replacing it", () => {
    const settings = join(HOME, "broken.json");
    writeFileSync(settings, "{ not json");
    expect(applyClaudePostEditHook(settings)).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
});

test("the sync path re-asserts the entry, which is what migrates an existing install", async () => {
    // The migration's ONLY carrier for someone already installed. `enigma update` reaches an
    // install through syncDeployed, and nothing else rewrites this group - so if applyPostEditWiring
    // ever stops being called there, a pre-merge install silently keeps its three separate entries
    // and the whole change becomes a no-op for every existing user. That failure is invisible from
    // the inside: the hooks still work, they just cost three process starts instead of one.
    const { applyPostEditWiring } = await import("../src/post-edit-deploy");
    const settings = join(HOME, ".claude", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({
        hooks: {
            PostToolUse: [
                { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "enigma __guardrails-hook", timeout: 30 }] },
                { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "enigma __trim-hook", timeout: 10 }] },
                { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "enigma __codegraph-hook post-edit", timeout: 25 }] },
            ],
        },
    }));
    toggles(true, true, true);
    expect(applyPostEditWiring()).toBe(true);
    expect(commands(settings)).toEqual(["enigma __post-edit-hook"]);
    // Idempotent, because it runs on every sync and every agent launch, not just on update.
    expect(applyPostEditWiring()).toBe(false);
});
