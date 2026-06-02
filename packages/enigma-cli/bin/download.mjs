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
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    ARCH,
    PLATFORM,
    assetName,
    binTargetPath,
    isWindows,
    loadChecksums,
    packageVersion,
    platformKeys,
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
}

/** Resolve the release-asset URL, allowing an env override for mirrors/tests. */
function assetUrl(asset) {
    const base = (process.env.ENIGMA_DOWNLOAD_BASE || `${DEFAULT_BASE}/v${packageVersion()}`).replace(/\/+$/, "");
    const url = `${base}/${asset}`;
    if (!url.startsWith("https://")) throw new Error(`Refusing non-HTTPS download URL: ${url}`);
    return url;
}

/** Returns the installed binary path if already present, else null. */
export function installedBinary() {
    const target = binTargetPath();
    return existsSync(target) ? target : null;
}

/**
 * Download, verify and atomically install the binary. Returns its path.
 * Throws on any failure (no checksum, network error, hash mismatch).
 */
export async function downloadBinary({ log = () => {} } = {}) {
    const choice = selectAsset();
    if (!choice) {
        const tried = platformKeys().map(assetName).join(", ") || `${PLATFORM}-${ARCH}`;
        throw new Error(`No prebuilt enigma binary is available for this platform (looked for: ${tried}).`);
    }

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
    if (actual !== choice.sha256) {
        throw new Error(`Checksum mismatch for ${choice.asset}: expected ${choice.sha256}, got ${actual}.`);
    }

    const target = binTargetPath();
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.download-${process.pid}`;
    writeFileSync(tmp, buffer);
    if (!isWindows) chmodSync(tmp, 0o755);
    // rename is atomic on POSIX; on Windows it fails over an existing file, so drop it first.
    if (existsSync(target)) {
        try { unlinkSync(target); } catch { /* in use; rename will surface the error */ }
    }
    renameSync(tmp, target);
    log(`Installed ${choice.asset} -> ${target}`);
    return target;
}
