/**
 * The config-in-skill safety invariant: a SKILL.md's enigma:config block (rendered per-user
 * from .enigma.json at deploy) is EXCLUDED from computeContentSha, so a user's config choice
 * never reads as a local edit ("tampered") - while any edit OUTSIDE the block still changes the
 * hash. This is what lets a rendered deployment stay byte-different from the sealed template yet
 * hash identically. The full deploy/re-render path is exercised via the CLI e2e; this pins the
 * hash contract deterministically.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { computeContentSha } from "../src/util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const BODY = [
    "---",
    "name: demo",
    "description: demo skill",
    "---",
    "",
    "# Demo",
    "",
    "Static content that IS hashed.",
    "",
    "<!-- enigma:config:start -->",
    "### Active configuration",
    "",
    "- **logo-color-policy** = `__VALUE__`",
    "<!-- enigma:config:end -->",
    "",
    "More static content.",
    "",
].join("\n");

/** Write a one-file skill dir with SKILL.md = BODY with the config value substituted. */
function skillDir(value: string, tail = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "enigma-skillcfg-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), BODY.replace("__VALUE__", value) + tail);
    // skill.json is excluded from the hash anyway; include one to mirror a real skill.
    writeFileSync(join(dir, "skill.json"), JSON.stringify({ name: "demo", config: ["logoColorPolicy"] }));
    return dir;
}

test("the config block value is excluded from the content hash", () => {
    const template = skillDir("{{logoColorPolicy}}");
    const askRendered = skillDir("ask");
    const adaptRendered = skillDir("adapt-logo");
    try {
        const a = computeContentSha(template);
        const b = computeContentSha(askRendered);
        const c = computeContentSha(adaptRendered);
        // Placeholder, "ask" and "adapt-logo" differ ONLY inside the config block -> same hash.
        expect(b).toBe(a);
        expect(c).toBe(a);
    } finally {
        for (const d of [template, askRendered, adaptRendered]) rmSync(d, { recursive: true, force: true });
    }
});

test("an edit OUTSIDE the config block still changes the hash", () => {
    const base = skillDir("ask");
    const edited = skillDir("ask", "A user edit after the block.\n");
    try {
        expect(computeContentSha(edited)).not.toBe(computeContentSha(base));
    } finally {
        for (const d of [base, edited]) rmSync(d, { recursive: true, force: true });
    }
});

// Case blocks live INSIDE the config block, so the whole block (all cases in the template,
// one case in the rendered deployment) is stripped before hashing - both hash identically.
function caseSkillDir(configBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), "enigma-skillcase-"));
    writeFileSync(join(dir, "SKILL.md"), [
        "# Demo", "", "Static content.", "",
        "<!-- enigma:config:start -->", configBody, "<!-- enigma:config:end -->", "",
        "Trailing static content.", "",
    ].join("\n"));
    return dir;
}

test("a full-cases template and a single-rendered-case deployment hash identically", () => {
    const template = caseSkillDir([
        "<!-- enigma:case:logoColorPolicy=ask -->", "ask text", "<!-- enigma:case:end -->",
        "<!-- enigma:case:logoColorPolicy=adapt-logo -->", "adapt-logo text", "<!-- enigma:case:end -->",
    ].join("\n"));
    const renderedAsk = caseSkillDir("ask text");        // what renderSkill leaves for value "ask"
    const renderedAdapt = caseSkillDir("adapt-logo text"); // ...and for "adapt-logo"
    try {
        const t = computeContentSha(template);
        expect(computeContentSha(renderedAsk)).toBe(t);
        expect(computeContentSha(renderedAdapt)).toBe(t);
    } finally {
        for (const d of [template, renderedAsk, renderedAdapt]) rmSync(d, { recursive: true, force: true });
    }
});

/**
 * The code graph's discoverability contract: registering the MCP tools is not enough on its own,
 * because an agent that is never told they exist keeps exploring the repo by hand. The instruction
 * lives in core-engineering-policy (loaded on every engineering task) rather than in the always-on
 * memory kernel, which has no budget left - and it must appear ONLY when the feature is on, or
 * every user pays context for tools their agents cannot call.
 */
test("core-engineering-policy names the code-graph tools only when the toggle is on", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "assets", "skills", "core-engineering-policy", "SKILL.md"), "utf8");
    const render = (codeGraph: boolean): string =>
        skill.replace(/<!-- enigma:case:([A-Za-z0-9]+)=(\S+) -->\n?([\s\S]*?)<!-- enigma:case:end -->\n?/g,
            (_m, key: string, value: string, body: string) => (String(({ codeGraph } as Record<string, unknown>)[key]) === value ? body : ""));

    expect(skill).toContain("<!-- enigma:config:start -->");
    expect(render(true)).toContain("enigma_codegraph_");
    expect(render(false)).not.toContain("enigma_codegraph_");
    // The block has to sit inside the hash-excluded region, or a rendered deployment reads as tampered.
    const cfgStart = skill.indexOf("<!-- enigma:config:start -->");
    const cfgEnd = skill.indexOf("<!-- enigma:config:end -->");
    const caseStart = skill.indexOf("<!-- enigma:case:codeGraph=true -->");
    expect(caseStart).toBeGreaterThan(cfgStart);
    expect(caseStart).toBeLessThan(cfgEnd);
});
