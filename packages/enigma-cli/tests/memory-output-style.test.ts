/**
 * The token-efficient output block, which is the one memory section whose CONTENT varies per
 * user. Two invariants are worth pinning because both fail silently:
 *  - the deployed file describes ONLY the selected level (case blocks resolved, no markers and
 *    no {{output-level}} placeholder left behind) - a leaked marker or a rival level's rules is
 *    context every session pays for and the agent has to reason around;
 *  - a level added to OUTPUT_STYLES without its case block would deploy a section that names a
 *    level and then says nothing about it.
 * Plus the byte budget, which now charges the largest alternative rather than all of them.
 *
 * Runs against a temp HOME with a fabricated global Claude deployment.
 * Must run under Bun: bun test tests/memory-output-style.test.ts
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-output-style-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { syncAccount, budgetedBytes, checkCaseBlocks, MEMORY_BUDGET_BYTES } = await import("../src/skills");
const { OUTPUT_STYLES } = await import("../src/config");
const { AGENTS } = await import("../src/agents");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEMORY_ROOT = join(ROOT, "assets", "memory");
const SKILLS_DIR = AGENTS.claude!.targets.global!.skills;
const ACCOUNT_DIR = join(HOME, "account");
const priorConfigHome = process.env.ENIGMA_CONFIG_HOME;

/** A phrase that appears in exactly one level's case block. */
const LEVEL_MARK: Record<string, string> = {
    lite: "professional and tight",
    full: "[thing] [state] [reason]",
    ultra: "telegraphic",
};

/** Deploy the memory file at `style` and return the rendered content. */
function deployedAt(style: string): string {
    rmSync(ACCOUNT_DIR, { recursive: true, force: true });
    writeFileSync(join(HOME, ".enigma.json"), `${JSON.stringify({ outputStyle: style })}\n`);
    syncAccount("claude", ACCOUNT_DIR);
    return readFileSync(join(ACCOUNT_DIR, "CLAUDE.md"), "utf8");
}

beforeEach(() => {
    // Other test files repoint these on import; bun test shares one process.
    process.env.ENIGMA_CONFIG_HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.HOME = HOME;
    mkdirSync(SKILLS_DIR, { recursive: true });
    cpSync(join(ROOT, "assets", "skills", "git-policy"), join(SKILLS_DIR, "git-policy"), { recursive: true });
});

afterAll(() => {
    if (priorConfigHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorConfigHome;
    rmSync(join(SKILLS_DIR, "git-policy"), { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
});

test("the deployed memory describes the selected level and no other", () => {
    for (const style of ["lite", "full", "ultra"]) {
        const out = deployedAt(style);
        expect(out).toContain(`compressed at level **${style}**`);
        expect(out).toContain(LEVEL_MARK[style]!);
        for (const other of Object.keys(LEVEL_MARK)) {
            if (other !== style) expect(out).not.toContain(LEVEL_MARK[other]!);
        }
        // Nothing of the rendering machinery survives into the file the agent reads.
        expect(out).not.toContain("enigma:case");
        expect(out).not.toContain("{{output-level}}");
    }
});

test("switching the style off drops the whole block", () => {
    const out = deployedAt("off");
    expect(out).not.toContain("Output Style");
    expect(out).not.toContain("enigma:case");
});

test("every selectable level ships a case block", () => {
    const src = readFileSync(join(MEMORY_ROOT, "CLAUDE.md"), "utf8");
    for (const style of OUTPUT_STYLES) {
        if (style === "off") continue; // "off" strips the block instead of rendering a case
        expect(src).toContain(`<!-- enigma:case:outputStyle=${style} -->`);
    }
});

test("the budget charges the largest alternative, not every one", () => {
    const cases = [
        "<!-- enigma:case:outputStyle=lite -->", "ab", "<!-- enigma:case:end -->",
        "<!-- enigma:case:outputStyle=ultra -->", "abcd", "<!-- enigma:case:end -->",
    ].join("\n");
    // "kept" plus the longest body and its own newline, with every marker and the shorter body
    // dropped - exactly what renderMemory leaves when "ultra" is the selected level.
    expect(budgetedBytes(`kept\n${cases}\n`)).toBe(Buffer.byteLength("kept\nabcd\n"));
    // A file with no cases is charged verbatim.
    expect(budgetedBytes("plain memory\n")).toBe(Buffer.byteLength("plain memory\n"));
});

test("blocks sharing one value are summed, since they deploy together", () => {
    const cases = [
        "<!-- enigma:case:outputStyle=lite -->", "abc", "<!-- enigma:case:end -->",
        "<!-- enigma:case:outputStyle=ultra -->", "ab", "<!-- enigma:case:end -->",
        "<!-- enigma:case:outputStyle=ultra -->", "cd", "<!-- enigma:case:end -->",
    ].join("\n");
    // Selecting "ultra" deploys BOTH of its blocks (4 bytes + 2 newlines), which outweighs the
    // single 3-byte "lite" block - charging one "ultra" block alone would underbill the file.
    expect(budgetedBytes(`kept\n${cases}\n`)).toBe(Buffer.byteLength("kept\nab\ncd\n"));
});

test("each level carries its own rewritten example", () => {
    for (const style of ["lite", "full", "ultra"]) {
        const out = deployedAt(style);
        expect(out).toContain("- Not: \"I've taken a look");
        expect(out.match(/Yes: "/g)).toHaveLength(1);
    }
    expect(deployedAt("ultra")).toContain("Yes: \"`auth.ts:42`: expiry check `<` -> `<=`. Fixed.\"");
});

test("a case block that can never match is reported instead of silently dropped", () => {
    expect(checkCaseBlocks("memory/CLAUDE.md", "<!-- enigma:case:outputStyle=ultra -->\nx\n<!-- enigma:case:end -->\n")).toEqual([]);
    expect(checkCaseBlocks("memory/CLAUDE.md", "<!-- enigma:case:gate=false -->\nx\n<!-- enigma:case:end -->\n")).toEqual([]);
    // A key that is not a setting, and a value the key can never hold: both delete the body.
    expect(checkCaseBlocks("m", "<!-- enigma:case:outputStyle=uItra -->\nx\n<!-- enigma:case:end -->\n")).toHaveLength(1);
    expect(checkCaseBlocks("m", "<!-- enigma:case:ouputStyle=ultra -->\nx\n<!-- enigma:case:end -->\n")).toHaveLength(1);
    expect(checkCaseBlocks("m", "<!-- enigma:case:gate=off -->\nx\n<!-- enigma:case:end -->\n")).toHaveLength(1);
});

test("every bundled memory file and skill authors only reachable case blocks", () => {
    for (const file of ["CLAUDE.md", "AGENTS.md"]) expect(checkCaseBlocks(file, readFileSync(join(MEMORY_ROOT, file), "utf8"))).toEqual([]);
    const skillsRoot = join(ROOT, "assets", "skills");
    for (const name of readdirSync(skillsRoot)) {
        const md = join(skillsRoot, name, "SKILL.md");
        if (existsSync(md)) expect(checkCaseBlocks(name, readFileSync(md, "utf8"))).toEqual([]);
    }
});

test("both bundled memory files are identical and within the always-on budget", () => {
    const claude = readFileSync(join(MEMORY_ROOT, "CLAUDE.md"), "utf8");
    expect(readFileSync(join(MEMORY_ROOT, "AGENTS.md"), "utf8")).toBe(claude);
    expect(budgetedBytes(claude)).toBeLessThanOrEqual(MEMORY_BUDGET_BYTES);
});
