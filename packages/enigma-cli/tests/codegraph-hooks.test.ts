/**
 * The push half of the code graph: the session hooks that make the graph ARRIVE rather than merely
 * be available, plus the wiring that installs them and the status-line snapshot they leave behind.
 *
 * The gates are the point of these tests. A hook that fires on every prompt has to stay silent most
 * of the time, or it teaches the agent to ignore the channel - so a short prompt, a weak match and
 * an already-injected pointer must all produce nothing.
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "enigma-cg-hooks-"));
const STORE = join(HOME, "store");
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CODEGRAPH_DIR = STORE;
writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ codeGraph: true }));

// A project with a real dependency so the blast radius has something to report.
const PROJ = mkdtempSync(join(tmpdir(), "enigma-cg-hooks-proj-"));
mkdirSync(join(PROJ, "src"), { recursive: true });
writeFileSync(join(PROJ, "src", "tokens.ts"), "export function refreshSessionToken(t: string): string {\n    return t;\n}\n");
writeFileSync(join(PROJ, "src", "api.ts"), 'import { refreshSessionToken } from "./tokens";\nexport function handleRequest(t: string): string {\n    return refreshSessionToken(t);\n}\n');

const deploy = await import("../src/codegraph-deploy");

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJ, { recursive: true, force: true });
    delete process.env.ENIGMA_CODEGRAPH_DIR;
    delete process.env.ENIGMA_CONFIG_HOME;
});

/** Run one hook the way the host does: payload on stdin, event as the argument. */
function hook(event: string, payload: Record<string, unknown>): string {
    const run = spawnSync(process.execPath, [join(ROOT, "src", "bin", "enigma.ts"), "__codegraph-hook", event], {
        encoding: "utf8",
        input: JSON.stringify({ cwd: PROJ, ...payload }),
        windowsHide: true,
        env: { ...process.env, HOME, USERPROFILE: HOME, ENIGMA_CONFIG_HOME: HOME, ENIGMA_CODEGRAPH_DIR: STORE },
    });
    expect(run.status).toBe(0); // a hook must never fail the turn it rides in
    return run.stdout.trim();
}

function context(out: string): string {
    if (!out) return "";
    return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string; }; }).hookSpecificOutput.additionalContext;
}

test("session start orients the agent and names the tools", () => {
    const out = context(hook("session-start", {}));
    expect(out).toContain("enigma_codegraph_ask");
    expect(out).toContain("repo map");
});

test("the prompt hook injects locators, and never the source", () => {
    const out = context(hook("prompt", { session_id: "a", prompt: "where is the session token refreshed" }));
    expect(out).toContain("refreshSessionToken");
    expect(out).toContain("src/tokens.ts:1");
    // Locators only: per-prompt tokens are full price on every turn, so the body must not be there.
    expect(out).not.toContain("return t;");
});

test("the prompt hook stays silent on a prompt too short to retrieve on", () => {
    expect(hook("prompt", { session_id: "b", prompt: "ok" })).toBe("");
});

test("the prompt hook stays silent on conversational chatter", () => {
    expect(hook("prompt", { session_id: "c", prompt: "thanks that looks good to me now please continue" })).toBe("");
});

test("a pointer already injected this session is not injected again", () => {
    const first = context(hook("prompt", { session_id: "d", prompt: "where is the session token refreshed" }));
    expect(first).toContain("src/tokens.ts:1");
    // Only two symbols exist, so the second ask has nothing new left to point at.
    const second = hook("prompt", { session_id: "d", prompt: "where is the session token refreshed" });
    expect(context(second)).not.toContain("src/tokens.ts:1");
});

test("editing a file reports what depends on it", () => {
    const out = context(hook("post-edit", { session_id: "e", tool_input: { file_path: join(PROJ, "src", "tokens.ts") } }));
    expect(out).toContain("Blast radius");
    expect(out).toContain("handleRequest");
});

test("the status-line snapshot names the repo it describes, and one project never blanks another", async () => {
    hook("session-start", { session_id: "f" });
    const file = JSON.parse(readFileSync(join(STORE, "statusline.json"), "utf8")) as { version: number; repos: Record<string, { root: string; symbols: number; stale: number; }>; };
    expect(file.version).toBe(2);
    const snap = Object.values(file.repos)[0]!;
    expect(snap.symbols).toBeGreaterThan(0);
    const { readCodeGraphStatus } = await import("../bin/statusline.mjs") as { readCodeGraphStatus: (cwd: string) => { symbols: number; } | null; };
    expect(readCodeGraphStatus(snap.root)?.symbols).toBe(snap.symbols);
    // A snapshot from another repo must never put its numbers on this session's line.
    expect(readCodeGraphStatus(join(tmpdir(), "some-other-repo"))).toBeNull();

    // The bug this pins: the file was a single slot, and the writer is a SESSION HOOK - so an
    // ordinary prompt in another project overwrote this repo's entry and the segment silently
    // vanished from every session open here. A second repository must leave the first readable.
    const other = `${snap.root}-other`;
    writeFileSync(join(STORE, "statusline.json"), JSON.stringify({
        version: 2,
        repos: { ...file.repos, [other]: { root: other, symbols: 7, stale: 2 } }
    }));
    expect(readCodeGraphStatus(snap.root)?.symbols).toBe(snap.symbols);
    expect(readCodeGraphStatus(other)?.symbols).toBe(7);
});

