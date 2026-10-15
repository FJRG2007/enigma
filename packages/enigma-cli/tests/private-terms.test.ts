/**
 * Private terms: the user's list of real names, handles and server names that must never reach
 * a tracked file. One matcher serves the commit guard and the edit-time guardrail, so both are
 * driven here: the matcher's word rules, the URL exemption, the global-only list, a staged
 * commit, and the guardrail. Every term below is invented - tests use anonymous data.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuard } from "../src/guard";
import { execFileSync } from "node:child_process";
import { test, expect, setDefaultTimeout } from "bun:test";
import { runAttributionGuardHook } from "../src/attribution-guard";
import { readGlobalGuard, setGuardList } from "../src/guard-config";
import { privateTermLeak, redactPublished } from "../src/guardrails";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { privateTermLines, privateTermMatcher, readPrivateTerms, redactPrivateTerms } from "../src/private-terms";

setDefaultTimeout(60_000);

const TERMS = ["Zephyr Quill", "Orla", "moonhaven"];

function hits(text: string, terms = TERMS): number[] {
    return privateTermLines(text, privateTermMatcher(terms)!);
}

test("matches a term as a whole word in any case and spacing", () => {
    expect(hits("const player = \"ZephyrQuill42\";")).toEqual([1]); // joined, with a trailing number
    expect(hits("name: zephyr_quill")).toEqual([1]);
    expect(hits("ZEPHYR QUILL teleported")).toEqual([1]);
    expect(hits("by Orla.")).toEqual([1]);
    expect(hits("const moonhavenServer = 1;")).toEqual([1]); // camelCase join
    expect(hits("ok\n// Moonhaven seed\nok")).toEqual([2]);
});

test("does not match a term inside a longer word", () => {
    expect(hits("\"Asia/Gorlavsk\": \"RU\"")).toEqual([]);
    expect(hits("const borla = 1; orlando();")).toEqual([]);
    expect(hits("supermoonhavens")).toEqual([]);
});

test("leaves URLs alone and returns nothing without terms", () => {
    expect(hits("see https://example.test/orla/moonhaven")).toEqual([]);
    expect(privateTermMatcher([])).toBeNull();
    expect(privateTermMatcher(["  "])).toBeNull();
    expect(hits("a.b(c)", ["a.b(c)"])).toEqual([1]); // regex metacharacters are literal
});

/** A synthetic home holding the global guard list; restored afterwards. */
function withHome<T>(fn: (home: string) => T): T {
    const home = mkdtempSync(join(tmpdir(), "enigma-private-"));
    const prev = process.env.ENIGMA_CONFIG_HOME;
    process.env.ENIGMA_CONFIG_HOME = home;
    try { return fn(home); } finally {
        if (prev === undefined) delete process.env.ENIGMA_CONFIG_HOME; else process.env.ENIGMA_CONFIG_HOME = prev;
        rmSync(home, { recursive: true, force: true });
    }
}

test("the list lives in the global guard config and drops terms too short to be safe", () => {
    withHome(() => {
        setGuardList("privateTerms", ["Orla", "ab", "Orla"]);
        expect(readGlobalGuard().privateTerms).toEqual(["Orla", "ab"]);
        expect(readPrivateTerms()).toEqual(["Orla"]);
    });
});

