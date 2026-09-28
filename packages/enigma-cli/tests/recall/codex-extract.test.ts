/**
 * Codex rollouts feed recall through the same turn model as Claude transcripts. The lines
 * below follow the rollout shape Codex writes (`session_meta`, `event_msg`, `response_item`),
 * so a regression in either the parser or the shared assembly shows up here.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { extractCodexSession } from "@/recall/extract";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const DIR = mkdtempSync(join(tmpdir(), "enigma-codex-extract-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const line = (type: string, payload: Record<string, unknown>, at = "2026-09-01T10:00:00.000Z"): string =>
    JSON.stringify({ timestamp: at, type, payload });

test("a Codex rollout becomes a session with one observation per turn that changed files", () => {
    const patch = "*** Begin Patch\n*** Update File: /work/app/src/db.ts\n-a\n+b\n*** Add File: /work/app/src/pool.ts\n+x\n*** End Patch";
    const rollout = [
        line("session_meta", { id: "codex-session-1", cwd: "/work/app", originator: "codex_cli_rs" }),
        line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "system rules" }] }),
        line("event_msg", { type: "user_message", message: "Refactor the database module to use connection pooling" }, "2026-09-01T10:00:01.000Z"),
        line("response_item", { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"cat src/db.ts\"}", call_id: "c1" }),
        line("response_item", { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "c2" }),
        line("event_msg", { type: "agent_message", message: "Switched the client to a pool and added pool.ts." }, "2026-09-01T10:00:05.000Z"),
        line("event_msg", { type: "user_message", message: "thanks" }),
    ].join("\n");
    const file = join(DIR, "rollout-2026-09-01T10-00-00-codex-session-1.jsonl");
    writeFileSync(file, `${rollout}\n`);

    const result = extractCodexSession(file, []);
    expect(result).not.toBeNull();
    expect(result!.session.sessionId).toBe("codex-session-1");
    expect(result!.session.source).toBe("codex");
    expect(result!.session.project).toBe("app");
    expect(result!.observations).toHaveLength(1);
    const [obs] = result!.observations;
    expect(obs!.filesModified.sort()).toEqual(["src/db.ts", "src/pool.ts"]);
    expect(obs!.narrative).toBe("Switched the client to a pool and added pool.ts.");
    expect(obs!.facts).toContain("Ran 1 command");
    // The developer preamble is not the user's request.
    expect(result!.summary?.request).toBe("Refactor the database module to use connection pooling");
});

test("a rollout with nothing durable yields no memory", () => {
    const file = join(DIR, "rollout-empty.jsonl");
    writeFileSync(file, `${[line("session_meta", { id: "s2", cwd: "/work/x" }), line("event_msg", { type: "token_count" })].join("\n")}\n`);
    expect(extractCodexSession(file, [])).toBeNull();
});
