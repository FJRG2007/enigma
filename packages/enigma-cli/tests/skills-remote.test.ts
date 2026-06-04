/**
 * Unit tests for the GitHub remote-skill cache (skills-remote.ts): adoption of
 * newer sealed skills, rejection of unsealed/foreign/stale payloads, and fault
 * tolerance when the GitHub API fails. All network I/O is a stubbed global
 * fetch; the cache lives under a per-test temp HOME. Run with: bun test
 */
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContentSha } from "../src/util";

beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "enigma-test-home-"));
    process.env.USERPROFILE = home; // Windows homedir()
    process.env.HOME = home;        // POSIX homedir()
});

// Imported after the env hooks are declared; the module resolves every path
// lazily (per call), so each test sees its own fake HOME.
const { refreshRemoteSkills, cachedRemoteSkills } = await import("../src/skills-remote");

const COMMIT = "a".repeat(40);
const PREFIX = "packages/enigma-cli/assets/skills";

interface FakeSkill { name: string; version: string; provider?: string; sha?: string; }

/** Author a sealed remote skill the way `enigma seal` would (real content sha). */
function sealedSkill(s: FakeSkill): { md: string; meta: string } {
    const md = `---\nname: ${s.name}\ndescription: test skill\n---\n\nBody for ${s.name} v${s.version}.\n`;
    const dir = mkdtempSync(join(tmpdir(), "enigma-test-skill-"));
    writeFileSync(join(dir, "SKILL.md"), md);
    const sha = s.sha ?? computeContentSha(dir);
    const meta = JSON.stringify({ name: s.name, version: s.version, provider: s.provider ?? "FJRG2007/enigma", sha }, null, 2) + "\n";
    return { md, meta };
}

/**
 * Stub global fetch with a fake GitHub serving `skills` at a pinned commit.
 * Returns a counter of raw-file fetches, to assert the sha cache skips downloads.
 */
function stubFetch(skills: FakeSkill[]): { rawCalls: () => number } {
    const files = new Map<string, string>();
    const tree: Array<{ path: string; type: string; sha: string; size: number }> = [];
    let rawCalls = 0;
    for (const s of skills) {
        const { md, meta } = sealedSkill(s);
        for (const [rel, body] of [["SKILL.md", md], ["skill.json", meta]] as const) {
            tree.push({ path: `${PREFIX}/${s.name}/${rel}`, type: "blob", sha: `blob-${s.name}-${rel}-${s.version}`, size: body.length });
            files.set(`https://raw.githubusercontent.com/FJRG2007/enigma/${COMMIT}/${PREFIX}/${s.name}/${rel}`, body);
        }
    }
    globalThis.fetch = (async (url: string | URL) => {
        const u = String(url);
        if (u === "https://api.github.com/repos/FJRG2007/enigma/commits/main") return Response.json({ sha: COMMIT });
        if (u === `https://api.github.com/repos/FJRG2007/enigma/git/trees/${COMMIT}?recursive=1`) return Response.json({ tree });
        rawCalls++;
        const body = files.get(u);
        return body !== undefined ? new Response(body) : new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { rawCalls: () => rawCalls };
}

test("adopts a strictly newer sealed skill from GitHub", async () => {
    stubFetch([{ name: "alpha-policy", version: "1.1.0" }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(r.error).toBeNull();
    expect(r.updated).toEqual(["alpha-policy"]);
    const cached = cachedRemoteSkills();
    expect(cached.map((c) => c.name)).toEqual(["alpha-policy"]);
    expect(cached[0]!.meta.version).toBe("1.1.0");
});

test("adopts a repo skill this package does not bundle yet", async () => {
    stubFetch([{ name: "brand-new-policy", version: "1.0.0" }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: {} });
    expect(r.updated).toEqual(["brand-new-policy"]);
});

test("skips a remote skill that is not strictly newer than the bundle", async () => {
    stubFetch([{ name: "alpha-policy", version: "1.1.0" }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.1.0" } });
    expect(r.error).toBeNull();
    expect(r.updated).toEqual([]);
    expect(cachedRemoteSkills()).toEqual([]);
});

test("rejects a skill from a foreign provider", async () => {
    stubFetch([{ name: "alpha-policy", version: "9.9.9", provider: "someone-else" }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(r.updated).toEqual([]);
    expect(cachedRemoteSkills()).toEqual([]);
});

test("rejects a download whose content does not match its sealed sha", async () => {
    stubFetch([{ name: "alpha-policy", version: "9.9.9", sha: "0".repeat(64) }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(r.error).toBeNull();
    expect(r.updated).toEqual([]);
    expect(cachedRemoteSkills()).toEqual([]);
});

test("degrades gracefully when the GitHub API is unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    const r = await refreshRemoteSkills({ force: true, bundledVersions: {} });
    expect(r.checked).toBe(true);
    expect(r.updated).toEqual([]);
    expect(r.error).toBeTruthy();
});

test("degrades gracefully on an API error status (e.g. rate limit)", async () => {
    globalThis.fetch = (async () => new Response("rate limited", { status: 403 })) as typeof fetch;
    const r = await refreshRemoteSkills({ force: true, bundledVersions: {} });
    expect(r.error).toBe("GitHub API 403");
});

test("throttles repeat checks unless forced", async () => {
    stubFetch([{ name: "alpha-policy", version: "1.1.0" }]);
    await refreshRemoteSkills({ force: true, bundledVersions: {} });
    const r = await refreshRemoteSkills({ force: false, bundledVersions: {} });
    expect(r.checked).toBe(false);
});

test("sha cache: an unchanged tree downloads nothing on a re-check (adopted skill)", async () => {
    const stub = stubFetch([{ name: "alpha-policy", version: "1.1.0" }]);
    await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    const after = stub.rawCalls();
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(r.updated).toEqual([]);
    expect(stub.rawCalls()).toBe(after); // no raw fetches at all on the second pass
});

test("sha cache: a gated (not newer) skill is not re-fetched on an unchanged tree", async () => {
    const stub = stubFetch([{ name: "alpha-policy", version: "1.0.0" }]);
    await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    const after = stub.rawCalls();
    expect(after).toBe(1); // only skill.json was consulted, nothing downloaded
    await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(stub.rawCalls()).toBe(after);
});
