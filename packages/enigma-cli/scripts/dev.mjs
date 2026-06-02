/**
 * Dev runner for the enigma CLI.
 *
 * Runs the CLI straight from TypeScript source under Bun by default (so the OpenTUI
 * TUI works); pass --node to run it under Node via tsx instead (non-TUI commands
 * only - the native OpenTUI core cannot load on Node). By default it uses your REAL
 * HOME/cwd, so the settings menu shows the values actually configured on this machine
 * (Claude permission bypass, attribution, etc.). Real configs are read and, if you
 * save or install, written - the same way the published binary behaves.
 *
 * Pass --sandbox to run inside an isolated sandbox instead, so testing - install,
 * config, the settings menu, security hooks - never touches your real global agent
 * configs (~/.claude, ~/.codex, ~/.config/opencode, ~/.enigma.json). The sandbox
 * redirects HOME/USERPROFILE and uses a throwaway project cwd; both live under
 * .dev-home/ (gitignored). Either way this is NOT `npm link` - nothing is installed
 * and the globally installed `enigma` on PATH is left exactly as is.
 *
 * Usage:
 *   npm run dev -- <enigma args>      e.g. npm run dev -- config  (Bun, real configs)
 *   npm run dev -- --node <args>      run from source under Node/tsx (non-TUI only)
 *   npm run dev -- --sandbox <args>   isolate from real configs (writes go to .dev-home)
 *   npm run dev -- --reset <args>     wipe the sandbox first (implies --sandbox state)
 *   npm run dev -- --built <args>     run the compiled host binary through bin/enigma.mjs
 *                                     (run `npm run build:binaries` first)
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
const useNode = args[0] === "--node" && (args.shift(), true);
// Default is REAL (uses the actual HOME/cwd so the menu shows real configured
// values). --sandbox opts into the isolated .dev-home so writes never touch real
// configs. --reset (sandbox-only) wipes that sandbox first.
const useSandbox = (args[0] === "--sandbox" && (args.shift(), true)) || reset;

if (useSandbox) {
    if (reset && existsSync(sandboxHome)) rmSync(sandboxHome, { recursive: true, force: true });
    mkdirSync(sandboxProject, { recursive: true });
}

let env = useSandbox
    ? { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, ENIGMA_DEV_SANDBOX: "1" }
    : { ...process.env };

let command;
if (built) {
    // Drive the real launcher (bin/enigma.mjs) and point it at the freshly compiled
    // host binary, exercising the full launcher -> binary -> env-asset chain.
    const osName = process.platform === "win32" ? "win32" : process.platform;
    const exe = process.platform === "win32" ? ".exe" : "";
    const binary = join(pkgRoot, "dist-bin", `enigma-${osName}-${process.arch}${exe}`);
    if (!existsSync(binary)) { console.error(`${binary} not found - run \`npm run build:binaries\` first.`); process.exit(1); }
    env = { ...env, ENIGMA_BIN_PATH: binary };
    command = [process.execPath, [join(pkgRoot, "bin", "enigma.mjs"), ...args]];
} else if (useNode) {
    command = [process.execPath, [resolveTsxCli(), join(pkgRoot, "src", "bin", "enigma.ts"), ...args]];
} else {
    // Default: Bun runs TypeScript directly; this exercises the OpenTUI (native) TUI path.
    command = ["bun", [join(pkgRoot, "src", "bin", "enigma.ts"), ...args]];
}

process.stderr.write(useSandbox
    ? `[enigma dev] sandbox: ${sandboxHome} (real ~/.claude, ~/.codex, global enigma untouched)\n`
    : `[enigma dev] REAL configs: using your actual HOME/cwd (reads, and on save/install writes, your real configs)\n`);
// shell:true lets Windows resolve the `bun` launcher (bun.cmd/.ps1) from PATH.
const runsBun = !useNode && !built;
const result = spawnSync(command[0], command[1], { cwd: useSandbox ? sandboxProject : process.cwd(), env, stdio: "inherit", shell: runsBun });
process.exit(result.status ?? 1);
