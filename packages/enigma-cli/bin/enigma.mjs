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

import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { downloadBinary, installedBinary } from "./download.mjs";
import { ARCH, PLATFORM, packageVersion, pkgRoot } from "./platform.mjs";

/**
 * Fast path: an agent status bar (e.g. Claude Code's statusLine) calls `enigma
 * statusline` on every refresh. Handle it here in the lightweight Node launcher so
 * it never resolves or spawns the Bun binary. The renderer is imported lazily, so
 * every other command pays nothing for it.
 */
if (process.argv[2] === "statusline") {
    try {
        const { printStatusline } = await import("./statusline.mjs");
        // Awaited: the renderer reads the piped session asynchronously and resolves
        // once its own write has drained. Exiting before that truncates the bar.
        await printStatusline();
    } catch { /* a status bar must never error */ }
    process.exit(0);
}

/**
 * Fast path: the post-edit hook, which is the most-invoked command there is.
 *
 * It fires on every Edit/Write in every session, and spawning the ~99 MB binary for it costs a
 * Bun start on top of this Node one - measured on Windows 11 with Defender real-time on at
 * 109-1658 ms for the binary alone, against 112-874 ms for `node -e 0`. Every step the hook runs
 * (auto-lint, trim, guardrails, the graph's blast radius) is Node-compatible and bundled into
 * `dist/post-edit.js`, so it is answered HERE and the binary is never started. A turn with five
 * edits stops paying five Bun starts for work whose own runtime is milliseconds.
 *
 * Bundle missing (an install from before it shipped) -> fall through untouched, stdin included,
 * and let the binary answer as it always did.
 */
const postEditBundle = join(pkgRoot, "dist", "post-edit.js");
if (process.argv[2] === "__post-edit-hook" && existsSync(postEditBundle)) {
    // Read SYNCHRONOUSLY, before any await: an await lets Node drain the pipe and the hook then
    // sees an empty payload - the same lesson cli.ts records for this command.
    let payload = "";
    try { payload = readFileSync(0, "utf8"); } catch { /* no stdin; the steps below no-op on it */ }
    try {
        const { runPostEditHook } = await import(pathToFileURL(postEditBundle).href);
        // 2 is the channel Claude Code feeds back to the model. Losing it turns a gate into a
        // silent no-op, so it is the one thing here that is never swallowed.
        process.exit(await runPostEditHook(payload));
    } catch (error) {
        // Said out loud rather than exiting 0 quietly: a post-edit hook that stops running looks
        // exactly like a clean edit, and that is the failure nobody notices.
        process.stderr.write(`enigma: the post-edit hook could not run: ${error.message}\n`);
        process.exit(0);
    }
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
    const help = "Check your network/proxy, or set ENIGMA_BIN_PATH to a compatible binary.";
    process.stderr.write(`Could not obtain the enigma binary for ${platform}: ${error.message}\n${help}\n`);
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
env.ENIGMA_TRIM_PATH = join(pkgRoot, "dist", "trim.js");
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
