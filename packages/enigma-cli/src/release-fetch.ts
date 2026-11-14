/**
 * The npm-independent delivery path: every package enigma installs from npm also ships as an
 * asset on the GitHub Release `v<cli version>`, next to a `SHA256SUMS` file that covers every
 * asset of that release. This module downloads one of those assets, verifies it against
 * SHA256SUMS and extracts it into the same layout `npm install` produces, so the rest of the
 * code cannot tell which path filled the directory.
 *
 * Integrity root: SHA256SUMS fetched over HTTPS from the release (or from the mirror the user
 * named in ENIGMA_DOWNLOAD_BASE). That is weaker than the npm path, whose tarball is covered by
 * npm provenance: here whoever can publish a release asset can publish a matching checksum.
 * Accepted because it is the resilient path for when npm is unavailable, not a replacement.
 *
 * Transport is a synchronous `curl` (or `wget`) spawned with an argument array: the callers
 * (dashboard and pack installers, the updater) are synchronous today, curl ships with Windows
 * 10+ and macOS and is what the shell installer needed to get here, and TLS verification is
 * its default and never disabled. Extraction is a minimal tar reader over zlib rather than the
 * system `tar`: which `tar` is first on PATH varies (Git Bash's GNU tar reads `C:\...` as a
 * remote host), and an in-process reader lets every entry path be checked for traversal.
 *
 * Node builtins only.
 */

import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const RELEASES_URL = "https://github.com/FJRG2007/enigma/releases";
const SUMS_FILE = "SHA256SUMS";
const SEMVER = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";

/** How the running enigma was installed. `standalone` = the GitHub-release installer. */
export type InstallMethod = "standalone" | "npm";

/** The SHA256SUMS of one release, and the base URL its assets are served from. */
export interface ReleaseSums {
    base: string;
    version: string;
    sums: Map<string, string>;
}

