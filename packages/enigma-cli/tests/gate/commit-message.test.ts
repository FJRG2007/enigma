/**
 * Gate commit subjects follow the same `commitEmoji` setting the agent's own commits do.
 * The regression this pins: pipeline commits were hardcoded to `enigma(<step>): ...` with no
 * emoji, so a gate run left commits that did not match the rest of the history.
 *
 * The last block covers the other half of the same class: the commit sites in this repo's own
 * GitHub Actions workflows, which cannot read `.enigma.json` and so hardcode the emoji. The
 * screenshot workflow's preview-refresh commit was the one that had none.
 *
 * Temp HOME (set BEFORE the import) isolates ~/.enigma.json; the project scope is a temp dir
 * passed explicitly, so nothing here depends on process.cwd().
 * Must run under Bun: bun test tests/gate/commit-message.test.ts
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** git-policy's sanctioned type-to-emoji map, read from the skill rather than restated here. */
function policyEmojiByType(): Record<string, string> {
    const md = readFileSync(join(REPO_ROOT, "packages", "enigma-cli", "assets", "skills", "git-policy", "SKILL.md"), "utf8");
    const map: Record<string, string> = {};
    for (const line of md.split("\n")) {
        const entry = /^ {2}- (\S+) ([a-z]+): /.exec(line);
        if (entry !== null) map[entry[2]] = entry[1];
    }
    return map;
}

test("every hardcoded commit subject in this repo's workflows carries git-policy's type emoji", () => {
    const emoji = policyEmojiByType();
    expect(emoji.chore).toBe("🔧");

    const workflows = join(REPO_ROOT, ".github", "workflows");
    const subjects: string[] = [];
    for (const file of readdirSync(workflows).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
        for (const line of readFileSync(join(workflows, file), "utf8").split("\n")) {
            const commit = /git commit\b[^\n]*?-m "([^"]+)"/.exec(line);
            if (commit !== null) subjects.push(commit[1]);
        }
    }
    // A workflow cannot consult `.enigma.json`, so the emoji is not optional there - it is the
    // literal text of the commit. Guard against the scan silently matching nothing.
    expect(subjects.length).toBeGreaterThan(0);
    for (const subject of subjects) {
        const parts = /^(\S+) ([a-z]+)(\([^)]*\))?: /.exec(subject);
        expect(parts, `no "<emoji> <type>: " prefix in workflow commit subject: ${subject}`).not.toBeNull();
        expect(parts![1], `wrong emoji for type "${parts![2]}" in: ${subject}`).toBe(emoji[parts![2]]);
    }
});
