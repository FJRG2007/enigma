/**
 * An agent removed another developer's commits from a shared repository: nothing it had been
 * told said that a commit it did not write was not its to take away. git-policy now carries that
 * rule, and its description is what makes the skill load before a revert or a reset rather than
 * only before a commit. `enigma check` does not notice either being dropped by a later rewrite,
 * so this pins both, together with the routing line in core-engineering-policy.
 *
 * Must run under Bun: bun test tests/policy-preserve-work.test.ts
 */
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "skills");
const read = (name: string): string => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

/** The operations that take work away. The description and the section must both name them. */
const DESTRUCTIVE = ["revert", "reset", "rebase", "amend", "stash"];

test("git-policy loads before a destructive operation, not only before a commit", () => {
    // The description is the only part of a skill in context before it loads, so an operation
    // missing from it is an operation the rule never gets the chance to stop.
    const description = /^description: (.*)$/m.exec(read("git-policy"))?.[1] ?? "";
    expect(description).toContain("BEFORE any operation that removes or rewrites commits or uncommitted changes");
    for (const operation of [...DESTRUCTIVE, "force push", "conflict"]) expect(description).toContain(operation);
});

test("git-policy owns the rule: whose work it is, the check before removing it, and the stop", () => {
    const md = read("git-policy");
    expect(md).toContain("## Preserving Work That Is Not Yours");
    const section = md.slice(md.indexOf("## Preserving Work That Is Not Yours")).split("\n---\n")[0]!;
    for (const operation of [...DESTRUCTIVE, "push --force", "clean", "--theirs"]) expect(section).toContain(operation);
    // Ownership is decided by listing authors, not by how the change looks.
    expect(section).toContain("list exactly what it takes away and who wrote it");
    expect(section).toContain("%an");
    // The stop, and the two cases an agent rationalizes its way past.
    expect(section).toContain("stop, leave it intact, and ask the user");
    expect(section).toContain("Changes in the working tree that you did not make");
    expect(section).toContain("Do not revert it or rewrite it to get your own change through");
    // A rejected push is answered by integrating, never by forcing.
    expect(section).toContain("never `--force`");
    expect(section).toContain("--force-with-lease");
    // The pre-commit checklist points back here instead of restating the rule.
    expect(md.slice(md.indexOf("## Safety & Final Validation"))).toContain("see Preserving Work That Is Not Yours");
});

test("core-engineering-policy routes destructive operations to git-policy", () => {
    const core = read("core-engineering-policy");
    expect(core).toContain("any operation that removes or rewrites commits or uncommitted changes (revert, reset, rebase, force push, discard, clean, stash, conflict resolution) -> git-policy.");
    // Routed, not restated: the procedure lives in one tier.
    expect(core).not.toContain("## Preserving Work That Is Not Yours");
});