/** Only HTTPS, or a local file:// mirror. Anything else is refused before a request is made. */
export function assertAllowedUrl(url: string): void {
    if (!/^https:\/\//i.test(url) && !/^file:\/\//i.test(url)) throw new Error(`Refusing non-HTTPS download URL: ${url}`);
}

/**
 * Download `url` to `dest` with curl, falling back to wget. Throws with the tool's own error
 * line on failure. Redirects are followed only to HTTPS (GitHub serves assets from a CDN host).
 */
export function downloadTo(url: string, dest: string, timeoutSec = 120): void {
    if (process.env.ENIGMA_OFFLINE === "1") throw new Error("offline (ENIGMA_OFFLINE=1)");
    assertAllowedUrl(url);
    mkdirSync(dirname(dest), { recursive: true });
    const options = { stdio: ["ignore", "ignore", "pipe"] as ["ignore", "ignore", "pipe"], encoding: "utf8" as const, windowsHide: true };
    const curl = spawnSync("curl", ["-fsSL", "--proto", "=https,file", "--proto-redir", "=https", "--retry", "2", "--max-time", String(timeoutSec), "-o", dest, url], options);
    if (curl.status === 0) return;
    let reason = String(curl.stderr || "").trim().split(/\r?\n/).pop() || (curl.error ? curl.error.message : `curl exited ${curl.status}`);
    if (curl.error && (curl.error as NodeJS.ErrnoException).code === "ENOENT" && /^https:/i.test(url)) {
        const wget = spawnSync("wget", ["-q", "--https-only", "-T", String(timeoutSec), "-O", dest, url], options);
        if (wget.status === 0) return;
        reason = wget.error ? "neither curl nor wget is installed" : `wget exited ${wget.status}`;
    }
    rmSync(dest, { force: true });
    throw new Error(`download failed: ${url} (${reason})`);
}

/** Download `url` into memory (through a private temp file). */
export function fetchBytes(url: string, timeoutSec = 120): Buffer {
    const dir = join(tmpdir(), `enigma-fetch-${process.pid}-${Date.now()}`);
    const file = join(dir, "asset");
    try {
        downloadTo(url, file, timeoutSec);
        return readFileSync(file);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Parse a `sha256sum`-format file: `<64 hex>  <name>` (or `*<name>` in binary mode) per line. */
export function parseSums(text: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
        if (match) sums.set(match[2]!, match[1]!.toLowerCase());
    }
    return sums;
}

/** The `npm pack` file-name prefix of a package: `@enigmax/dashboard` -> `enigmax-dashboard`. */
export function packPrefix(pkgName: string): string {
    return pkgName.replace(/^@/, "").replace(/\//g, "-");
}

/** The tarball of `pkgName` listed in a release's sums, with the version in its name. */
export function packageAsset(sums: Map<string, string>, pkgName: string): { asset: string; version: string; } | null {
    const pattern = new RegExp(`^${packPrefix(pkgName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(${SEMVER})\\.tgz$`);
    for (const asset of sums.keys()) {
        const match = pattern.exec(asset);
        if (match) return { asset, version: match[1]! };
    }
    return null;
}

/**
 * Base URL holding one release's assets. ENIGMA_DOWNLOAD_BASE (the mirror override bin/download.mjs
 * already honours) wins and names ONE release directory; otherwise the pinned tag, or `latest`.
 */
export function releaseBase(version?: string): string {
    const mirror = process.env.ENIGMA_DOWNLOAD_BASE;
    if (mirror) return mirror.replace(/\/+$/, "");
    return version ? `${RELEASES_URL}/download/v${version}` : `${RELEASES_URL}/latest/download`;
}

/**
 * Fetch and parse a release's SHA256SUMS. For `latest` the version is read from the enigma-cli
 * tarball it lists and every later download goes to that exact tag, so a release published
 * between two requests can never pair one release's checksums with another's asset.
 */
export function fetchReleaseSums(version?: string, timeoutSec = 30): ReleaseSums {
    let base = releaseBase(version);
    const sums = parseSums(fetchBytes(`${base}/${SUMS_FILE}`, timeoutSec).toString("utf8"));
    const cli = packageAsset(sums, "enigma-cli");
    if (!cli) throw new Error(`${base}/${SUMS_FILE} lists no enigma-cli tarball`);
    if (version && cli.version !== version) throw new Error(`release at ${base} is enigma-cli ${cli.version}, not ${version}`);
    if (!process.env.ENIGMA_DOWNLOAD_BASE) base = `${RELEASES_URL}/download/v${cli.version}`;
    return { base, version: cli.version, sums };
}

/**
 * The latest release's SHA256SUMS without blocking the event loop, for a long-lived server
 * (the dashboard) that only reads version numbers from it and must not stall on the network.
 */
export async function fetchLatestSumsAsync(timeoutMs = 30000): Promise<Map<string, string>> {
    if (process.env.ENIGMA_OFFLINE === "1") throw new Error("offline (ENIGMA_OFFLINE=1)");
    const url = `${releaseBase()}/${SUMS_FILE}`;
    assertAllowedUrl(url);
    if (/^file:\/\//i.test(url)) return parseSums(await readFile(fileURLToPath(url), "utf8"));
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "enigma-cli-update-check" } });
    if (!/^https:\/\//i.test(res.url || url)) throw new Error(`refusing non-HTTPS redirect: ${res.url}`);
    if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
    return parseSums(await res.text());
}

/** The latest enigma-cli version published as a GitHub release, or null when unreachable. */
export function latestReleaseVersion(timeoutSec = 5): string | null {
    try { return fetchReleaseSums(undefined, timeoutSec).version; } catch { return null; }
}

/** Throw unless `buffer` hashes to `expected`. */
export function verifySha256(buffer: Buffer, expected: string | undefined, name: string): void {
    if (!expected) throw new Error(`${name} is not listed in ${SUMS_FILE}; refusing to use it`);
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
}

/** Download one asset of a release and verify it against that release's SHA256SUMS. */
export function fetchVerified(release: ReleaseSums, asset: string, timeoutSec = 180): Buffer {
    const expected = release.sums.get(asset);
    if (!expected) throw new Error(`${asset} is not listed in ${SUMS_FILE}; refusing to use it`);
    const buffer = fetchBytes(`${release.base}/${asset}`, timeoutSec);
    verifySha256(buffer, expected, asset);
    return buffer;
}

/** Text of a NUL-terminated tar header field. */
function field(header: Buffer, start: number, length: number): string {
    const raw = header.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** The `path` record of a pax extended header, if any. */
function paxPath(body: Buffer): string | null {
    let offset = 0;
    const text = body.toString("utf8");
    while (offset < text.length) {
        const space = text.indexOf(" ", offset);
        if (space === -1) break;
        const length = Number.parseInt(text.slice(offset, space), 10);
        if (!length) break;
        const record = text.slice(space + 1, offset + length - 1);
        if (record.startsWith("path=")) return record.slice(5);
        offset += length;
    }
    return null;
}

/** The path below `strip` an entry extracts to, or a thrown error for anything outside it. */
function safeRelative(name: string, strip: string): string {
    if (!name.startsWith(strip)) throw new Error(`unexpected tar entry outside ${strip}: ${name}`);
    const parts = name.slice(strip.length).split("/").filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === ".." || part.includes("\\") || part.includes(":"))) throw new Error(`unsafe tar entry: ${name}`);
    return parts.join("/");
}

/**
 * Extract a gzipped tarball (as `npm pack` writes it) into `dest`, dropping the leading
 * `package/`. Regular files and directories only; links and devices are refused, and every path
 * is checked to stay inside `dest`. Returns the number of files written.
 */
export function extractTgz(buffer: Buffer, dest: string, strip = "package/"): number {
    const tar = gunzipSync(buffer);
    const root = resolve(dest);
    mkdirSync(root, { recursive: true });
    let offset = 0;
    let files = 0;
    let longName: string | null = null;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        if (header[124]! & 0x80) throw new Error("unsupported tar size encoding");
        const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
        const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
        const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : "";
        const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
        const body = tar.subarray(offset + 512, offset + 512 + size);
        if (body.length < size) throw new Error("truncated tarball");
        offset += 512 + Math.ceil(size / 512) * 512;
        longName = null;
        if (type === "x") { longName = paxPath(body); continue; }
        if (type === "L") { longName = field(body, 0, body.length); continue; }
        if (type === "g") continue;
        if (type !== "0" && type !== "5") throw new Error(`unsupported tar entry type '${type}': ${name}`);
        const rel = safeRelative(name, strip);
        if (!rel) continue;
        const target = resolve(root, rel);
        if (!target.startsWith(root + sep)) throw new Error(`unsafe tar entry: ${name}`);
        if (type === "5") { mkdirSync(target, { recursive: true }); continue; }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
        const mode = Number.parseInt(field(header, 100, 8).trim() || "0", 8);
        if (process.platform !== "win32" && mode & 0o111) chmodSync(target, 0o755);
        files++;
    }
    return files;
}

