/**
 * Build the platform-specific, Bun-compiled enigma binaries (the opencode model).
 *
 * Each target produces a standalone executable that embeds the Bun runtime plus the
 * OpenTUI native core, laid out as a publishable npm package under dist-bin/:
 *
 *   dist-bin/enigma-cli-<os>-<arch>/
 *     bin/enigma[.exe]      <- bun build --compile output
 *     package.json          <- name/version/os/cpu so npm installs only the match
 *
 * The main package lists these as optionalDependencies; its bin/enigma.mjs launcher
 * resolves and execs the right one. Run under Bun: `bun scripts/build-binaries.ts`.
 *
 * By default builds only the HOST target (what this runner can compile natively, the
 * only reliable way to embed OpenTUI's native FFI core). CI calls one runner per OS.
 * Pass `--target=<bun-target>` to force a specific one, or `--all` to attempt every
 * target (cross-compile; the non-host native cores may be missing - use the matrix).
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Target { bun: string; pkg: string; os: string; cpu: string; exe: string; }

// bun --target -> npm package identity. npm "os" uses win32 (not "windows").
const TARGETS: Target[] = [
    { bun: "bun-linux-x64", pkg: "enigma-cli-linux-x64", os: "linux", cpu: "x64", exe: "enigma" },
    { bun: "bun-linux-arm64", pkg: "enigma-cli-linux-arm64", os: "linux", cpu: "arm64", exe: "enigma" },
    { bun: "bun-darwin-x64", pkg: "enigma-cli-darwin-x64", os: "darwin", cpu: "x64", exe: "enigma" },
    { bun: "bun-darwin-arm64", pkg: "enigma-cli-darwin-arm64", os: "darwin", cpu: "arm64", exe: "enigma" },
    { bun: "bun-windows-x64", pkg: "enigma-cli-win32-x64", os: "win32", cpu: "x64", exe: "enigma.exe" },
];

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distBin = join(pkgRoot, "dist-bin");
const entry = join(pkgRoot, "src", "bin", "enigma.ts");
const main = JSON.parse(await Bun.file(join(pkgRoot, "package.json")).text()) as { version: string; license?: string; repository?: unknown };

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

async function build(target: Target): Promise<void> {
    const outDir = join(distBin, target.pkg);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(join(outDir, "bin"), { recursive: true });

    const outfile = join(outDir, "bin", target.exe);
    console.log(`Compiling ${target.pkg} (${target.bun})...`);
    const proc = Bun.spawnSync(
        ["bun", "build", "--compile", `--target=${target.bun}`, entry, "--outfile", outfile],
        { cwd: pkgRoot, stdout: "inherit", stderr: "inherit" },
    );
    if (proc.exitCode !== 0) throw new Error(`bun build failed for ${target.pkg} (exit ${proc.exitCode}).`);
    if (!existsSync(outfile)) throw new Error(`Expected ${outfile} was not produced.`);

    const pkg = {
        name: target.pkg,
        version: main.version,
        description: `Prebuilt enigma binary for ${target.os}-${target.cpu}.`,
        os: [target.os],
        cpu: [target.cpu],
        files: ["bin"],
        license: main.license ?? "Apache-2.0",
        repository: main.repository,
    };
    writeFileSync(join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    const license = join(pkgRoot, "LICENSE");
    if (existsSync(license)) copyFileSync(license, join(outDir, "LICENSE"));
    console.log(`  -> ${join("dist-bin", target.pkg, "bin", target.exe)}`);
}

const targets = selectTargets(process.argv.slice(2));
for (const target of targets) await build(target);
console.log(`Built ${targets.length} binary package(s) into dist-bin/.`);
