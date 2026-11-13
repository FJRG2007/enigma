/**
 * The npm-independent delivery path (src/release-fetch.ts) and the updater built on it: install
 * method detection, the GitHub fallback of the version check, SHA256SUMS refusal on a mismatch,
 * and the on-disk layout an extracted tarball and a standalone install leave. A file:// mirror
 * (ENIGMA_DOWNLOAD_BASE) stands in for the GitHub release and a closed local port for an npm
 * registry that is down, so nothing here reaches the network. Temp HOME is set BEFORE import.
 */
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-relfetch-"));
process.env.USERPROFILE = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.HOME = HOME;
delete process.env.ENIGMA_OFFLINE;

const release = await import("../src/release-fetch");
const { latestVersion } = await import("../src/update");

afterAll(() => { rmSync(HOME, { recursive: true, force: true }); });

/** One ustar entry: a 512-byte header plus the body padded to 512. */
function tarEntry(name: string, body: Buffer | string = "", type = "0"): Buffer {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(type, 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** A gzipped tarball shaped like `npm pack` output. */
function tgz(...entries: Buffer[]): Buffer {
    return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
const fileUrl = (path: string): string => `file:///${resolve(path).replace(/\\/g, "/").replace(/^\//, "")}`;

/** Write a fake release (assets + SHA256SUMS) into a fresh dir and return it. */
function fakeRelease(assets: Record<string, Buffer>, override: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(HOME, "rel-"));
    const lines: string[] = [];
    for (const [name, buffer] of Object.entries(assets)) {
        writeFileSync(join(dir, name), buffer);
        lines.push(`${override[name] ?? sha(buffer)} *${name}`);
    }
    writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
    return dir;
}

const cliTarball = (version: string): Buffer => tgz(
    tarEntry("package/package.json", JSON.stringify({ name: "enigma-cli", version })),
    tarEntry("package/bin/enigma.mjs", "// launcher\n"),
    tarEntry("package/assets/skills/core/SKILL.md", "# core\n"),
);
const dashTarball = (version: string): Buffer => tgz(
    tarEntry("package/package.json", JSON.stringify({ name: "@enigmax/dashboard", version })),
    tarEntry("package/assets/index.html", "<!doctype html>\n"),
);
const binaryAsset = `enigma-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const binName = process.platform === "win32" ? "enigma-bin.exe" : "enigma-bin";

test("parses SHA256SUMS in text and binary mode and finds package tarballs by name", () => {
    const sums = release.parseSums(`${"a".repeat(64)}  enigma-cli-1.2.3.tgz\n${"B".repeat(64)} *enigmax-dashboard-0.1.9.tgz\nnot a line\n`);
    expect(sums.get("enigma-cli-1.2.3.tgz")).toBe("a".repeat(64));
    expect(sums.get("enigmax-dashboard-0.1.9.tgz")).toBe("b".repeat(64));
    expect(release.packageAsset(sums, "@enigmax/dashboard")).toEqual({ asset: "enigmax-dashboard-0.1.9.tgz", version: "0.1.9" });
    expect(release.packageAsset(sums, "@enigmax/helio")).toBeNull();
});

test("extracts an npm-pack tarball without the package/ prefix, honoring pax long names", () => {
    const longName = `package/${"deep/".repeat(30)}file.txt`;
    const dest = join(HOME, "extract");
    const files = release.extractTgz(tgz(
        tarEntry("package/package.json", "{}"),
        tarEntry("PaxHeader", `${`path=${longName}\n`.length + 4} path=${longName}\n`, "x"),
        tarEntry("package/placeholder", "long"),
        tarEntry("package/dir/", "", "5"),
    ), dest);
    expect(files).toBe(2);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(readFileSync(join(dest, ...longName.slice("package/".length).split("/")), "utf8")).toBe("long");
});

test("refuses tar entries that escape the destination or are links", () => {
    const dest = join(HOME, "evil");
    expect(() => release.extractTgz(tgz(tarEntry("package/../../escape.txt", "x")), dest)).toThrow(/unsafe tar entry/);
    expect(() => release.extractTgz(tgz(tarEntry("other/file", "x")), dest)).toThrow(/outside package/);
    expect(() => release.extractTgz(tgz(tarEntry("package/link", "", "2")), dest)).toThrow(/unsupported tar entry type/);
    expect(existsSync(join(HOME, "escape.txt"))).toBe(false);
});

test("refuses non-HTTPS URLs before any request", () => {
    expect(() => release.assertAllowedUrl("http://example.com/x")).toThrow(/non-HTTPS/);
    expect(() => release.assertAllowedUrl("https://example.com/x")).not.toThrow();
    expect(() => release.assertAllowedUrl("file:///tmp/x")).not.toThrow();
});

test("installs a package from the release into the npm node_modules layout", () => {
    process.env.ENIGMA_DOWNLOAD_BASE = fileUrl(fakeRelease({ "enigma-cli-1.0.1.tgz": cliTarball("1.0.1"), "enigmax-dashboard-0.2.0.tgz": dashTarball("0.2.0") }));
    const host = join(HOME, "dashboard-host");
    expect(release.installReleasePackage("@enigmax/dashboard", host)).toBe("0.2.0");
    const pkg = join(host, "node_modules", "@enigmax", "dashboard");
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("0.2.0");
    expect(existsSync(join(pkg, "assets", "index.html"))).toBe(true);
});

test("refuses an asset whose SHA256 does not match and keeps the previous install", () => {
    const host = join(HOME, "dashboard-host");
    process.env.ENIGMA_DOWNLOAD_BASE = fileUrl(fakeRelease(
        { "enigma-cli-1.0.2.tgz": cliTarball("1.0.2"), "enigmax-dashboard-0.3.0.tgz": dashTarball("0.3.0") },
        { "enigmax-dashboard-0.3.0.tgz": "0".repeat(64) },
    ));
    expect(() => release.installReleasePackage("@enigmax/dashboard", host)).toThrow(/Checksum mismatch/);
    expect(JSON.parse(readFileSync(join(host, "node_modules", "@enigmax", "dashboard", "package.json"), "utf8")).version).toBe("0.2.0");
});

test("detects a standalone install from the marker beside the package root", () => {
    const root = join(HOME, "detect", "1.0.0");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const exe = join(root, "bin", binName);
    expect(release.cliPackageRoot({}, exe)).toBe(root);
    expect(release.installMethod(root)).toBe("npm");
    writeFileSync(join(root, "install-method"), "standalone\n");
    expect(release.installMethod(root)).toBe("standalone");
    expect(release.cliPackageRoot({ ENIGMA_ASSETS_DIR: join(root, "assets") }, "/nowhere/node")).toBe(root);
    expect(release.installMethod(null)).toBe("npm");
});

test("a standalone update installs the new version beside the old one and switches current", () => {
    const root = join(HOME, "standalone");
    mkdirSync(join(root, "1.0.0", "bin"), { recursive: true });
    writeFileSync(join(root, "1.0.0", "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(root, "current"), "1.0.0\n");
    const binary = Buffer.from("fake binary");
    process.env.ENIGMA_DOWNLOAD_BASE = fileUrl(fakeRelease({ "enigma-cli-1.0.1.tgz": cliTarball("1.0.1"), [binaryAsset]: binary }));
    expect(release.installStandalone(root)).toBe("1.0.1");
    expect(release.currentStandaloneVersion(root)).toBe("1.0.1");
    expect(readFileSync(join(root, "1.0.1", "install-method"), "utf8").trim()).toBe("standalone");
    expect(readFileSync(join(root, "1.0.1", "bin", binName)).equals(binary)).toBe(true);
    expect(existsSync(join(root, "1.0.1", "bin", "enigma.mjs"))).toBe(true);
    expect(existsSync(join(root, "1.0.0"))).toBe(true);
});

test("a standalone update with a tampered binary leaves current untouched", () => {
    const root = join(HOME, "standalone");
    process.env.ENIGMA_DOWNLOAD_BASE = fileUrl(fakeRelease({ "enigma-cli-1.0.2.tgz": cliTarball("1.0.2"), [binaryAsset]: Buffer.from("x") }, { [binaryAsset]: "f".repeat(64) }));
    expect(() => release.installStandalone(root)).toThrow(/Checksum mismatch/);
    expect(release.currentStandaloneVersion(root)).toBe("1.0.1");
    expect(existsSync(join(root, "1.0.2"))).toBe(false);
});

test("version check: npm installs fall back to the GitHub release when the registry is down", async () => {
    process.env.ENIGMA_DOWNLOAD_BASE = fileUrl(fakeRelease({ "enigma-cli-4.5.6.tgz": cliTarball("4.5.6") }));
    process.env.ENIGMA_NPM_REGISTRY = "http://127.0.0.1:9";
    expect(await latestVersion("npm")).toBe("4.5.6");
    expect(await latestVersion("standalone")).toBe("4.5.6");
});

test("version check: npm installs still prefer the registry, standalone never asks it", async () => {
    const { createServer } = await import("node:http");
    const registry = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ version: "9.9.9" })); });
    await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
    process.env.ENIGMA_NPM_REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number; }).port}`;
    try {
        expect(await latestVersion("npm")).toBe("9.9.9");
        expect(await latestVersion("standalone")).toBe("4.5.6");
    } finally {
        registry.close();
    }
});

test("the async SHA256SUMS read the dashboard uses finds package versions without blocking", async () => {
    process.env.ENIGMA_DOWNLOAD_BASE = fileUrl(fakeRelease({ "enigma-cli-7.8.9.tgz": cliTarball("7.8.9"), "enigmax-dashboard-0.3.0.tgz": dashTarball("0.3.0") }));
    const sums = await release.fetchLatestSumsAsync(5000);
    expect(release.packageAsset(sums, "enigma-cli")?.version).toBe("7.8.9");
    expect(release.packageAsset(sums, "@enigmax/dashboard")?.version).toBe("0.3.0");
    process.env.ENIGMA_DOWNLOAD_BASE = "http://example.invalid/r";
    await expect(release.fetchLatestSumsAsync(5000)).rejects.toThrow(/non-HTTPS/);
});
