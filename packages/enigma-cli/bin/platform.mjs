/**
 * Shared platform identity for the single-package distribution model.
 *
 * enigma ships as ONE npm package (`enigma-cli`). The Bun-compiled binary for the
 * host is NOT an npm dependency; it is downloaded from the matching GitHub Release
 * (see bin/download.mjs) and verified against bin/checksums.json, which travels
 * inside the npm tarball and is therefore covered by npm provenance.
 *
 * The launcher, the postinstall hook and the downloader all import this module so
 * they agree on the platform key, the release asset name and the on-disk binary
 * path. Node builtins only - no dependencies (it runs during install).
 */

import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Allowlists of the npm/Node "os" identifiers we publish binaries for (win32, not
// "windows"). An unsupported host resolves to undefined, which platformKeys() turns
// into "no binary for this host" rather than guessing a non-existent asset name.
const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);
const allowed = (set, value) => (set.has(value) ? value : undefined);

export const PLATFORM = allowed(SUPPORTED_PLATFORMS, os.platform());
export const ARCH = allowed(SUPPORTED_ARCHES, os.arch());
export const isWindows = PLATFORM === "win32";

/** This package's root (the directory holding package.json), i.e. <pkg>/bin/.. */
export const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Detect musl libc (Alpine) so Linux can prefer a musl build when one exists. */
function isMusl() {
    if (PLATFORM !== "linux") return false;
    try {
        // glibc runtimes expose glibcVersionRuntime in the process report; musl does not.
        const header = process.report?.getReport()?.header;
        return header ? !header.glibcVersionRuntime : false;
    } catch {
        return false;
    }
};

/**
 * Ordered platform keys to try for this host, most specific first. The downloader
 * uses the first key that has a checksum entry, so a musl host falls back to the
 * glibc build when no musl asset is published.
 */
export function platformKeys() {
    if (!PLATFORM || !ARCH) return [];
    const base = `${PLATFORM}-${ARCH}`;
    if (PLATFORM === "linux" && isMusl()) return [`${base}-musl`, base];
    return [base];
};

/** Release asset name for a platform key, e.g. "enigma-win32-x64.exe". */
export function assetName(key) {
    return `enigma-${key}${isWindows ? ".exe" : ""}`;
};

/** File name of the compiled binary for this host. */
const binName = () => (isWindows ? "enigma-bin.exe" : "enigma-bin");

/**
 * Directory the compiled binaries live in, one subdirectory per package version.
 *
 * Deliberately OUTSIDE the npm package, and this is the whole point of it. npm copies a
 * package's directory aside before replacing it, and Windows refuses to copy or delete an
 * `.exe` that a running process has mapped as an image - so keeping a 96 MB binary in
 * `<pkg>/bin` made `npm i -g enigma-cli@latest` fail with EBUSY for anyone holding an agent
 * session open, which on a machine running several is always. Nothing npm touches can hold
 * the binary any more.
 *
 * Per VERSION because a machine can have enigma installed under more than one Node version
 * (nvm), and a single shared path would have the two installs overwrite each other's binary
 * and re-download on every launch, each seeing the other's checksum as stale.
 */
export function binDir() {
    return join(process.env.ENIGMA_CONFIG_HOME || os.homedir(), ".enigma", "bin");
};

/**
 * On-disk path of the installed binary for THIS package version.
 *
 * The version is read defensively: this path is resolved on every launch, and an unreadable
 * package.json must degrade to one shared directory rather than throw and take the CLI with it.
 */
export function binTargetPath() {
    let version = "unknown";
    try { version = packageVersion(); } catch { /* fall back to the shared directory */ }
    return join(binDir(), version, binName());
};

/**
 * Where releases up to 1.46.3 put the binary: inside the package. Kept so a stale copy can be
 * swept after an upgrade - it is dead weight, and the thing npm used to trip over.
 */
export function legacyBinTargetPath() {
    return join(pkgRoot, "bin", binName());
};

/** This package's declared version (release tag is `v<version>`). */
export function packageVersion() {
    return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
};

/** Parsed bin/checksums.json (asset name -> sha256 hex), or {} if absent. */
export function loadChecksums() {
    const path = join(pkgRoot, "bin", "checksums.json");
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return {};
    }
};
