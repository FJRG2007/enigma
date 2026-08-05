/**
 * Drift check for the guard bundle this repo commits into its own .githooks/.
 *
 * `.githooks/guard.mjs` is a COPY of the built dist/guard.js (that is how `enigma security`
 * installs it), so it goes stale the moment src/guard.ts changes and nobody re-runs the
 * installer. A stale copy is invisible: the hook keeps passing while running an older engine
 * than the source it is supposed to be, which is how `--range` and the split exit codes shipped
 * without ever reaching this repo's own pre-commit hook.
 *
 * The bundle is rebuilt from source here rather than trusted from disk - a dist left over from
 * an earlier edit would make a stale hook compare equal to an equally stale build.
 *
 * Exit: 0 in sync, 1 drifted, 2 the check could not run.
 */

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = join(repoRoot, ".githooks", "guard.mjs");
const built = join(repoRoot, "packages", "enigma-cli", "dist", "guard.js");

if (!existsSync(hook)) {
    console.error(`hook-drift: ${hook} is missing; run 'npm run enigma -- security' to install it.`);
    process.exit(2);
}

const build = spawnSync("npm", ["run", "-s", "build"], { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) {
    console.error("hook-drift: could not build the guard bundle, so nothing was compared.");
    process.exit(2);
}
if (!existsSync(built)) {
    console.error(`hook-drift: the build produced no ${built}, so nothing was compared.`);
    process.exit(2);
}

if (readFileSync(built).equals(readFileSync(hook))) {
    console.log("hook-drift: .githooks/guard.mjs matches the current src/guard.ts build.");
    process.exit(0);
}

console.error("hook-drift: .githooks/guard.mjs is out of date with src/guard.ts.");
console.error("The committed hook is what this repo's pre-commit actually runs, so it must be rebuilt and committed:");
console.error("  npm run build && cp packages/enigma-cli/dist/guard.js .githooks/guard.mjs");
process.exit(1);
