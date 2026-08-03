/**
 * Gate commit subjects follow the same `commitEmoji` setting the agent's own commits do.
 * The regression this pins: pipeline commits were hardcoded to `enigma(<step>): ...` with no
 * emoji, so a gate run left commits that did not match the rest of the history.
 *
 * Temp HOME (set BEFORE the import) isolates ~/.enigma.json; the project scope is a temp dir
 * passed explicitly, so nothing here depends on process.cwd().
 * Must run under Bun: bun test tests/gate/commit-message.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

// bun test shares one process across files: leaving this pinned would send the NEXT file's
// global-config reads into this temp dir, so capture the prior value before overwriting it.
const PRIOR_CONFIG_HOME = process.env.ENIGMA_CONFIG_HOME;
const PRIOR_HOME = process.env.HOME;
const PRIOR_USERPROFILE = process.env.USERPROFILE;

const HOME = mkdtempSync(join(tmpdir(), "enigma-gate-msg-home-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const PROJECT = mkdtempSync(join(tmpdir(), "enigma-gate-msg-project-"));

const { gateCommitMessage } = await import("@/gate/pipeline/steps/commitMessage");
const { allSteps } = await import("@/gate/types");

function writeConfig(dir: string, value: Record<string, unknown>): void {
    writeFileSync(join(dir, ".enigma.json"), `${JSON.stringify(value)}\n`);
}

afterAll(() => {
    if (PRIOR_CONFIG_HOME === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = PRIOR_CONFIG_HOME;
    if (PRIOR_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = PRIOR_HOME;
    if (PRIOR_USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = PRIOR_USERPROFILE;
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJECT, { recursive: true, force: true });
});

test("emoji is on out of the box, one per step type", () => {
    expect(gateCommitMessage(PROJECT, "review", "tighten skip detection")).toBe(
        "🐛 enigma(review): tighten skip detection"
    );
    expect(gateCommitMessage(PROJECT, "document", "document the gate ledger")).toBe(
        "📝 enigma(document): document the gate ledger"
    );
    expect(gateCommitMessage(PROJECT, "lint", "sort imports")).toBe("🎨 enigma(lint): sort imports");
    expect(gateCommitMessage(PROJECT, "test", "cover the empty diff")).toBe("✅ enigma(test): cover the empty diff");
    expect(gateCommitMessage(PROJECT, "ci", "apply CI fixes")).toBe("👷 enigma(ci): apply CI fixes");
    expect(gateCommitMessage(PROJECT, "push", "apply agent fixes")).toBe("🔧 enigma(push): apply agent fixes");
});

test("every pipeline step has an emoji", () => {
    for (const step of allSteps()) {
        const subject = gateCommitMessage(PROJECT, step, "x");
        expect(subject).not.toStartWith("enigma(");
        expect(subject).toEndWith(`enigma(${step}): x`);
    }
});

test("an empty summary still yields a subject", () => {
    expect(gateCommitMessage(PROJECT, "review", "")).toBe("🐛 enigma(review): apply fixes");
});

test("the project opt-out drops the emoji", () => {
    writeConfig(PROJECT, { commitEmoji: false });
    expect(gateCommitMessage(PROJECT, "review", "tighten skip detection")).toBe(
        "enigma(review): tighten skip detection"
    );
    writeConfig(PROJECT, {});
});

test("the global opt-out drops the emoji", () => {
    writeConfig(HOME, { commitEmoji: false });
    expect(gateCommitMessage(PROJECT, "document", "note the ledger")).toBe("enigma(document): note the ledger");
    // A project can turn it back on over a global off.
    writeConfig(PROJECT, { commitEmoji: true });
    expect(gateCommitMessage(PROJECT, "document", "note the ledger")).toBe("📝 enigma(document): note the ledger");
    writeConfig(HOME, {});
    writeConfig(PROJECT, {});
});
