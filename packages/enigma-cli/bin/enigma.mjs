#!/usr/bin/env node
/**
 * enigma launcher. This is the ONLY thing that runs under the user's Node: it
 * resolves the platform-specific, Bun-compiled binary (published as a separate
 * `enigma-cli-<os>-<arch>` package and pulled in as an optionalDependency) and execs
 * it. The binary embeds the Bun runtime plus the OpenTUI native core, so the rich
 * TUI works on any npm install without the user having Bun.
 *
 * The app's assets (skills/memory) and the commit guard ship as REAL files in this
 * main package, not inside the binary. The binary reads them from disk via the env
 * vars set here, since its own __dirname lives in Bun's virtual filesystem.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // <pkg>/bin/.. -> <pkg>

const PLATFORM = { win32: "win32", darwin: "darwin", linux: "linux" }[os.platform()];
const ARCH = { x64: "x64", arm64: "arm64" }[os.arch()];

/** Detect musl libc (Alpine) so Linux picks the right variant; glibc otherwise. */
function isMusl() {
    if (os.platform() !== "linux") return false;
    try {
        const report = process.report?.getReport();
        const header = report && typeof report === "object" ? report.header : undefined;
        // glibc runtimes expose glibcVersionRuntime; musl does not.
        return header ? !header.glibcVersionRuntime : false;
    } catch {
        return false;
    }
}

/** Ordered list of candidate platform package names for this host. */
function candidatePackages() {
    if (!PLATFORM || !ARCH) return [];
    const base = `enigma-cli-${PLATFORM}-${ARCH}`;
    if (PLATFORM === "linux" && isMusl()) return [`${base}-musl`, base];
    return [base];
}

const binName = PLATFORM === "win32" ? "enigma.exe" : "enigma";

/** Resolve the binary path: env override -> platform package -> null. */
function resolveBinary() {
    if (process.env.ENIGMA_BIN_PATH && existsSync(process.env.ENIGMA_BIN_PATH)) return process.env.ENIGMA_BIN_PATH;
    for (const name of candidatePackages()) {
        try {
            // Resolve the package.json (no "exports" subpath assumptions), then join the binary.
            const pkgJson = require.resolve(`${name}/package.json`);
            const candidate = join(dirname(pkgJson), "bin", binName);
            if (existsSync(candidate)) return candidate;
        } catch {
            // Package not installed for this platform; try the next candidate.
        }
    }
    return null;
}

function readVersion() {
    try {
        return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
    } catch {
        return undefined;
    }
}

const binary = resolveBinary();
if (!binary) {
    const names = candidatePackages();
    const detail = PLATFORM && ARCH
        ? `No prebuilt enigma binary for ${PLATFORM}-${ARCH}. Expected one of: ${names.join(", ")}.`
        : `Unsupported platform: ${os.platform()}-${os.arch()}.`;
    process.stderr.write(
        `${detail}\nReinstall enigma-cli so npm can pull the matching optional dependency, ` +
        `or set ENIGMA_BIN_PATH to a compatible binary.\n`,
    );
    process.exit(1);
}

// Tell the binary where the on-disk assets, guard, and version live (its own
// __dirname points into Bun's virtual fs and cannot see these).
const env = { ...process.env };
env.ENIGMA_ASSETS_DIR ??= join(pkgRoot, "assets");
env.ENIGMA_GUARD_PATH ??= join(pkgRoot, "dist", "guard.js");
const version = readVersion();
if (version && !env.ENIGMA_VERSION) env.ENIGMA_VERSION = version;

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
}
child.on("error", (err) => {
    process.stderr.write(`Failed to launch enigma binary: ${err.message}\n`);
    process.exit(1);
});
child.on("exit", (code, signal) => {
    if (signal) { try { process.kill(process.pid, signal); } catch { /* fall through */ } }
    process.exit(code ?? 1);
});