test("an unindexed tree is handed to one background index, and a managed checkout to none", () => {
    const markers = (): string[] => {
        const dir = join(STORE, "sessions");
        return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("indexing-")) : [];
    };
    const before = markers().length;

    const cold = mkdtempSync(join(tmpdir(), "enigma-cg-hooks-cold-"));
    mkdirSync(join(cold, ".git"), { recursive: true });
    writeFileSync(join(cold, "a.ts"), "export function coldStart() { return 1; }\n");
    expect(hook("prompt", { cwd: cold, session_id: "g", prompt: "where does the cold start happen" })).toBe("");
    expect(markers().length).toBe(before + 1);

    // Once handed over, not again on the next prompt: nothing covers the tree until that index
    // lands, so every prompt and every edit used to start another full scan of the same tree - each
    // ending in a read-modify-write of projects.json that can drop what the others wrote.
    const claimed = markers().map((f) => statSync(join(STORE, "sessions", f)).mtimeMs);
    hook("prompt", { cwd: cold, session_id: "g", prompt: "where does the cold start happen" });
    // The claim, not the silence: whether the detached index has landed by the second prompt is a
    // race (it had on Linux, had not on Windows), and the answer arriving is the feature working.
    expect(markers().map((f) => statSync(join(STORE, "sessions", f)).mtimeMs)).toEqual(claimed);

    // A gate worktree is inside enigma's own managed directory, where indexing refuses by design -
    // so spawning there is a process guaranteed to fail, once per prompt for the whole session.
    const managed = join(HOME, ".enigma", "gate", "worktrees", "abc123", "01M04CKE0P0GTY1T5WM6BFGJ8D");
    mkdirSync(join(managed, ".git"), { recursive: true });
    writeFileSync(join(managed, "a.ts"), "export function coldStart() { return 1; }\n");
    expect(hook("prompt", { cwd: managed, session_id: "h", prompt: "where does the cold start happen" })).toBe("");
    expect(markers().length).toBe(before + 1);

    rmSync(cold, { recursive: true, force: true });
});

test("the wiring installs every event and removes every one of them again", () => {
    const settings = join(HOME, "claude-settings.json");
    expect(deploy.applyClaudeCodeGraphHooks(settings, true)).toBe(true);
    const on = JSON.parse(readFileSync(settings, "utf8")) as { hooks: Record<string, unknown[]>; };
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
        expect(JSON.stringify(on.hooks[event])).toContain("__codegraph-hook");
    }
    expect(deploy.applyClaudeCodeGraphHooks(settings, false)).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks ?? {}).toEqual({});
});

test("the wiring leaves another tool's hooks untouched", () => {
    const settings = join(HOME, "claude-shared.json");
    const theirs = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "their-tool" }] }] } };
    writeFileSync(settings, JSON.stringify(theirs));
    deploy.applyClaudeCodeGraphHooks(settings, true);
    deploy.applyClaudeCodeGraphHooks(settings, false);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(theirs);
});

test("the dashboard switch wires the same three effects the CLI does, not just the config value", async () => {
    const { applyCodeGraphAction } = await import("../src/dashboard-codegraph");
    const settings = join(HOME, ".claude", "settings.json");

    const readHooks = (): string => (existsSync(settings) ? JSON.stringify(JSON.parse(readFileSync(settings, "utf8")).hooks ?? {}) : "{}");

    const off = await applyCodeGraphAction("toggle", { on: false });
    expect(off.ok).toBe(true);
    expect(off.enabled).toBe(false);
    expect(readHooks()).not.toContain("__codegraph-hook");

    const on = await applyCodeGraphAction("toggle", { on: true });
    expect(on.ok).toBe(true);
    expect(on.enabled).toBe(true);
    // The switch owns the push half too. Writing only the config value left the graph enabled in
    // the settings and wired into nothing - available, and never arriving.
    expect(readHooks()).toContain("__codegraph-hook");
    // A toggle changes nothing the panel renders, so it must not pay for a full view: freshness
    // alone stats every file of the project.
    expect(on.view).toBeUndefined();
});
