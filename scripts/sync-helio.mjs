// Vendor the Helio bug-bounty harness into packages/helio/assets so it can ship as the
// asset-only @enigmax/helio pack. Helio lives in its own repo (TPEOficial/helio); this is a
// maintainer tool to refresh the vendored copy when Helio releases - the assets are then
// committed (like @enigmax/dashboard's), so `npm publish` and the on-demand fetch never
// depend on the Helio repo being reachable at build time.
//
// Source is pinned to a commit recorded in packages/helio/.source.json. Refresh to a new
// commit with `node scripts/sync-helio.mjs --commit <sha>` (or --ref <branch> to follow a
// branch's tip once, which then re-pins to the resolved commit).
//
// Node builtins + the git CLI only (no deps). Run by the maintainer, not at user install.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));   // scripts/
const repoRoot = join(here, "..");
const pkgDir = join(repoRoot, "packages", "helio");
const assetsDir = join(pkgDir, "assets");
const pinPath = join(pkgDir, ".source.json");

const SOURCE_REPO = "https://github.com/TPEOficial/helio.git";

// Top-level entries NOT vendored: VCS, this harness's own agent installers (enigma owns
// deployment), test suite, doc images, and editor state. Everything else is the pack payload
// (skills, commands, agents, mcp, tools, rules, hooks, wordlists, memory, web3, *.md, *.py).
const EXCLUDE = new Set([
    ".git", ".github", ".claude", ".claudeignore", ".gitignore",
    "tests", "docs", "install.py", "install.sh", "node_modules"
]);

function git(args, opts = {}) {
    const res = spawnSync("git", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
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
    if (!commit && !ref) {
        console.error("No commit pinned and no --commit/--ref given. Use --commit <sha> or --ref <branch>.");
        process.exit(1);
    }

    const work = join(tmpdir(), `enigma-helio-sync-${process.pid}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
        console.log(`Cloning ${SOURCE_REPO} ...`);
        git(["clone", "--quiet", "--no-checkout", SOURCE_REPO, work]);
        const target = commit || ref;
        git(["fetch", "--quiet", "--depth", "1", "origin", target], { cwd: work });
        git(["checkout", "--quiet", "FETCH_HEAD"], { cwd: work });
        const resolved = git(["rev-parse", "HEAD"], { cwd: work });

        // Replace the vendored tree wholesale so deletions upstream propagate.
        rmSync(assetsDir, { recursive: true, force: true });
        mkdirSync(assetsDir, { recursive: true });
        let copied = 0;
        for (const name of readdirSync(work)) {
            if (EXCLUDE.has(name)) continue;
            cpSync(join(work, name), join(assetsDir, name), { recursive: true });
            copied++;
        }

        writeFileSync(pinPath, `${JSON.stringify({
            repo: "TPEOficial/helio",
            url: SOURCE_REPO,
            commit: resolved,
            syncedAt: new Date().toISOString().slice(0, 10)
        }, null, 2)}\n`);

        console.log(`Vendored ${copied} top-level entries from helio@${resolved.slice(0, 12)} into packages/helio/assets`);
        if (!existsSync(join(assetsDir, "skills"))) console.warn("WARNING: assets/skills missing - check the source layout.");
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

main();
