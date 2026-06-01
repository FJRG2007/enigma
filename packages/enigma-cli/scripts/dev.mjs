/**
 * Dev runner for the enigma CLI.
 *
 * Runs the CLI straight from TypeScript source (via tsx). By default it uses your
 * REAL HOME/cwd, so the settings menu shows the values actually configured on this
 * machine (Claude permission bypass, attribution, etc.). Real configs are read and,
 * if you save or install, written - the same way the published binary behaves.
 *
 * Pass --sandbox to run inside an isolated sandbox instead, so testing - install,
 * config, the settings menu, security hooks - never touches your real global agent
 * configs (~/.claude, ~/.codex, ~/.config/opencode, ~/.enigma.json). The sandbox
 * redirects HOME/USERPROFILE and uses a throwaway project cwd; both live under
 * .dev-home/ (gitignored). Either way this is NOT `npm link` - nothing is installed
 * and the globally installed `enigma` on PATH is left exactly as is.
 *
 * Usage:
 *   npm run dev -- <enigma args>      e.g. npm run dev -- config  (real configs)
 *   npm run dev -- --sandbox <args>   isolate from real configs (writes go to .dev-home)
 *   npm run dev -- --reset <args>     wipe the sandbox first (implies --sandbox state)
 *   npm run dev -- --built <args>     run the built dist/enigma.js instead of source
 *   npm run dev -- --bun <args>       run from source under Bun (exercises the
 *                                     OpenTUI TUI; requires Bun on PATH)
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
const useBun = args[0] === "--bun" && (args.shift(), true);
// Default is REAL (uses the actual HOME/cwd so the menu shows real configured
// values). --sandbox opts into the isolated .dev-home so writes never touch real
// configs. --reset (sandbox-only) wipes that sandbox first.
const useSandbox = (args[0] === "--sandbox" && (args.shift(), true)) || reset;

if (useSandbox) {
    if (reset && existsSync(sandboxHome)) rmSync(sandboxHome, { recursive: true, force: true });
    mkdirSync(sandboxProject, { recursive: true });
}

const env = useSandbox
    ? { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, ENIGMA_DEV_SANDBOX: "1" }
    : { ...process.env };

let command;
if (built) {
    const dist = join(pkgRoot, "dist", "enigma.js");
    if (!existsSync(dist)) { console.error("dist/enigma.js not found - run `npm run build` first."); process.exit(1); }
    command = [process.execPath, [dist, ...args]];
} else if (useBun) {
    // Bun runs TypeScript directly; this exercises the OpenTUI (native) TUI path.
    command = ["bun", [join(pkgRoot, "src", "bin", "enigma.ts"), ...args]];
} else {
    command = [process.execPath, [resolveTsxCli(), join(pkgRoot, "src", "bin", "enigma.ts"), ...args]];
}

process.stderr.write(useSandbox
    ? `[enigma dev] sandbox: ${sandboxHome} (real ~/.claude, ~/.codex, global enigma untouched)\n`
    : `[enigma dev] REAL configs: using your actual HOME/cwd (reads, and on save/install writes, your real configs)\n`);
// shell:true lets Windows resolve the `bun` launcher (bun.cmd/.ps1) from PATH.
const result = spawnSync(command[0], command[1], { cwd: useSandbox ? sandboxProject : process.cwd(), env, stdio: "inherit", shell: useBun });
process.exit(result.status ?? 1);
