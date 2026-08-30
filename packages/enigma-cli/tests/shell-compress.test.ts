/**
 * Command-aware output compression: the right filter is picked for a command, the
 * signal survives, and the engine refuses to guess on content it was not given a
 * command for. The fixture file carries one real output sample per filter with the
 * lines that must still be readable afterwards - the guarantee that matters is not
 * how much was removed but that nothing essential went with it. Temp HOME (set
 * BEFORE import) isolates the CCR cache, as in compress.test.ts.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-shell-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { compress } = await import("../src/compress");
const { crushShell, matchShellFilter, commandTail } = await import("../src/compress/shell");
const { SHELL_FILTERS } = await import("../src/compress/shell-filters");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

interface Fixture {
    filter: string;
    name: string;
    command: string | null;
    input: string;
    essential: string[];
}

const fixtures: Fixture[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/shell-output.json"), "utf8"));

test("every built-in filter has a unique id and something to match on", () => {
    const ids = SHELL_FILTERS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of SHELL_FILTERS) {
        expect(f.commands?.length || f.patterns?.length).toBeGreaterThan(0);
        expect(f.label.length).toBeGreaterThan(0);
    }
});

test("every built-in filter's patterns compile", () => {
    for (const f of SHELL_FILTERS) {
        const groups = [f.commands, f.patterns, f.keep, f.drop, f.collapse, f.anchor];
        for (const group of groups) for (const p of group ?? []) expect(() => new RegExp(p, "i")).not.toThrow();
        for (const v of f.verdicts ?? []) {
            expect(() => new RegExp(v.pattern, "im")).not.toThrow();
            if (v.unless) expect(() => new RegExp(v.unless, "im")).not.toThrow();
        }
    }
});

test("each fixture's command selects a filter that recognises that output", () => {
    for (const fx of fixtures) {
        if (!fx.command) continue;
        const matched = matchShellFilter(fx.input, fx.command);
        expect(matched, `${fx.filter}: ${fx.name}`).not.toBeNull();
    }
});

test("compressing a real output sample never drops its essential lines", () => {
    for (const fx of fixtures) {
        const filter = SHELL_FILTERS.find((f) => f.id === fx.filter);
        expect(filter, fx.filter).toBeDefined();
        const { compressed } = crushShell(fx.input, filter!);
        for (const line of fx.essential) {
            expect(compressed, `${fx.filter}/${fx.name} lost: ${line}`).toContain(line.trim());
        }
    }
});

test("compression never grows the output", () => {
    for (const fx of fixtures) {
        const filter = SHELL_FILTERS.find((f) => f.id === fx.filter)!;
        const { compressed } = crushShell(fx.input, filter);
        expect(compressed.length, `${fx.filter}/${fx.name}`).toBeLessThanOrEqual(fx.input.length);
    }
});

test("an error line survives a filter whose whitelist does not know it", () => {
    // The npm filter's keep list was written against npm 8's `ERR!`; npm 9 renamed that
    // to `npm error`, and without the always-keep guard the failure was the one thing
    // this compressed away. Every error dialect below has to reach the other side.
    const noise = Array.from({ length: 120 }, (_, i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} 34ms`);
    const errors = [
        "npm error code ERESOLVE",
        "npm ERR! peer dep missing",
        "error TS2345: Argument of type 'string' is not assignable",
        "fatal: not a git repository",
        "panic: runtime error: index out of range",
        "Traceback (most recent call last)",
        "java.lang.NullPointerException: name is null",
        "FAILED tests/test_login.py::test_expired",
        "found 3 vulnerabilities (1 high)",
    ];
    const filter = SHELL_FILTERS.find((f) => f.id === "npm-install")!;
    const { compressed } = crushShell([...noise, ...errors].join("\n"), filter);
    for (const line of errors) expect(compressed, `lost: ${line}`).toContain(line);
    expect(compressed).not.toContain("pkg-60");
});

test("a clean run collapses to its verdict line", () => {
    const filter = SHELL_FILTERS.find((f) => f.id === "prettier")!;
    const input = Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts 12ms`).join("\n");
    const { compressed, offloaded } = crushShell(input, filter);
    expect(compressed.split("\n")).toHaveLength(1);
    expect(offloaded).toBeGreaterThan(30);
});

test("failing test output keeps the failure and the summary, drops the passes", () => {
    const passes = Array.from({ length: 300 }, (_, i) => ` ✓ src/pass-${i}.test.ts (1)`).join("\n");
    const input = `${passes}\n FAIL src/broken.test.ts > explodes\nError: boom\nTest Files 1 failed | 300 passed\nTests 1 failed | 300 passed`;
    const r = compress(input, { command: "npx vitest run", noStats: true });
    expect(r.contentType).toBe("shell");
    expect(r.filter).toBe("test-vitest");
    expect(r.compressed).toContain("FAIL src/broken.test.ts");
    expect(r.compressed).toContain("Error: boom");
    expect(r.compressed).toContain("Test Files 1 failed");
    expect(r.compressed).not.toContain("src/pass-100.test.ts");
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore / 4);
});

test("the compressed output stays reversible through CCR", () => {
    const input = `${Array.from({ length: 200 }, (_, i) => `remote: Counting objects: ${i}`).join("\n")}\nfatal: repository not found`;
    const r = compress(input, { command: "git clone git@example.com:repo.git", noStats: true });
    expect(r.ccrHash).toBeTruthy();
    expect(r.compressed).toContain(`<<enigma:ccr:${r.ccrHash}`);
});

test("prose with no command is never treated as command output", () => {
    const prose = Array.from({ length: 40 }, () => "The quick brown fox jumps over the lazy dog and keeps going.").join("\n");
    expect(matchShellFilter(prose)).toBeNull();
    expect(compress(prose, { noStats: true }).contentType).not.toBe("shell");
});

test("an explicit content type outranks the command filter", () => {
    const input = `${Array.from({ length: 40 }, (_, i) => `ok ${i}`).join("\n")}\nFAIL something`;
    expect(compress(input, { command: "npm test", type: "text", noStats: true }).contentType).toBe("text");
});

test("commandTail reads the stage that produced the output", () => {
    expect(commandTail("cd repo && npm test")).toBe("npm test");
    expect(commandTail("$ git status --short")).toBe("git status --short");
    expect(commandTail("cat log | grep -i error")).toBe("grep -i error");
    expect(commandTail("CI=1 FORCE_COLOR=0 vitest run")).toBe("vitest run");
});

test("output shorter than a few lines is left alone", () => {
    const filter = SHELL_FILTERS.find((f) => f.id === "git-status")!;
    const input = "M  src/a.ts\n?? src/b.ts";
    expect(crushShell(input, filter).offloaded).toBe(0);
});

test("a filter whose keep patterns match nothing does not blank the output", () => {
    for (const filter of SHELL_FILTERS) {
        if (!filter.keep?.length) continue;
        const input = Array.from({ length: 12 }, (_, i) => `zzz-unmatchable-line-${i}`).join("\n");
        const { compressed } = crushShell(input, filter);
        expect(compressed.trim(), filter.id).not.toBe("");
    }
});
