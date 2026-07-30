/**
 * Every agent the gate spawns must carry the gate-role marker.
 *
 * Two consumers depend on it: a cooperating orchestration harness in the target repo
 * refuses to let a gate agent act as a fleet operator, and enigma's turn-end completion
 * hook skips itself instead of judging a step's structured JSON as a "done" claim and
 * spending another agent turn on a denied stop. Missing the stamp silently restores both
 * costs, so it is asserted rather than assumed.
 */
import { join } from "node:path";
import { test, expect } from "bun:test";
import { gitSafeEnv } from "../../src/gate/agent/env";
import { GATE_ROLE_ENV_VAR, isGateAgentRun } from "../../src/util";

test("gitSafeEnv stamps the gate-role marker and keeps git non-interactive", () => {
    const dir = join(process.cwd(), "worktree");
    const env = gitSafeEnv(dir);

    expect(env[GATE_ROLE_ENV_VAR]).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_EDITOR).toBe("true");
    // PWD is mirrored only off Windows, matching what os/exec injects when Env is unset.
    if (process.platform !== "win32") expect(env.PWD).toBe(dir);
});

test("isGateAgentRun reads the marker", () => {
    const previous = process.env[GATE_ROLE_ENV_VAR];
    try {
        delete process.env[GATE_ROLE_ENV_VAR];
        expect(isGateAgentRun()).toBe(false);
        process.env[GATE_ROLE_ENV_VAR] = "1";
        expect(isGateAgentRun()).toBe(true);
    } finally {
        if (previous === undefined) delete process.env[GATE_ROLE_ENV_VAR];
        else process.env[GATE_ROLE_ENV_VAR] = previous;
    }
});
