/**
 * What install and auto-sync decide for an already-deployed skill. The regression: a release
 * that changed a skill's content without bumping its version was reported "up-to-date" and
 * skipped, so the new content never reached the agents. The deployed skill.json records the
 * sha it was sealed with, so a pristine copy whose recorded sha differs from the source's is
 * stale and must update, while a locally edited copy still reads as tampered.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-skillstatus-"));
process.env.USERPROFILE = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.HOME = HOME;

const { skillStatus } = await import("../src/skills");
const { computeContentSha } = await import("../src/util");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Write a sealed skill (SKILL.md + skill.json carrying its own sha) and return its meta. */
function seal(dir: string, body: string, version = "1.0.0"): { name: string; version: string; sha: string; } {
    writeFileSync(join(dir, "SKILL.md"), body);
    const meta = { name: "demo", version, sha: "" };
    writeFileSync(join(dir, "skill.json"), JSON.stringify(meta));
    meta.sha = computeContentSha(dir);
    writeFileSync(join(dir, "skill.json"), JSON.stringify(meta));
    return meta;
}

/** A source skill sealed at v1 content and a deployed copy of it. */
function deployed(): { src: string; dest: string; meta: { name: string; version: string; sha: string; }; } {
    const root = mkdtempSync(join(HOME, "case-"));
    const src = join(root, "src"), dest = join(root, "dest");
    mkdirSync(src);
    const meta = seal(src, "# Demo\n\nv1\n");
    cpSync(src, dest, { recursive: true });
    return { src, dest, meta };
}

test("a deployed copy of the same content is identical", () => {
    const { dest, meta } = deployed();
    expect(skillStatus(dest, meta).kind).toBe("identical");
});

test("new content under the same version updates instead of being skipped", () => {
    const { src, dest } = deployed();
    const st = skillStatus(dest, seal(src, "# Demo\n\nv1, with a new section\n"));
    expect(st.kind).toBe("update");
    expect(st.from).toBe("1.0.0");
    expect(st.to).toBe("1.0.0");
});

test("a bumped version updates", () => {
    const { src, dest } = deployed();
    expect(skillStatus(dest, seal(src, "# Demo\n\nv2\n", "1.1.0")).kind).toBe("update");
});

test("a locally edited copy is still reported as tampered, not silently updated", () => {
    const { src, dest } = deployed();
    writeFileSync(join(dest, "SKILL.md"), "# Demo\n\nmy own edit\n");
    expect(skillStatus(dest, seal(src, "# Demo\n\nv1, with a new section\n")).kind).toBe("tampered");
});
