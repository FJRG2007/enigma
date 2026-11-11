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

// Subpaths under assets/ that enigma vendors separately (not from the Helio repo) and that the
// wholesale replace below must NOT delete. security-audit comes from cloudflare/security-audit-skill
// via scripts/sync-security-audit.mjs; preserve it and its /audit entry points across a Helio refresh.
const PRESERVE = [
    "skills/security-audit",
    "commands/audit.md",
    "commands/claude-code/audit.md",
    "commands/opencode/audit.md"
];

// Enigma-local edits to Helio's own AGENTS.md: the upstream file replaces them on every refresh,
// so each marker is checked afterwards and a missing one is reported for re-application.
const AGENTS_MARKERS = [
    ["- `skills/security-audit/`", "the security-audit entry in the skills list"],
    ["| `/audit` |", "the /audit row in the commands table"],
    ["**When asked to audit / security-review a codebase you can read (white-box):**", "the white-box audit routing block"]
];

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

        // Stash enigma-vendored subpaths before the wholesale replace, restore them after.
        const stash = join(tmpdir(), `enigma-helio-preserve-${process.pid}`);
        rmSync(stash, { recursive: true, force: true });
        const preserved = [];
        for (const rel of PRESERVE) {
            const from = join(assetsDir, ...rel.split("/"));
            if (!existsSync(from)) continue;
            const to = join(stash, rel);
            mkdirSync(dirname(to), { recursive: true });
            cpSync(from, to, { recursive: true });
            preserved.push(rel);
        }

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

        // Restore the enigma-vendored subpaths over the fresh Helio tree.
        for (const rel of preserved) {
            const to = join(assetsDir, ...rel.split("/"));
            rmSync(to, { recursive: true, force: true });
            mkdirSync(dirname(to), { recursive: true });
            cpSync(join(stash, rel), to, { recursive: true });
        }
        rmSync(stash, { recursive: true, force: true });

        console.log(`Vendored ${copied} top-level entries from helio@${resolved.slice(0, 12)} into packages/helio/assets`);
        if (preserved.length) console.log(`Preserved enigma-vendored: ${preserved.join(", ")}`);
        const missingPreserve = PRESERVE.filter((rel) => !preserved.includes(rel));
        if (missingPreserve.length) console.warn(`WARNING: not present before the refresh, so not preserved: ${missingPreserve.join(", ")}`);
        const agentsPath = join(assetsDir, "AGENTS.md");
        const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
        const lost = AGENTS_MARKERS.filter(([marker]) => !agents.includes(marker));
        if (lost.length) {
            console.warn("WARNING: the Helio refresh replaced AGENTS.md and dropped enigma's security-audit wiring. Re-apply from git history (git log -p -- packages/helio/assets/AGENTS.md):");
            for (const [, what] of lost) console.warn(`  - ${what}`);
        }
        if (!existsSync(join(assetsDir, "skills"))) console.warn("WARNING: assets/skills missing - check the source layout.");
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

main();
