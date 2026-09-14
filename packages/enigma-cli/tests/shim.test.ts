/**
 * The shell-integration block: what it writes, that writing it twice is a no-op, and that
 * removing it gives the profile back byte-for-byte. That last one is the property that matters
 * most - the block lives inside a file the user owns and may have spent years building, so a
 * removal that eats a neighbouring line is worse than the bug this feature fixes.
 *
 * The tool list is injected rather than detected, so the assertions do not depend on which
 * agents happen to be installed on the machine running the suite.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-shim-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { applyShim, renderBlock, shimProfilePath, shimStatus } = await import("../src/shim");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Seed the profile with content the user "already had". */
function seedProfile(content: string): string {
    const path = shimProfilePath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
}

test("the block defines a function per tool and delegates to enigma", () => {
    for (const kind of ["powershell", "posix", "fish"] as const) {
        const block = renderBlock(["claude"], kind);
        expect(block, kind).toContain("enigma claude");
        expect(block, kind).toContain(">>> enigma shim >>>");
        expect(block, kind).toContain("<<< enigma shim <<<");
    }
    // Each dialect has to use its OWN function syntax: writing posix syntax into config.fish
    // produces a profile that fails to load, which breaks every new shell.
    expect(renderBlock(["claude"], "powershell")).toContain("function global:claude {");
    expect(renderBlock(["claude"], "posix")).toContain("claude() {");
    expect(renderBlock(["claude"], "fish")).toContain("function claude");
});

test("enabling writes the block and keeps the profile's existing content", () => {
    const path = seedProfile("# my own setup\nSomething-Existing\n");
    const result = applyShim(true, ["claude"]);
    expect(result.changed).toBe(true);
    expect(result.profile).toBe(path);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("# my own setup");
    expect(written).toContain("Something-Existing");
    expect(written).toContain("enigma claude");
});

test("enabling twice with the same tools changes nothing", () => {
    seedProfile("# my own setup\n");
    applyShim(true, ["claude"]);
    const first = readFileSync(shimProfilePath(), "utf8");
    const again = applyShim(true, ["claude"]);
    expect(again.changed).toBe(false);
    expect(readFileSync(shimProfilePath(), "utf8")).toBe(first);
});

test("re-enabling after another agent is installed rewrites the block instead of stacking one", () => {
    seedProfile("# my own setup\n");
    applyShim(true, ["claude"]);
    applyShim(true, ["claude", "kimi"]);
    const written = readFileSync(shimProfilePath(), "utf8");
    expect(written.match(/>>> enigma shim >>>/g)).toHaveLength(1);
    expect(written).toContain("enigma kimi");
});

test("status reports what the profile actually holds", () => {
    seedProfile("# my own setup\n");
    expect(shimStatus().enabled).toBe(false);
    applyShim(true, ["claude"]);
    const status = shimStatus();
    expect(status.enabled).toBe(true);
    expect(status.tools).toContain("claude");
});

test("disabling restores the original profile byte-for-byte", () => {
    const original = "# my own setup\nSomething-Existing\n";
    seedProfile(original);
    applyShim(true, ["claude"]);
    const off = applyShim(false);
    expect(off.changed).toBe(true);
    expect(readFileSync(shimProfilePath(), "utf8")).toBe(original);
});

test("disabling when no block is installed is a no-op", () => {
    seedProfile("# my own setup\n");
    const off = applyShim(false);
    expect(off.changed).toBe(false);
});

test("enabling with no installed tool writes nothing", () => {
    const original = "# my own setup\n";
    seedProfile(original);
    const result = applyShim(true, []);
    expect(result.changed).toBe(false);
    expect(readFileSync(shimProfilePath(), "utf8")).toBe(original);
});
