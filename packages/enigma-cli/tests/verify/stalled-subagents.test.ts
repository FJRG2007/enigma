/**
 * Subagents cut at their turn limit and never resumed: detected from the transcript, refused at
 * turn end once per set, and carried by id into the handoff so a cleared session can resume them.
 * HOME is a temp dir, set BEFORE the imports.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-stalled-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_SELF_AUDIT = "0";
process.env.ENIGMA_NO_BACKGROUND_TIDY = "1";
delete process.env.ENIGMA_GATE;

const { stalledSubagents } = await import("../../src/claude-transcripts");
const { runVerifyHook, stalledMessage } = await import("../../src/verify");
const handoff = await import("../../src/handoff");
const { handoffDir } = await import("../../src/handoff-cli");

const WORK = mkdtempSync(join(tmpdir(), "enigma-stalled-work-"));
afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
});

const notice = (id: string, name: string, outcome: string): string =>
    `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${name}" ${outcome}</summary>\n</task-notification>`;
const CUT = "stopped at its 60-turn limit (partial result; SendMessage to task-id to continue)";
const user = (text: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const call = (name: string, input: Record<string, unknown>): string =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] } });

function transcript(name: string, lines: string[]): string {
    const path = join(WORK, `${name}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
}

const MIXED = [
    user(notice("a1", "Build the exporter", CUT)),
    user(notice("a2", "Fix the router", CUT)),
    call("SendMessage", { to: "a2", message: "continue" }),
    user(notice("a3", "Write the docs", CUT)),
    user(notice("a3", "Write the docs", "finished")),
    user(notice("a4", "Old experiment", CUT)),
    call("TaskStop", { task_id: "a4" }),
    // A replayed API request and a subagent's own record are not reports to this session.
    JSON.stringify({ type: "api-request-blob", message: { role: "user", content: [{ type: "text", text: notice("a5", "Replayed", CUT) }] } }),
    user(notice("a6", "Nested", CUT), { isSidechain: true }),
    user(notice("a7", "Resumed then cut again", CUT)),
    call("SendMessage", { to: "a7", message: "continue" }),
    user(notice("a7", "Resumed then cut again", CUT)),
    "{ not json",
];

test("only a cut nobody acted on, and the last event per agent decides", () => {
    expect(stalledSubagents(transcript("mixed", MIXED))).toEqual([
        { id: "a1", name: "Build the exporter" },
        { id: "a7", name: "Resumed then cut again" },
    ]);
    expect(stalledSubagents(transcript("clean", [user(notice("b1", "Done", "finished"))]))).toEqual([]);
    expect(stalledSubagents(join(WORK, "missing.jsonl"))).toEqual([]);
});

test("the turn end is refused within the per-issue budget, never in plan mode", () => {
    const path = transcript("hook", MIXED);
    const payload = (extra: Record<string, unknown> = {}): string =>
        JSON.stringify({ cwd: WORK, session_id: "s-stalled", transcript_path: path, last_assistant_message: "The exporter agent is still working on it.", ...extra });
    expect(runVerifyHook(payload({ permission_mode: "plan" }))).toBe(0);
    // The shared loop budget (two blocks per distinct finding) ends it, so an agent that cannot
    // resume a subagent is never trapped.
    expect(runVerifyHook(payload())).toBe(2);
    expect(runVerifyHook(payload())).toBe(2);
    expect(runVerifyHook(payload())).toBe(0);
    expect(stalledMessage([{ id: "a1", name: "Build the exporter" }])).toContain("SendMessage its task id");
});

test("the handoff lists stalled agents by id, and a re-save does not duplicate the section", () => {
    const project = join(WORK, "proj");
    mkdirSync(join(project, ".git"), { recursive: true });
    const first = handoff.saveHandoff(project, "# Ship it\n\n## Next\n1. finish", 1, ["also fix X"], [{ id: "a1", name: "Build the exporter" }]);
    expect(first.text).toContain(handoff.STALLED_HEADING);
    expect(first.text).toContain("`a1` Build the exporter");
    const again = handoff.saveHandoff(project, first.text, 2, ["also fix X"], [{ id: "a1", name: "Build the exporter" }]);
    expect(again.text.split(handoff.STALLED_HEADING).length).toBe(2);
    expect(again.text.split(handoff.RECENT_HEADING).length).toBe(2);
    expect(handoff.saveHandoff(project, "# Ship it", 3).text).not.toContain(handoff.STALLED_HEADING);
});

test("the handoff is filed under the session's project, not the shell's folder", () => {
    expect(handoffDir(WORK, { CLAUDE_PROJECT_DIR: HOME })).toBe(HOME);
    expect(handoffDir(WORK, { CLAUDE_PROJECT_DIR: join(WORK, "gone") })).toBe(WORK);
    expect(handoffDir(WORK, {})).toBe(WORK);
});
