/**
 * Build the platform-specific, Bun-compiled enigma binaries.
 *
 * Single-package distribution (opencode-style mechanism): the binaries are NOT npm
 * packages. Each is published as a flat asset on the GitHub Release and fetched at
 * install time (see bin/download.mjs). This script emits, under dist-bin/:
 *
 *   dist-bin/enigma-<os>-<arch>[.exe]          <- bun build --compile output
 *   dist-bin/enigma-<os>-<arch>[.exe].sha256   <- hex SHA256 (CI -> bin/checksums.json)
 *
 * The asset name MUST match bin/platform.mjs `assetName()` (enigma-<os>-<arch>, .exe on
 * Windows), since that is what the launcher/downloader request. Run under Bun:
 * `bun scripts/build-binaries.ts`.
 *
 * By default builds only the HOST target (the only one whose OpenTUI native FFI core
 * embeds reliably). CI runs one native runner per OS. Pass `--target=<bun-target>` to
 * force one, or `--all` to attempt every target (cross-compile; non-host native cores
 * may be missing - use the matrix for releases).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Target { bun: string; os: string; cpu: string; }

// bun --target -> npm "os"/"cpu" identity (win32, not "windows"). Mirrors the CI matrix.
const TARGETS: Target[] = [
    { bun: "bun-linux-x64", os: "linux", cpu: "x64" },
    { bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
    { bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
    { bun: "bun-windows-x64", os: "win32", cpu: "x64" },
];

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distBin = join(pkgRoot, "dist-bin");
const entry = join(pkgRoot, "src", "bin", "enigma.ts");

/** Release asset name for a target (kept in sync with bin/platform.mjs assetName). */
function assetName(target: Target): string {
    return `enigma-${target.os}-${target.cpu}${target.os === "win32" ? ".exe" : ""}`;
}

/** The bun target string for the current host (the only natively embeddable one). */
function hostTarget(): string {
    const os = process.platform === "win32" ? "windows" : process.platform;
    return `bun-${os}-${process.arch}`;
}

function selectTargets(argv: string[]): Target[] {
    if (argv.includes("--all")) return TARGETS;
    const flag = argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
    const wanted = flag ?? hostTarget();
    const match = TARGETS.find((t) => t.bun === wanted);
    if (!match) throw new Error(`Unknown target "${wanted}". Known: ${TARGETS.map((t) => t.bun).join(", ")}.`);
    return [match];
}

function build(target: Target): void {
    const asset = assetName(target);
    const outfile = join(distBin, asset);

    console.log(`Compiling ${asset} (${target.bun})...`);
    const proc = Bun.spawnSync(
        ["bun", "build", "--compile", `--target=${target.bun}`, entry, "--outfile", outfile],
        { cwd: pkgRoot, stdout: "inherit", stderr: "inherit" },
    );
    if (proc.exitCode !== 0) throw new Error(`bun build failed for ${asset} (exit ${proc.exitCode}).`);
    if (!existsSync(outfile)) throw new Error(`Expected ${outfile} was not produced.`);

    const sha256 = createHash("sha256").update(readFileSync(outfile)).digest("hex");
    writeFileSync(`${outfile}.sha256`, `${sha256}\n`);
    console.log(`  -> dist-bin/${asset}  (${sha256.slice(0, 12)}...)`);
}

const targets = selectTargets(process.argv.slice(2));
rmSync(distBin, { recursive: true, force: true });
mkdirSync(distBin, { recursive: true });
for (const target of targets) build(target);
console.log(`Built ${targets.length} binary/binaries into dist-bin/.`);
