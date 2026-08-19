/**
 * Drift check for the hook bundles this repo commits into its own .githooks/.
 *
 * Each of them is a COPY of a built dist file (that is how `enigma security` installs them),
 * so a copy goes stale the moment its source changes and nobody re-runs the installer. A stale
 * copy is invisible: the hook keeps passing while running an older engine than the source it is
 * supposed to be, which is how `--range` and the split exit codes shipped without ever reaching
 * this repo's own pre-commit hook - and how a new guardrail rule can sit in src/guardrails.ts
 * for weeks while the commit gate that should enforce it has never heard of it.
 *
 * EVERY copy pre-commit runs is checked, not just the guard: they are one class, and the one
 * left uncovered is the one that drifts.
 *
 * The bundles are rebuilt from source here rather than trusted from disk - a dist left over from
 * an earlier edit would make a stale hook compare equal to an equally stale build.
 *
 * Exit: 0 in sync, 1 drifted, 2 the check could not run.
 */

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** Hook copy -> the dist file it must equal, byte for byte. */
const COPIES = [
    { hook: "guard.mjs", built: "guard.js", source: "src/guard.ts" },
    { hook: "guardrails.mjs", built: "guardrails.js", source: "src/guardrails.ts" },
    { hook: "trim.mjs", built: "trim.js", source: "src/trim.ts" },
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = (name) => join(repoRoot, ".githooks", name);
const builtPath = (name) => join(repoRoot, "packages", "enigma-cli", "dist", name);

const missing = COPIES.filter((c) => !existsSync(hookPath(c.hook)));
if (missing.length) {
    console.error(`hook-drift: ${missing.map((c) => `.githooks/${c.hook}`).join(", ")} missing; run 'npm run enigma -- security' to install.`);
    process.exit(2);
}

const build = spawnSync("npm", ["run", "-s", "build"], { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) {
    console.error("hook-drift: could not build the hook bundles, so nothing was compared.");
    process.exit(2);
}
const unbuilt = COPIES.filter((c) => !existsSync(builtPath(c.built)));
if (unbuilt.length) {
    console.error(`hook-drift: the build produced no ${unbuilt.map((c) => builtPath(c.built)).join(", ")}, so nothing was compared.`);
    process.exit(2);
}

const drifted = COPIES.filter((c) => !readFileSync(builtPath(c.built)).equals(readFileSync(hookPath(c.hook))));
if (!drifted.length) {
    console.log(`hook-drift: ${COPIES.map((c) => `.githooks/${c.hook}`).join(", ")} match the current build.`);
    process.exit(0);
}

console.error("hook-drift: the committed hooks are what this repo's pre-commit actually runs, so they must be rebuilt and committed:");
for (const c of drifted) console.error(`  .githooks/${c.hook} is out of date with ${c.source}`);
console.error(`  npm run build && ${drifted.map((c) => `cp packages/enigma-cli/dist/${c.built} .githooks/${c.hook}`).join(" && ")}`);
process.exit(1);
