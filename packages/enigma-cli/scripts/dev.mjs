/**
 * Sandboxed dev runner for the enigma CLI.
 *
 * Runs the CLI straight from TypeScript source (via tsx) inside an isolated
 * sandbox so testing - install, config, the settings menu, security hooks -
 * never touches your real global agent configs (~/.claude, ~/.codex,
 * ~/.config/opencode, ~/.enigma.json, the update-check cache) and never shadows
 * the globally installed `enigma` binary. It is NOT `npm link`: nothing is
 * installed, so the published version you have on PATH is left exactly as is.
 *
 * The sandbox redirects HOME/USERPROFILE (so os.homedir() resolves into it) and
 * runs with its working directory set to a throwaway project folder (so
 * local-scope writes land there too). Both live under .dev-home/ (gitignored).
 *
 * Usage:
 *   npm run dev -- <enigma args>      e.g. npm run dev -- config
 *   npm run dev -- --reset <args>     wipe the sandbox first, then run
 *   npm run dev -- --built <args>     run the built dist/enigma.js instead of source
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxHome = join(pkgRoot, ".dev-home");
const sandboxProject = join(sandboxHome, "project");

/**
 * Locate tsx's CLI entry as a real file path, walking up node_modules so it works
 * whether tsx is in the package or hoisted to the workspace root. Resolved as a
 * path (not a package subpath) because tsx's `exports` map blocks dist/cli.mjs.
 */
function resolveTsxCli() {
    let dir = pkgRoot;
    for (;;) {
        const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) throw new Error("tsx not found - run `npm install` at the repo root.");
        dir = parent;
    }
}

const args = process.argv.slice(2);
const reset = args[0] === "--reset" && (args.shift(), true);
const built = args[0] === "--built" && (args.shift(), true);

if (reset && existsSync(sandboxHome)) rmSync(sandboxHome, { recursive: true, force: true });
mkdirSync(sandboxProject, { recursive: true });

const env = { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, ENIGMA_DEV_SANDBOX: "1" };

let command;
if (built) {
    const dist = join(pkgRoot, "dist", "enigma.js");
    if (!existsSync(dist)) { console.error("dist/enigma.js not found - run `npm run build` first."); process.exit(1); }
    command = [process.execPath, [dist, ...args]];
} else {
    command = [process.execPath, [resolveTsxCli(), join(pkgRoot, "src", "bin", "enigma.ts"), ...args]];
}

process.stderr.write(`[enigma dev] sandbox: ${sandboxHome} (real ~/.claude, ~/.codex, global enigma untouched)\n`);
const result = spawnSync(command[0], command[1], { cwd: sandboxProject, env, stdio: "inherit" });
process.exit(result.status ?? 1);
