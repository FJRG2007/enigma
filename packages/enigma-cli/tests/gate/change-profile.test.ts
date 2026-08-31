/**
 * Right-sizing a gate run to its diff. The property that matters is the direction of
 * the error: a file the profiler does not recognise must run the FULL pipeline, so
 * every "is this code" question is checked in the conservative direction too.
 */
import { test, expect } from "bun:test";

const { profileChange, isCode } = await import("../../src/gate/pipeline/profile");

test("a documentation-only change skips the steps that cannot say anything", () => {
    const profile = profileChange([".claude/commands/gate.md", "README.md"]);
    expect(profile.hasCode).toBe(false);
    expect(profile.skip).toEqual(["test", "document"]);
    expect(profile.reason).toContain("no executable file changed");
});

test("review, push, pr and ci are never skipped - prose can still be wrong", () => {
    const profile = profileChange(["docs/notes/gate.md"]);
    for (const step of ["intent", "rebase", "review", "lint", "push", "pr", "ci"]) {
        expect(profile.skip).not.toContain(step);
    }
});

test("one source file in the diff runs the whole pipeline", () => {
    expect(profileChange(["README.md", "src/auth.ts"]).skip).toEqual([]);
    expect(profileChange(["src/auth.ts"]).hasCode).toBe(true);
    // Size is deliberately not an input: a one-line auth change gets every step.
    expect(profileChange(["src/auth.ts"]).skip).toEqual([]);
});

test("an unreadable diff runs everything", () => {
    expect(profileChange([]).skip).toEqual([]);
    expect(profileChange(["", "  "]).skip).toEqual([]);
});

test("an unrecognised file counts as code, so the gate over-runs rather than under-runs", () => {
    expect(isCode("Dockerfile")).toBe(true);
    expect(isCode("Makefile")).toBe(true);
    expect(isCode("scripts/deploy")).toBe(true);
    expect(isCode("src/thing.zig")).toBe(true);
    expect(isCode("src/thing.nim")).toBe(true);
    expect(profileChange(["Dockerfile"]).skip).toEqual([]);
});

test("the code list covers the languages a project actually ships", () => {
    for (const path of [
        "a.ts", "a.tsx", "a.js", "a.mjs", "a.vue", "a.svelte", "a.astro",
        "a.py", "a.rb", "a.go", "a.rs", "a.java", "a.kt", "a.swift", "a.c", "a.cpp",
        "a.cs", "a.php", "a.dart", "a.lua", "a.sql", "a.sh", "a.ps1",
    ]) expect(isCode(path), path).toBe(true);
});

test("prose, config and assets are inert", () => {
    for (const path of [
        "a.md", "a.mdx", "a.txt", "a.rst", "a.json", "a.yaml", "a.yml", "a.toml",
        "a.ini", "a.csv", "package-lock.json", "a.png", "a.svg", "a.woff2", "a.pdf",
        "LICENSE", "CHANGELOG", "README", ".gitignore", ".editorconfig", ".nvmrc",
    ]) expect(isCode(path), path).toBe(false);
});

test("a file's class is decided by its own name, not its directory", () => {
    expect(isCode("src/components/Button.md")).toBe(false);
    expect(isCode("docs/examples/server.ts")).toBe(true);
});
