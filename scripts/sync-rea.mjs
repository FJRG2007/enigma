// Vendor REA's agent skill into packages/rea/assets so it ships in the asset-only @enigmax/rea
// agent. REA (morluto/rea) is published to npm as `rea-agents`; its tarball carries the exact
// `skills/` tree that matches that release's MCP tool catalog, so the skill is taken from the
// published tarball of the pinned version, never from the repo's main branch (main describes
// tools an older release does not have). The pinned version is also written to
// assets/engine.json: enigma installs that same `rea-agents` version as the agent's engine, so
// skill and engine can never drift apart.
//
// Pin lives in packages/rea/.source.json. Refresh with `node scripts/sync-rea.mjs --version <x.y.z>`
// (or `--version latest`, which resolves and re-pins to the current release).
//
// Node builtins + the npm and tar CLIs only (no deps). Run by the maintainer, not at user install.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));   // scripts/
const repoRoot = join(here, "..");
const pkgDir = join(repoRoot, "packages", "rea");
const assetsDir = join(pkgDir, "assets");
const pinPath = join(pkgDir, ".source.json");
const PACKAGE = "rea-agents";
const onWindows = process.platform === "win32";

function run(cmd, args, opts = {}) {
    const res = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", windowsHide: true, shell: onWindows && cmd === "npm", ...opts });
    if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status})`);
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
    const requested = arg("--version") || readPin().version;
    if (!requested) {
        console.error("No version pinned and no --version given. Use --version <x.y.z> or --version latest.");
        process.exit(1);
    }
    // Resolve to an exact published version (and its registry integrity) before fetching.
    const meta = JSON.parse(run("npm", ["view", `${PACKAGE}@${requested}`, "version", "dist.integrity", "--json"]));
    const version = meta.version;
    if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`Could not resolve ${PACKAGE}@${requested} to a release version.`);

    const work = join(tmpdir(), `enigma-rea-sync-${process.pid}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
        console.log(`Fetching ${PACKAGE}@${version} ...`);
        const tarball = run("npm", ["pack", `${PACKAGE}@${version}`, "--silent", "--pack-destination", work]).split(/\r?\n/).pop();
        // Relative paths only: GNU tar (Git for Windows) reads "C:" in an absolute path as a remote host.
        run("tar", ["-xzf", tarball], { cwd: work });
        const pkgRoot = join(work, "package");
        const skills = join(pkgRoot, "skills");
        if (!existsSync(skills)) throw new Error(`${PACKAGE}@${version} has no skills/ directory - check the package layout.`);

        // Replace the vendored skills wholesale so deletions upstream propagate.
        rmSync(join(assetsDir, "skills"), { recursive: true, force: true });
        mkdirSync(join(assetsDir, "skills"), { recursive: true });
        for (const name of readdirSync(skills)) cpSync(join(skills, name), join(assetsDir, "skills", name), { recursive: true });
        // REA is MIT: its license travels with the vendored files.
        cpSync(join(pkgRoot, "LICENSE"), join(pkgDir, "LICENSE-REA"));

        writeFileSync(join(assetsDir, "engine.json"), `${JSON.stringify({ package: PACKAGE, version }, null, 2)}\n`);
        writeFileSync(pinPath, `${JSON.stringify({
            package: PACKAGE,
            version,
            integrity: meta["dist.integrity"],
            repo: "morluto/rea",
            syncedAt: new Date().toISOString().slice(0, 10)
        }, null, 2)}\n`);
        console.log(`Vendored ${readdirSync(skills).length} skill(s) from ${PACKAGE}@${version} into packages/rea/assets`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

main();
