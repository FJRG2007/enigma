/**
 * Vendor the entire midudev/autoskills community skill registry into this repo so
 * the CLI, web, and dashboard all read skills from ONE in-repo location instead of
 * fetching third-party content on demand.
 *
 * Source of truth becomes `assets/skills-registry/`:
 *   assets/skills-registry/registry.json          - the local index (name -> meta)
 *   assets/skills-registry/<skill>/<files...>      - each skill's verified content
 *
 * Each file is sha256-verified and each skill's bundleHash is checked before it is
 * written, exactly like the on-demand installer did. Per-skill `source`/`commitSha`
 * attribution is preserved in registry.json (vendoring third-party content requires
 * keeping provenance + license attribution).
 *
 * Re-runnable: a skill whose bundleHash already matches on disk is skipped. Run with
 * `node scripts/vendor-skills.mjs`.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";

const REGISTRY_MAIN = "https://raw.githubusercontent.com/midudev/autoskills/main/packages/autoskills/skills-registry";
const OUT_DIR = join(process.cwd(), "assets", "skills-registry");
const CONCURRENCY = 12;
const TIMEOUT_MS = 20000;

function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}

async function fetchBuf(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "enigma-vendor" } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

/** Downloads + verifies one skill, writing its files under OUT_DIR/<name>. */
async function vendorSkill(name, entry) {
    const skillDir = join(OUT_DIR, name);
    const downloaded = [];
    for (const rel of entry.files) {
        const norm = rel.split("\\").join("/");
        const expected = entry.sha256[rel] || entry.sha256[norm];
        if (!expected) return { name, ok: false, reason: `no sha256 for ${rel}` };
        const url = `${REGISTRY_MAIN}/${[name, ...norm.split("/")].map(encodeURIComponent).join("/")}`;
        const buf = await fetchBuf(url);
        if (!buf) return { name, ok: false, reason: `download failed ${rel}` };
        if (sha256(buf) !== expected) return { name, ok: false, reason: `sha256 mismatch ${rel}` };
        downloaded.push({ rel: norm, buf });
    }
    const bundle = sha256(Buffer.from(downloaded.map(f => `${f.rel}:${sha256(f.buf)}`).sort().join("\n")));
    if (bundle !== entry.bundleHash) return { name, ok: false, reason: "bundleHash mismatch" };
    await rm(skillDir, { recursive: true, force: true });
    for (const f of downloaded) {
        const dest = join(skillDir, f.rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.buf);
    }
    return { name, ok: true, files: downloaded.length };
}

async function main() {
    console.log("Fetching registry index...");
    const idxBuf = await fetchBuf(`${REGISTRY_MAIN}/index.json`);
    if (!idxBuf) throw new Error("could not fetch registry index.json");
    const idx = JSON.parse(idxBuf.toString("utf8"));
    const entries = idx.skills ?? idx;
    const names = Object.keys(entries);
    console.log(`${names.length} skills to vendor.`);

    await mkdir(OUT_DIR, { recursive: true });

    // Skip skills whose bundleHash already matches a previously-written marker.
    const localIndexPath = join(OUT_DIR, "registry.json");
    let prior = {};
    if (existsSync(localIndexPath)) {
        try {
            prior = JSON.parse(await readFile(localIndexPath, "utf8")).skills ?? {};
        } catch {
            prior = {};
        }
    }

    const results = [];
    const localIndex = {};
    let i = 0;
    async function worker() {
        while (i < names.length) {
            const name = names[i++];
            const entry = entries[name];
            if (prior[name]?.bundleHash === entry.bundleHash && existsSync(join(OUT_DIR, name))) {
                results.push({ name, ok: true, skipped: true });
            } else {
                const r = await vendorSkill(name, entry);
                results.push(r);
                if (!r.ok) console.error(`  FAIL ${name}: ${r.reason}`);
            }
            localIndex[name] = {
                source: entry.source,
                skillPath: entry.skillPath,
                commitSha: entry.commitSha,
                files: entry.files,
                sha256: entry.sha256,
                bundleHash: entry.bundleHash,
                review: entry.review
            };
            if (results.length % 25 === 0) console.log(`  ${results.length}/${names.length}`);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const ok = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    // Persist only successfully-vendored skills in the local index.
    const okNames = new Set(ok.map(r => r.name));
    const indexSkills = {};
    for (const n of Object.keys(localIndex)) {
        if (okNames.has(n)) indexSkills[n] = localIndex[n];
    }
    await writeFile(
        localIndexPath,
        `${JSON.stringify({ generator: "vendor-skills.mjs", count: ok.length, origin: "midudev/autoskills", skills: indexSkills }, null, 2)}\n`
    );

    console.log(`\nDone: ${ok.length} vendored (${ok.filter(r => r.skipped).length} unchanged), ${failed.length} failed.`);
    if (failed.length) {
        console.log("Failed skills:", failed.map(r => r.name).join(", "));
        process.exitCode = 1;
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
