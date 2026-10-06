/**
 * The subagent budget: launch admission, nesting, the parallel-call race, stale slots, the hook
 * entry, and the settings.json wiring (hooks + autoCompactWindow).
 *
 * Temp HOME (set BEFORE the import) isolates the marker directory and the config.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";

const PRIOR_HOME = process.env.HOME;
const PRIOR_PROFILE = process.env.USERPROFILE;
const PRIOR_CONFIG_HOME = process.env.ENIGMA_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "enigma-subagents-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { admitLaunch, recordStart, recordStop, runSubagentHook, parseSubagentLimit, parseSubagentPayload } = await import("@/subagents");
const { applyClaudeSubagentWiring, applyCompactWindow, parseCompactWindow } = await import("@/subagent-deploy");

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    process.env.HOME = PRIOR_HOME;
    process.env.USERPROFILE = PRIOR_PROFILE;
    if (PRIOR_CONFIG_HOME === undefined) delete process.env.ENIGMA_CONFIG_HOME; else process.env.ENIGMA_CONFIG_HOME = PRIOR_CONFIG_HOME;
});

let n = 0;
const session = (): string => `s${++n}`;
const pre = (sessionId: string, toolUseId: string, agentId = "") => ({ event: "PreToolUse", sessionId, cwd: HOME, toolName: "Agent", toolUseId, agentId });
const life = (sessionId: string, agentId: string) => ({ event: "SubagentStart", sessionId, cwd: HOME, toolName: "", toolUseId: "", agentId });
const dir = (sessionId: string): string => join(HOME, ".enigma", "subagents", sessionId);

test("launches are admitted up to the limit, then refused until one stops", () => {
    const s = session();
    expect(admitLaunch(pre(s, "t1"), 2)).toBe("");
    recordStart(life(s, "a1"));
    expect(admitLaunch(pre(s, "t2"), 2)).toBe("");
    recordStart(life(s, "a2"));
    expect(admitLaunch(pre(s, "t3"), 2)).toContain("2 subagent(s) are already running or starting");
    recordStop(life(s, "a1"));
    expect(admitLaunch(pre(s, "t4"), 2)).toBe("");
});

test("parallel calls in one message count against each other before any of them starts", () => {
    const s = session();
    // Three PreToolUse hooks in a row, no SubagentStart between them: the pending slots are the count.
    const verdicts = ["t1", "t2", "t3"].map((t) => admitLaunch(pre(s, t), 2));
    expect(verdicts.filter((v) => v === "").length).toBe(2);
    expect(verdicts[2]).toContain("limit is 2");
});

test("sessions do not share a count", () => {
    const a = session();
    const b = session();
    expect(admitLaunch(pre(a, "t1"), 1)).toBe("");
    expect(admitLaunch(pre(b, "t1"), 1)).toBe("");
});

test("a subagent cannot launch subagents, and 0 turns them off", () => {
    expect(admitLaunch(pre(session(), "t1", "agent-x"), 4)).toContain("cannot launch subagents");
    expect(admitLaunch(pre(session(), "t1"), 0)).toContain("turned off");
    // No limit: everything goes, nesting included.
    expect(admitLaunch(pre(session(), "t1", "agent-x"), -1)).toBe("");
});

test("stale slots expire, so a crashed session does not block the next launch forever", () => {
    const s = session();
    expect(admitLaunch(pre(s, "t1"), 1)).toBe("");
    recordStart(life(s, "dead"));
    expect(admitLaunch(pre(s, "t2"), 1)).not.toBe("");
    const old = (Date.now() - 7 * 60 * 60_000) / 1000;
    utimesSync(join(dir(s), "run-dead"), old, old);
    expect(admitLaunch(pre(s, "t3"), 1)).toBe("");
});

test("the last stop removes the session directory", () => {
    const s = session();
    admitLaunch(pre(s, "t1"), 3);
    recordStart(life(s, "a1"));
    expect(existsSync(dir(s))).toBe(true);
    recordStop(life(s, "a1"));
    expect(existsSync(dir(s))).toBe(false);
});

test("a stop never deletes a marker a concurrent launch wrote", () => {
    const s = session();
    admitLaunch(pre(s, "t1"), 3);
    recordStart(life(s, "a1"));
    // A file the listing does not count stands in for a marker written after the stop listed the dir.
    writeFileSync(join(dir(s), "late"), "");
    expect(() => recordStop(life(s, "a1"))).not.toThrow();
    expect(existsSync(join(dir(s), "late"))).toBe(true);
});

test("the hook entry refuses with exit 2, briefs a started subagent, and ignores other tools", () => {
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ subagentLimit: 1 }));
    const s = session();
    const payload = (o: Record<string, unknown>): string => JSON.stringify({ session_id: s, cwd: HOME, ...o });
    expect(runSubagentHook("pre", payload({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "t1" }))).toBe(0);
    let out = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try { runSubagentHook("start", payload({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "general-purpose" })); } finally { process.stdout.write = write; }
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("do not launch subagents");
    expect(runSubagentHook("pre", payload({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "t2" }))).toBe(2);
    expect(runSubagentHook("pre", payload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t3" }))).toBe(0);
    // Garbage and path-shaped session ids let the call through instead of breaking it.
    expect(runSubagentHook("pre", "not json")).toBe(0);
    expect(parseSubagentPayload(JSON.stringify({ session_id: "../../etc" }))).toBeNull();
    rmSync(join(HOME, ".enigma.json"), { force: true });
});

test("setting values parse strictly", () => {
    expect(parseSubagentLimit("3")).toBe(3);
    expect(parseSubagentLimit("off")).toBe(-1);
    expect(() => parseSubagentLimit("-2")).toThrow();
    expect(() => parseSubagentLimit("21")).toThrow();
    expect(parseCompactWindow("400k")).toBe(400_000);
    expect(parseCompactWindow("250000")).toBe(250_000);
    expect(parseCompactWindow("auto")).toBe(0);
    expect(() => parseCompactWindow("50k")).toThrow();
    expect(() => parseCompactWindow("2000k")).toThrow();
});

test("wiring installs the three hooks and the compact window, keeping the user's settings", () => {
    const settings = join(HOME, "claude", "settings.json");
    mkdirSync(join(HOME, "claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ model: "opus[1m]", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine" }] }] } }));
    expect(applyClaudeSubagentWiring(settings)).toBe(true);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.model).toBe("opus[1m]");
    expect(s.autoCompactWindow).toBe(400_000);
    expect(s.hooks.PreToolUse.length).toBe(2);
    expect(s.hooks.PreToolUse[1].matcher).toBe("Agent|Task");
    expect(s.hooks.SubagentStart[0].hooks[0].command).toBe("enigma __subagent-hook start");
    expect(s.hooks.SubagentStop[0].hooks[0].command).toBe("enigma __subagent-hook stop");
    // Idempotent, and "auto" leaves a value the user set alone.
    expect(applyClaudeSubagentWiring(settings)).toBe(false);
    expect(applyCompactWindow(settings, 0)).toBe(false);
    // A window the user set is kept on install and sync, and replaced only by an explicit setting.
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 200_000 }));
    expect(applyClaudeSubagentWiring(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8")).autoCompactWindow).toBe(200_000);
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ compactWindow: 300_000 }));
    applyClaudeSubagentWiring(settings);
    expect(JSON.parse(readFileSync(settings, "utf8")).autoCompactWindow).toBe(300_000);
    rmSync(join(HOME, ".enigma.json"), { force: true });
    // An unreadable settings file is never replaced.
    writeFileSync(settings, "{ broken");
    expect(applyCompactWindow(settings, 300_000)).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe("{ broken");
});
