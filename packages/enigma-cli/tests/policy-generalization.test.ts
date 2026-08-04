/**
 * The Generalization Rule (a named example is an instance of a class) spans six shipped files:
 * the procedure in core-engineering-policy, the always-on short form in the memory kernel, and
 * one cross-reference each in debugging-, code-review- and task-completion-policy. Nothing in
 * `enigma check` notices if a later kernel shrink or skill rewrite drops one of them, so this
 * pins the contract: every tier carries its part, the two kernels stay identical, the kernel
 * stays inside its always-on budget, and the procedure itself lives in exactly one tier.
 *
 * Must run under Bun: bun test tests/policy-generalization.test.ts
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-policy-generalization-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { MEMORY_BUDGET_BYTES, budgetedBytes } = await import("../src/skills");

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const memory = (file: string): string => join(ASSETS, "memory", file);
const skill = (name: string): string => join(ASSETS, "skills", name, "SKILL.md");
const read = (path: string): string => readFileSync(path, "utf8");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("core-engineering-policy owns the rule: the section, the five-step procedure and the tier routing", () => {
    const md = read(skill("core-engineering-policy"));
    expect(md).toContain("## Generalization Rule (Example -> Class)");
    for (const step of ["1. Name the rule", "2. Sweep", "3. Fix the whole class", "4. Encode the rule", "5. Report the rule"]) {
        expect(md).toContain(step);
    }
    // The three tiers plus the single-tier constraint - dropping one turns the rule into advice.
    expect(md).toContain("a lint, guardrail, or CI rule");
    expect(md).toContain("the owning policy skill");
    expect(md).toContain("always-on memory file");
    expect(md).toContain("Never encode one rule in two tiers");
    // Universal-tier edits must not go through the deployed file: an unrecorded hand edit makes
    // it no longer enigma-written, and syncTarget then skips it forever (skills.ts).
    expect(md).toContain("never hand-edit the deployed file");
    // The harness map advertises the rule, so an agent scanning it knows which skill to load.
    expect(md).toContain("the generalization rule (a named example is a class)");
});

test("the always-on kernel carries the short form, identically for every agent, within budget", () => {
    const claude = read(memory("CLAUDE.md"));
    const agents = read(memory("AGENTS.md"));
    expect(claude).toBe(agents); // Claude Code and Codex/OpenCode must not drift apart.
    expect(claude).toContain("EXAMPLE OF A CLASS");
    expect(claude).toContain("core-engineering-policy's Generalization Rule");
    // Kernel keeps the trigger only; the procedure stays in the skill (one rule, one tier).
    expect(claude).not.toContain("## Generalization Rule (Example -> Class)");
    expect(claude).not.toContain("1. Name the rule");
    // budgetedBytes, not the size on disk: a case block's unselected alternatives never deploy,
    // so charging them would bill context no session pays (skills.ts).
    for (const file of ["CLAUDE.md", "AGENTS.md"]) expect(budgetedBytes(read(memory(file)))).toBeLessThanOrEqual(MEMORY_BUDGET_BYTES);
});

test("the domain skills point back at the rule instead of restating it", () => {
    // debugging: the sweep is for the root cause, not the reported symptom.
    const debugging = read(skill("debugging-policy"));
    expect(debugging).toContain("core-engineering-policy's Generalization Rule");
    expect(debugging).toContain("8. Generalize:");
    expect(debugging).toContain("sample, not the population");
    // code-review: the pre-delivery gate that no sibling was left behind.
    const review = read(skill("code-review-policy"));
    expect(review).toContain("core-engineering-policy's Generalization Rule");
    expect(review).toContain("identical instances of the same defect stay untouched");
    // task-completion: a generalized sweep is an inventory, so it goes through the ledger.
    const completion = read(skill("task-completion-policy"));
    expect(completion).toContain("core-engineering-policy's Generalization Rule");
    expect(completion).toContain("one-line request generalizes");
});
