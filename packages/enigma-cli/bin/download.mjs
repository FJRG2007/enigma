/**
 * Download and install the host's Bun-compiled enigma binary from its GitHub
 * Release, the way `npm i -g enigma-cli` obtains the native OpenTUI executable
 * without shipping a per-platform npm package.
 *
 * Integrity: the binary is verified against the SHA256 recorded in bin/checksums.json,
 * which is published INSIDE the npm tarball (covered by npm provenance), so the trust
 * chain is tarball -> checksums.json -> downloaded binary. Downloads must be HTTPS and
 * a checksum entry is mandatory - it fails closed if either is missing.
 *
 * Used by bin/postinstall.mjs (at install) and bin/enigma.mjs (lazy, first run when
 * install scripts were skipped). Node builtins only.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import {
    ARCH,
    PLATFORM,
    assetName,
    binTargetPath,
    isWindows,
    legacyBinTargetPath,
    loadChecksums,
    packageVersion,
    platformKeys
} from "./platform.mjs";

const DEFAULT_BASE = "https://github.com/FJRG2007/enigma/releases/download";
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Pick the first platform key with a published checksum. */
function selectAsset() {
    const checksums = loadChecksums();
    for (const key of platformKeys()) {
        const asset = assetName(key);
        if (checksums[asset]) return { asset, sha256: checksums[asset] };
    }
    return null;
};

/** Resolve the release-asset URL, allowing an env override for mirrors/tests. */
function assetUrl(asset) {
    const base = (process.env.ENIGMA_DOWNLOAD_BASE || `${DEFAULT_BASE}/v${packageVersion()}`).replace(/\/+$/, "");
    const url = `${base}/${asset}`;
    if (!url.startsWith("https://")) throw new Error(`Refusing non-HTTPS download URL: ${url}`);
    return url;
};

/** Sidecar recording the sha256 of the currently-installed binary (next to the binary). */
function sidecarPath() {
    return `${binTargetPath()}.sha256`;
};

/**
 * Move an existing binary aside instead of deleting it.
 *
 * Windows refuses to delete or overwrite an `.exe` that a running process has mapped as an
 * image, and it DOES allow renaming one: the live processes keep the image they already
 * mapped, and the next launch picks up the new file. Deleting first - what this did - failed
 * precisely when an agent session was open, which is most of the time.
 */
function retireBinary(target) {
    if (!existsSync(target)) return;
    try {
        renameSync(target, `${target}.old-${Date.now()}`);
    } catch {
        // No rename either (a permission problem rather than a mapped image): fall back to the
        // delete, and let the rename that follows surface whatever is really wrong.
        try { unlinkSync(target); } catch { /* reported by the caller's rename */ }
    }
};

/**
 * Delete what this version has finished with. Best-effort: a file still mapped by a live
 * process refuses to go and is left for the next run.
 *
 * Deliberately NOT the sibling version directories. A machine can have enigma installed under
 * two Node versions at two different versions - which is exactly the setup that made the
 * per-version directory necessary - and an install that deleted its neighbour's binary would
 * have the two of them take turns re-downloading 96 MB forever. Superseded versions are left
 * on disk and reclaimed by `enigma resources`, where the user is already deleting things on
 * purpose.
 */
function sweepStaleBinaries(target) {
    const versionDir = dirname(target);
    for (const name of safeReaddir(versionDir)) {
        if (!/\.old-\d+$/.test(name)) continue;
        try { unlinkSync(join(versionDir, name)); } catch { /* still mapped by a live process */ }
    }
    // The pre-1.46.4 location, inside the npm package: dead weight now, and the file npm used
    // to trip over on upgrade.
    for (const path of [legacyBinTargetPath(), `${legacyBinTargetPath()}.sha256`]) {
        try { unlinkSync(path); } catch { /* absent, or still mapped by an older launcher */ }
    }
};

/** readdirSync that answers with an empty list instead of throwing on a missing directory. */
function safeReaddir(dir) {
    try { return readdirSync(dir); } catch { return []; }
};

/** The sha256 this package version expects for the host's asset, or null if none is known. */
function expectedSha() {
    const choice = selectAsset();
    return choice ? choice.sha256 : null;
};

/**
 * Returns the installed binary path only if it is present AND matches the sha256 this
 * package version expects (recorded in the sidecar at download time). Returns null when
 * the binary is missing, has no sidecar, or the sidecar does not match - i.e. it is stale
 * after a package update - so the caller re-downloads the correct one. This is what makes
 * `npm install -g enigma-cli@latest` actually swap a binary that npm left in place (the
 * binary is not in the tarball; npm does not track or remove it on update). When there are
 * no checksums (a source checkout / workspace install), trust whatever binary is present.
 */
export function installedBinary() {
    const target = binTargetPath();
    if (!existsSync(target)) return null;
    const expected = expectedSha();
    if (!expected) return target;
    try {
        return readFileSync(sidecarPath(), "utf8").trim() === expected ? target : null;
    } catch {
        return null;
    }
};

/**
 * Download, verify and atomically install the binary. Returns its path.
 * Throws on any failure (no checksum, network error, hash mismatch).
 */
export async function downloadBinary({ log = () => {} } = {}) {
    const choice = selectAsset();
    if (!choice) throw new Error(`No prebuilt enigma binary is available for this platform (looked for: ${platformKeys().map(assetName).join(", ") || `${PLATFORM}-${ARCH}`}).`);

    const url = assetUrl(choice.asset);
    log(`Downloading ${choice.asset}...`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let buffer;
    try {
        const response = await fetch(url, { redirect: "follow", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
        buffer = Buffer.from(await response.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }

    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== choice.sha256) throw new Error(`Checksum mismatch for ${choice.asset}: expected ${choice.sha256}, got ${actual}.`);

    const target = binTargetPath();
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.download-${process.pid}`;
    writeFileSync(tmp, buffer);
    if (!isWindows) chmodSync(tmp, 0o755);
    retireBinary(target);
    renameSync(tmp, target);
    sweepStaleBinaries(target);
    // Record the installed sha so installedBinary() can detect a stale binary after an
    // update without re-hashing the whole file on every launch. Best-effort: a missing
    // sidecar just triggers one extra re-download next time.
    try { writeFileSync(sidecarPath(), choice.sha256); } catch { /* sidecar is best-effort */ }
    log(`Installed ${choice.asset} -> ${target}`);
    return target;
};