/**
 * Install `pkgName` from a GitHub release into `<hostDir>/node_modules/<pkgName>`, the layout
 * `npm install` leaves, replacing what is there. Returns the installed version. Throws on any
 * failure, leaving the previous install untouched.
 */
export function installReleasePackage(pkgName: string, hostDir: string, release: ReleaseSums = fetchReleaseSums()): string {
    const found = packageAsset(release.sums, pkgName);
    if (!found) throw new Error(`${pkgName} is not published in release v${release.version}`);
    const buffer = fetchVerified(release, found.asset);
    const target = join(hostDir, "node_modules", ...pkgName.split("/"));
    const staging = `${target}.staging-${process.pid}`;
    const retired = `${target}.old-${process.pid}-${Date.now()}`;
    rmSync(staging, { recursive: true, force: true });
    try {
        extractTgz(buffer, staging);
        if (!existsSync(join(staging, "package.json"))) throw new Error(`${found.asset} has no package.json`);
        if (existsSync(target)) renameSync(target, retired);
        renameSync(staging, target);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        if (!existsSync(target) && existsSync(retired)) renameSync(retired, target);
        throw error;
    }
    rmSync(retired, { recursive: true, force: true });
    return found.version;
}

/**
 * Root of the running enigma-cli package. The compiled binary lives at `<root>/bin/enigma-bin`
 * in a standalone install, and the launcher/shim stamps ENIGMA_ASSETS_DIR as `<root>/assets`.
 * The binary's own path is checked first because it cannot be inherited from a parent enigma.
 */