test("the commit guard blocks a staged line carrying a private term, without echoing it", () => {
    withHome(() => {
        setGuardList("privateTerms", ["Zephyr Quill"]);
        const dir = mkdtempSync(join(tmpdir(), "enigma-private-repo-"));
        const git = (...args: string[]): void => { execFileSync("git", args, { cwd: dir, windowsHide: true, stdio: "ignore" }); };
        const prev = process.cwd();
        try {
            git("init", "-q", ".");
            mkdirSync(join(dir, "test"));
            writeFileSync(join(dir, "test", "visit.test.ts"), "const a = 1;\nexpect(seen(\"ZephyrQuill\")).toBe(true);\n");
            writeFileSync(join(dir, "clean.ts"), "export const player = \"Player One\";\n");
            git("add", "-A");
            process.chdir(dir);
            const result = runGuard();
            expect(result.ok).toBe(false);
            expect(result.findings.filter((f) => f.rule === "private-term").map((f) => [f.file, f.line])).toEqual([["test/visit.test.ts", 2]]);
            expect(result.blocks.join("\n")).not.toContain("Zephyr");
        } finally {
            process.chdir(prev);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("a commit is checked on the lines it adds, so a term already in the file never blocks it", () => {
    withHome(() => {
        setGuardList("privateTerms", ["Zephyr Quill"]);
        const dir = mkdtempSync(join(tmpdir(), "enigma-private-repo-"));
        const git = (...args: string[]): void => { execFileSync("git", args, { cwd: dir, windowsHide: true, stdio: "ignore" }); };
        const prev = process.cwd();
        try {
            git("init", "-q", ".");
            git("config", "user.email", "test@example.test");
            git("config", "user.name", "Test User");
            writeFileSync(join(dir, "LICENSE"), "Copyright Zephyr Quill\n");
            writeFileSync(join(dir, "naïve ++.md"), "intro\n");
            git("add", "-A");
            git("commit", "-q", "--no-verify", "-m", "init");
            writeFileSync(join(dir, "LICENSE"), "Copyright Zephyr Quill\nAll rights reserved.\n");
            writeFileSync(join(dir, "naïve ++.md"), "intro\n++ zephyr_quill\n");
            git("add", "-A");
            process.chdir(dir);
            const staged = runGuard();
            expect(staged.findings.filter((f) => f.rule === "private-term").map((f) => [f.file, f.line])).toEqual([["naïve ++.md", 2]]);
            git("commit", "-q", "--no-verify", "-m", "next");
            const range = runGuard({ range: "HEAD~1..HEAD" });
            expect(range.findings.filter((f) => f.rule === "private-term").map((f) => [f.file, f.line])).toEqual([["naïve ++.md", 2]]);
            const all = runGuard({ all: true });
            expect(all.findings.filter((f) => f.rule === "private-term").map((f) => [f.file, f.line])).toEqual([["LICENSE", 1], ["naïve ++.md", 2]]);
        } finally {
            process.chdir(prev);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

test("the guardrail reports the line at edit time, follows list changes, and says nothing without a list", () => {
    withHome((home) => {
        const content = "a\nconst server = \"Moonhaven\";\n";
        expect(privateTermLeak(content)).toEqual([]);
        writeFileSync(join(home, ".enigma-guard.json"), JSON.stringify({ privateTerms: ["moonhaven"] }));
        expect(privateTermLeak(content)).toEqual([{ line: 2, detail: "a private term from your list" }]);
    });
});

// The gate writes PR titles, bodies and commit subjects on its own; a fixer agent once described
// its own fix by naming the private term it had just removed. Text the gate sends is scrubbed.
test("published text has every private term replaced by a neutral word, URLs kept", () => {
    const body = "Rename the moonhaven-0 fixtures; Zephyr Quill asked for it (see https://example.test/moonhaven)";
    expect(redactPrivateTerms(body, TERMS)).toBe("Rename the example-0 fixtures; example asked for it (see https://example.test/moonhaven)");
    expect(redactPrivateTerms("Gorlavsk stays", TERMS)).toBe("Gorlavsk stays");
    expect(redactPrivateTerms("untouched", [])).toBe("untouched");
    withHome(() => {
        setGuardList("privateTerms", ["Orla"]);
        expect(redactPublished("thanks orla")).toBe("thanks example");
    });
});

test("a commit or PR message carrying a private term is refused without echoing it", () => {
    withHome(() => {
        setGuardList("privateTerms", ["moonhaven"]);
        const run = (command: string): number => runAttributionGuardHook(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.cwd() }));
        expect(run("git commit -q -m \"test: rename the moonhaven-0 fixtures\"")).toBe(2);
        expect(run("gh pr edit 7 --title \"chore: tidy\" --body \"drops moonhaven\"")).toBe(2);
        expect(run("git commit -q -m \"test: use generic fixture names\"")).toBe(0);
        // Where the command runs is not what it publishes.
        expect(run("cd /work/moonhaven && git commit -q -m \"test: use generic fixture names\"")).toBe(0);
    });
});
