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
function sealedSkill(s: FakeSkill): { md: string; meta: string; } {
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
function stubFetch(skills: FakeSkill[]): { rawCalls: () => number; } {
    const files = new Map<string, string>();
    const tree: Array<{ path: string; type: string; sha: string; size: number; }> = [];
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
        // Discovery manifest endpoint: resolves the source back to this fake repo
        // (so the rest of the suite exercises the default path). Not a raw download.
        if (u.endsWith("/skills-manifest.json")) return Response.json({
            schema: 1,
            source: { repo: "FJRG2007/enigma", ref: "main", skillsPrefix: `${PREFIX}/` },
            apiBase: "https://api.github.com",
            rawBase: "https://raw.githubusercontent.com",
        });
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

test("honors a discovery manifest that relocates the skills source", async () => {
    // Manifest points at a renamed repo and a different in-repo prefix; the
    // refresh must follow it (commit/tree/raw all served from the new location).
    const newRepo = "OtherOrg/moved";
    const newPrefix = "skills";
    const { md, meta } = sealedSkill({ name: "alpha-policy", version: "2.0.0" });
    const tree = [
        { path: `${newPrefix}/alpha-policy/SKILL.md`, type: "blob", sha: "b1", size: md.length },
        { path: `${newPrefix}/alpha-policy/skill.json`, type: "blob", sha: "b2", size: meta.length },
    ];
    globalThis.fetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/skills-manifest.json")) return Response.json({ source: { repo: newRepo, skillsPrefix: `${newPrefix}/` } });
        if (u === `https://api.github.com/repos/${newRepo}/commits/main`) return Response.json({ sha: COMMIT });
        if (u === `https://api.github.com/repos/${newRepo}/git/trees/${COMMIT}?recursive=1`) return Response.json({ tree });
        if (u === `https://raw.githubusercontent.com/${newRepo}/${COMMIT}/${newPrefix}/alpha-policy/SKILL.md`) return new Response(md);
        if (u === `https://raw.githubusercontent.com/${newRepo}/${COMMIT}/${newPrefix}/alpha-policy/skill.json`) return new Response(meta);
        return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(r.error).toBeNull();
    expect(r.updated).toEqual(["alpha-policy"]);
    expect(cachedRemoteSkills()[0]!.meta.version).toBe("2.0.0");
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

// --- pinning the ref (`install --ref <tag|sha>`) ---------------------------------------

const TAG_COMMIT = "b".repeat(40);

/**
 * A fake GitHub that answers for BOTH `main` and one tag, so a test can assert which ref
 * the refresh actually asked for. The manifest claims `ref: main`, which a pin must beat.
 */
function stubRefAwareFetch(tag: string, skills: FakeSkill[]): { refsAsked: () => string[]; } {
    const files = new Map<string, string>();
    const tree: Array<{ path: string; type: string; sha: string; size: number; }> = [];
    const refsAsked: string[] = [];
    for (const s of skills) {
        const { md, meta } = sealedSkill(s);
        for (const [rel, body] of [["SKILL.md", md], ["skill.json", meta]] as const) {
            tree.push({ path: `${PREFIX}/${s.name}/${rel}`, type: "blob", sha: `blob-${s.name}-${rel}`, size: body.length });
            for (const commit of [COMMIT, TAG_COMMIT]) {
                files.set(`https://raw.githubusercontent.com/FJRG2007/enigma/${commit}/${PREFIX}/${s.name}/${rel}`, body);
            }
        }
    }
    globalThis.fetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/skills-manifest.json")) return Response.json({
            schema: 1,
            source: { repo: "FJRG2007/enigma", ref: "main", skillsPrefix: `${PREFIX}/` },
        });
        const commits = /\/repos\/FJRG2007\/enigma\/commits\/(.+)$/.exec(u);
        if (commits) {
            refsAsked.push(commits[1]!);
            return Response.json({ sha: commits[1] === tag ? TAG_COMMIT : COMMIT });
        }
        const trees = /\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(u);
        if (trees) return Response.json({ tree });
        const body = files.get(u);
        return body !== undefined ? new Response(body) : new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { refsAsked: () => refsAsked };
}

test("--ref pins the source ref over the discovery manifest and reports the commit it resolved to", async () => {
    const { skillsOrigin } = await import("../src/skills-remote");
    const stub = stubRefAwareFetch("v9.9.9", [{ name: "alpha-policy", version: "1.1.0" }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" }, ref: "v9.9.9" });
    expect(r.error).toBeNull();
    expect(stub.refsAsked()).toEqual(["v9.9.9"]);  // the manifest's `main` must not win over a pin
    expect(r.ref).toBe("v9.9.9");
    expect(r.commit).toBe(TAG_COMMIT);             // the value a run records to be reproducible
    expect(r.updated).toEqual(["alpha-policy"]);

    // The recorded origin is readable afterwards with no network...
    expect(skillsOrigin("v9.9.9")).toEqual({ repo: "FJRG2007/enigma", ref: "v9.9.9", commit: TAG_COMMIT });
    // ...and never claims a commit for a ref that was not the one fetched.
    expect(skillsOrigin("v1.2.3").commit).toBeNull();
    expect(skillsOrigin().commit).toBeNull();
});

test("without a pin the manifest's ref is still honoured", async () => {
    const { skillsOrigin } = await import("../src/skills-remote");
    const stub = stubRefAwareFetch("v9.9.9", [{ name: "alpha-policy", version: "1.1.0" }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(stub.refsAsked()).toEqual(["main"]);
    expect(r.ref).toBe("main");
    expect(skillsOrigin().commit).toBe(COMMIT);
});

test("a pinned ref adopts ITS skills even when the bundle ships a newer version", async () => {
    // The reproducibility case: pinning to an older tag on a CLI that bundles newer skills.
    // The strictly-newer gate answered that with "fetched nothing" while install still printed
    // the ref as the provenance - a run reporting skills it never installed.
    stubRefAwareFetch("v1.0.0", [{ name: "alpha-policy", version: "1.0.0" }]);
    const r = await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "2.0.0" }, ref: "v1.0.0" });
    expect(r.error).toBeNull();
    expect(r.updated).toEqual(["alpha-policy"]);
    const pinnedCache = cachedRemoteSkills("v1.0.0");
    expect(pinnedCache.map((c) => c.meta.version)).toEqual(["1.0.0"]);
});

test("a pinned install leaves nothing in the cache a later unpinned run would adopt", async () => {
    stubRefAwareFetch("v1.0.0", [{ name: "alpha-policy", version: "1.0.0" }]);
    await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "2.0.0" }, ref: "v1.0.0" });
    // The pin's (older) skills live in their own cache, so the shared one stays empty.
    expect(cachedRemoteSkills("v1.0.0")).toHaveLength(1);
    expect(cachedRemoteSkills()).toEqual([]);
});

test("an offline run reads no remote cache at all, however full it is", async () => {
    stubFetch([{ name: "alpha-policy", version: "1.1.0" }]);
    await refreshRemoteSkills({ force: true, bundledVersions: { "alpha-policy": "1.0.0" } });
    expect(cachedRemoteSkills()).toHaveLength(1);
    const prev = process.env.ENIGMA_OFFLINE;
    try {
        // Standing the fetch down is not enough: a container that ran one online install
        // earlier still holds this cache, and an offline run announces itself as bundled-only.
        process.env.ENIGMA_OFFLINE = "1";
        expect(cachedRemoteSkills()).toEqual([]);
    } finally {
        if (prev === undefined) delete process.env.ENIGMA_OFFLINE; else process.env.ENIGMA_OFFLINE = prev;
    }
});
