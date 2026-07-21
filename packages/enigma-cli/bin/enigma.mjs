#!/usr/bin/env node
/**
 * enigma launcher. This is the ONLY thing that runs under the user's Node: it locates
 * the Bun-compiled binary for this platform and execs it. The binary embeds the Bun
 * runtime plus the OpenTUI native core, so the rich TUI (with mouse) works on any npm
 * install without the user having Bun.
 *
 * Distribution (opencode-style mechanism, single npm package): the binary is NOT an
 * npm dependency. It is downloaded from the matching GitHub Release by the postinstall
 * hook, or lazily here on first run if install scripts were skipped, and verified
 * against bin/checksums.json (shipped in the tarball, covered by npm provenance).
 *
 * The app's assets (skills/memory) and the commit guard ship as REAL files in this
 * package, not inside the binary. The binary reads them from disk via the env vars set
 * here, since its own __dirname lives in Bun's virtual filesystem.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { ARCH, PLATFORM, packageVersion, pkgRoot } from "./platform.mjs";
import { downloadBinary, installedBinary } from "./download.mjs";

/**
 * Fast path: an agent status bar (e.g. Claude Code's statusLine) calls `enigma
 * statusline` on every refresh. Handle it here in the lightweight Node launcher -
 * reading .enigma.json directly - so it never resolves or spawns the Bun binary.
 * Always prints `[ENIGMA]` (amber); when token-efficient output is active it appends
 * the level, e.g. `[ENIGMA:FULL]`.
 */
function readOutputStyle() {
    let style = "off";
    // Mirror config.ts precedence: global (~/.enigma.json) then local (cwd), nearest wins.
    for (const dir of [os.homedir(), process.cwd()]) {
        try {
            const raw = JSON.parse(readFileSync(join(dir, ".enigma.json"), "utf8"));
            if (raw && typeof raw.outputStyle === "string") style = raw.outputStyle;
        } catch { /* missing/invalid .enigma.json - ignore */ }
    }
    return style;
};
if (process.argv[2] === "statusline") {
    try {
        const style = readOutputStyle();
        const label = (!style || style === "off") ? "ENIGMA" : `ENIGMA:${style.toUpperCase()}`;
        process.stdout.write(process.env.NO_COLOR ? `[${label}]` : `\x1b[38;5;172m[${label}]\x1b[0m`);
    } catch { /* a status bar must never error */ }
    process.exit(0);
}

/** Resolve the binary, downloading it on first run if the postinstall was skipped. */
async function resolveBinary() {
    if (process.env.ENIGMA_BIN_PATH && existsSync(process.env.ENIGMA_BIN_PATH)) return process.env.ENIGMA_BIN_PATH;
    const existing = installedBinary();
    if (existing) return existing;
    // Lazy path (e.g. `npm i --ignore-scripts`): fetch + verify before first use.
    return downloadBinary({ log: (message) => process.stderr.write(`enigma: ${message}\n`) });
};

let binary;
try {
    binary = await resolveBinary();
} catch (error) {
    const platform = PLATFORM && ARCH ? `${PLATFORM}-${ARCH}` : `${os.platform()}-${os.arch()}`;
    process.stderr.write(
        `Could not obtain the enigma binary for ${platform}: ${error.message}\n` +
        `Check your network/proxy, or set ENIGMA_BIN_PATH to a compatible binary.\n`,
    );
    process.exit(1);
}

// Tell the binary where the on-disk assets, guard, and version live (its own
// __dirname points into Bun's virtual fs and cannot see these). Always set them
// from THIS launcher's package root: shells or tools spawned by an older enigma
// (e.g. `enigma claude`) inherit the old values, and honoring them would make a
// nested `enigma` report a stale version (and stale paths) after an update.
const env = { ...process.env };
env.ENIGMA_ASSETS_DIR = join(pkgRoot, "assets");
env.ENIGMA_GUARD_PATH = join(pkgRoot, "dist", "guard.js");
env.ENIGMA_GUARDRAILS_PATH = join(pkgRoot, "dist", "guardrails.js");
try {
    env.ENIGMA_VERSION = packageVersion();
} catch { /* version is best-effort */ }

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
}
child.on("error", (err) => {
    process.stderr.write(`Failed to launch enigma binary: ${err.message}\n`);
    process.exit(1);
});
child.on("exit", (code) => {
    // Do NOT re-raise the child's exit signal on this process: re-raising SIGHUP/SIGTERM
    // can hang up (close) the controlling terminal. A signal exit from the interactive
    // binary - e.g. quitting the TUI - is treated as a clean exit.
    process.exit(code ?? 0);
});