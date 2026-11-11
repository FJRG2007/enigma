// Vendor Cloudflare's security-audit skill into the Helio agent at
// packages/helio/assets/skills/security-audit. The skill lives in its own repo
// (cloudflare/security-audit-skill, MIT); this is a maintainer tool to refresh the vendored copy.
// The assets are committed (like the rest of Helio), so publish and the on-demand fetch never
// depend on the upstream repo being reachable at build time.
//
// This script vendors the UPSTREAM copy at the pinned commit. The enigma-local patches (picked
// from upstream PRs) and Helio-local edits recorded in the vendored VENDOR.md are applied on top
// by hand after a refresh - this script never discards them silently: it refuses to overwrite
// unless --force is given, so a refresh is a deliberate, reviewed step.
//
// Refresh to a new commit:  node scripts/sync-security-audit.mjs --commit <sha> --force
// Node builtins + the git CLI only. Run by the maintainer, not at user install.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const destDir = join(repoRoot, "packages", "helio", "assets", "skills", "security-audit");
const pinPath = join(destDir, ".source.json");

const SOURCE_REPO = "https://github.com/cloudflare/security-audit-skill.git";
const SKILL_SUBDIR = join("skills", "security-audit");

// Files the vendoring adds that are not in upstream; never overwritten or removed by a refresh.
const LOCAL_ONLY = new Set(["VENDOR.md", ".source.json"]);

function git(args, opts = {}) {
    const res = spawnSync("git", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", windowsHide: true, ...opts });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed (${res.status})`);
    return res.stdout.trim();
}

function arg(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : undefined;
}

function readPin() {
    try { return JSON.parse(readFileSync(pinPath, "utf8")); } catch { return {}; }
}

function main() {
    const pin = readPin();
    const ref = arg("--ref");
    const commit = arg("--commit") || (!ref && pin.commit);
    const force = process.argv.includes("--force");
    if (!commit && !ref) {
        console.error("No commit pinned and no --commit/--ref given. Use --commit <sha> or --ref <branch>.");
        process.exit(1);
    }
    if (existsSync(destDir) && !force) {
        console.error("Refusing to overwrite the vendored skill (enigma-local patches on top). Re-run with --force after you have a plan to re-apply them.");
        process.exit(1);
    }

    const work = join(tmpdir(), `enigma-sa-sync-${process.pid}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
        console.log(`Cloning ${SOURCE_REPO} ...`);
        git(["clone", "--quiet", "--no-checkout", SOURCE_REPO, work]);
        const target = commit || ref;
        git(["fetch", "--quiet", "--depth", "1", "origin", target], { cwd: work });
        git(["checkout", "--quiet", "FETCH_HEAD"], { cwd: work });
        const resolved = git(["rev-parse", "HEAD"], { cwd: work });

        const srcDir = join(work, SKILL_SUBDIR);
        if (!existsSync(srcDir)) throw new Error(`${SKILL_SUBDIR} missing in upstream - check the source layout.`);

        // Preserve the local-only files across the replace.
        const stash = join(tmpdir(), `enigma-sa-local-${process.pid}`);
        rmSync(stash, { recursive: true, force: true });
        mkdirSync(stash, { recursive: true });
        for (const name of LOCAL_ONLY) {
            const from = join(destDir, name);
            if (existsSync(from)) cpSync(from, join(stash, name), { recursive: true });
        }

        rmSync(destDir, { recursive: true, force: true });
        mkdirSync(destDir, { recursive: true });
        let copied = 0;
        for (const name of readdirSync(srcDir)) {
            cpSync(join(srcDir, name), join(destDir, name), { recursive: true });
            copied++;
        }
        for (const name of LOCAL_ONLY) {
            const from = join(stash, name);
            if (existsSync(from)) cpSync(from, join(destDir, name), { recursive: true });
        }
        rmSync(stash, { recursive: true, force: true });

        writeFileSync(pinPath, `${JSON.stringify({
            repo: "cloudflare/security-audit-skill",
            url: SOURCE_REPO,
            subdir: SKILL_SUBDIR.split("\\").join("/"),
            commit: resolved,
            syncedAt: new Date().toISOString().slice(0, 10)
        }, null, 2)}\n`);

        console.log(`Vendored ${copied} entries from security-audit-skill@${resolved.slice(0, 12)} into packages/helio/assets/skills/security-audit`);
        console.warn("Re-apply the enigma-local patches recorded in VENDOR.md, then run the validator tests.");
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

main();