export function cliPackageRoot(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string | null {
    const candidates = [dirname(dirname(execPath)), env.ENIGMA_ASSETS_DIR ? dirname(env.ENIGMA_ASSETS_DIR) : ""];
    for (const root of candidates) {
        if (root && existsSync(join(root, "package.json"))) return root;
    }
    return null;
}

/** `standalone` when the package root carries the marker the installer writes, else `npm`. */
export function installMethod(root: string | null = cliPackageRoot()): InstallMethod {
    if (!root) return "npm";
    try { return readFileSync(join(root, "install-method"), "utf8").trim() === "standalone" ? "standalone" : "npm"; } catch { return "npm"; }
}

/** The release asset name of this host's compiled binary present in `sums`, mirroring bin/platform.mjs. */
export function hostBinaryAsset(sums: Map<string, string>, platform: string = process.platform, arch: string = process.arch): string | null {
    if (!["win32", "darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
    const base = `${platform}-${arch}`;
    let musl = false;
    try { musl = platform === "linux" && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string; }; } | undefined)?.header?.glibcVersionRuntime; } catch { /* glibc */ }
    const keys = musl ? [`${base}-musl`, base] : [base];
    return keys.map((key) => `enigma-${key}${platform === "win32" ? ".exe" : ""}`).find((asset) => sums.has(asset)) ?? null;
}

/** The directory name `current` points at in a standalone root, or null. */
export function currentStandaloneVersion(root: string): string | null {
    try { return readFileSync(join(root, "current"), "utf8").trim() || null; } catch { return null; }
}

/**
 * Install release `version` (or the latest) into a standalone root: `<root>/<version>` holds the
 * extracted enigma-cli package plus `bin/enigma-bin[.exe]` and the `install-method` marker, and
 * `<root>/current` names the active version. The switch is a rename of `current`, so a shim never
 * sees a half-written tree, and versioned directories mean the running binary (locked on
 * Windows) is never overwritten. Returns the installed version. Throws on any failure, with the
 * previous `current` still in place.
 */
export function installStandalone(root: string, version?: string, release: ReleaseSums = fetchReleaseSums(version)): string {
    const binaryAsset = hostBinaryAsset(release.sums);
    if (!binaryAsset) throw new Error(`release v${release.version} has no binary for ${process.platform}-${process.arch}`);
    const cli = packageAsset(release.sums, "enigma-cli")!;
    const tarball = fetchVerified(release, cli.asset);
    const binary = fetchVerified(release, binaryAsset);
    const dest = join(root, release.version);
    const staging = join(root, `.staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    try {
        extractTgz(tarball, staging);
        const binName = process.platform === "win32" ? "enigma-bin.exe" : "enigma-bin";
        writeFileSync(join(staging, "bin", binName), binary);
        if (process.platform !== "win32") chmodSync(join(staging, "bin", binName), 0o755);
        writeFileSync(join(staging, "install-method"), "standalone\n");
        if (existsSync(dest)) {
            if (currentStandaloneVersion(root) === release.version) { rmSync(staging, { recursive: true, force: true }); return release.version; }
            rmSync(dest, { recursive: true, force: true });
        }
        renameSync(staging, dest);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    const pointer = join(root, `current.tmp-${process.pid}`);
    writeFileSync(pointer, `${release.version}\n`);
    renameSync(pointer, join(root, "current"));
    pruneStandalone(root, release.version);
    return release.version;
}

/** Remove superseded version dirs except `keep` and the newest one before it. Best-effort. */
function pruneStandalone(root: string, keep: string): void {
    let names: string[];
    try { names = readdirSync(root).filter((name) => new RegExp(`^${SEMVER}$`).test(name) && name !== keep); } catch { return; }
    const older = names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const name of older.slice(0, -1)) {
        try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* a running binary still holds it */ }
    }
}
