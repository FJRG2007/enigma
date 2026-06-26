/**
 * autoskills detection: drive detectTechnologies/collectSkills over synthetic project
 * fixtures (temp dirs) and assert the detected technologies, combos and frontend flag.
 * Network-free - only the detection core is exercised here (the installer hits the network
 * and is verified manually / by the e2e install run).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { detectTechnologies, collectSkills, parseSkillRef } from "../src/autoskills";

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "enigma-autoskills-"));
    for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
    }
    return dir;
}

test("detects a Next.js + Supabase stack from package.json and the combo", () => {
    const dir = project({
        "package.json": JSON.stringify({
            dependencies: { next: "15.0.0", react: "19.0.0", "@supabase/supabase-js": "2.0.0" },
        }),
    });
    try {
        const r = detectTechnologies(dir);
        const ids = r.detected.map((t) => t.id);
        expect(ids).toContain("nextjs");
        expect(ids).toContain("react");
        expect(ids).toContain("supabase");
        expect(r.isFrontend).toBe(true);
        expect(r.combos.map((c) => c.id)).toContain("nextjs-supabase");
        // Frontend bonus skills are folded in for a frontend project.
        const skills = collectSkills(r).map((s) => s.skill);
        expect(skills).toContain("anthropics/skills/frontend-design");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("detects config-file-only and content-pattern technologies", () => {
    const dir = project({
        "astro.config.mjs": "export default {}",
        "Cargo.toml": "[package]\nname=\"x\"",
        "pubspec.yaml": "name: app\nflutter:\n  sdk: flutter\n",
    });
    try {
        const ids = detectTechnologies(dir).detected.map((t) => t.id);
        expect(ids).toContain("astro");      // configFiles
        expect(ids).toContain("rust");       // configFiles (Cargo.toml)
        expect(ids).toContain("flutter");    // configFileContent pattern "flutter:"
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("detects packagePatterns (scoped packages) and Ruby gems", () => {
    const dir = project({
        "package.json": JSON.stringify({ dependencies: { "@clerk/nextjs": "5.0.0" } }),
        "Gemfile": 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
    });
    try {
        const ids = detectTechnologies(dir).detected.map((t) => t.id);
        expect(ids).toContain("clerk");   // packagePatterns /^@clerk\//
        expect(ids).toContain("rails");   // gems
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an empty directory detects nothing", () => {
    const dir = project({ "README.md": "# empty" });
    try {
        const r = detectTechnologies(dir);
        expect(r.detected).toHaveLength(0);
        expect(r.isFrontend).toBe(false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("parseSkillRef splits owner/repo/skill and bare URLs", () => {
    expect(parseSkillRef("astrolicious/agent-skills/astro")).toEqual({
        repo: "astrolicious/agent-skills", skillName: "astro", full: "astrolicious/agent-skills/astro",
    });
    expect(parseSkillRef("https://example.com/x").skillName).toBe("");
});
