/**
 * Where the compiled binary is installed, which is the whole of the EBUSY fix.
 *
 * npm copies a package's directory aside before replacing it on upgrade, and Windows refuses
 * to copy or delete an `.exe` a running process has mapped as an image. While the ~96 MB
 * binary lived in `<pkg>/bin`, `npm i -g enigma-cli@latest` therefore failed with
 * `EBUSY: copyfile ... enigma-bin.exe` for anyone with an agent session open - and a machine
 * running enigma has sessions open by definition. `enigma update` worked around it by parking
 * the running binary (update.ts), but nothing could work around a plain npm install.
 *
 * The fix is that npm never sees the binary. This file pins that, because it is invisible in
 * normal use: putting the path back inside the package breaks nothing until someone upgrades
 * with a session open, on Windows, which no test on a Linux runner would ever notice.
 */
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const HOME = mkdtempSync(join(tmpdir(), "enigma-binloc-"));
process.env.ENIGMA_CONFIG_HOME = HOME;

const { binDir, binTargetPath, legacyBinTargetPath, pkgRoot, isWindows } = await import("../bin/platform.mjs");
const { version } = await import("../package.json");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("the binary lives outside the npm package, where no install can copy or lock it", () => {
    const target = binTargetPath();

    expect(target.startsWith(HOME), `${target} is not under the configured home`).toBe(true);
    expect(target.startsWith(pkgRoot), "the binary is back inside the package npm replaces").toBe(false);
    expect(target).toContain(join(".enigma", "bin"));
});

test("each package version gets its own directory", () => {
    // Two Node versions on one machine can hold two enigma versions. Sharing one path had them
    // overwrite each other's binary and re-download on every launch, each reading the other's
    // checksum as stale.
    expect(binTargetPath()).toContain(`${sep}${version}${sep}`);
    expect(binTargetPath().startsWith(binDir())).toBe(true);
});

test("the pre-1.46.4 location is still known, so its leftover can be swept", () => {
    const legacy = legacyBinTargetPath();

    expect(legacy.startsWith(pkgRoot), "the legacy path must still point into the package").toBe(true);
    expect(legacy).not.toBe(binTargetPath());
    expect(legacy.endsWith(isWindows ? "enigma-bin.exe" : "enigma-bin")).toBe(true);
});

test("the home override is honoured, so an isolated install stays isolated", () => {
    const other = mkdtempSync(join(tmpdir(), "enigma-binloc-other-"));
    const previous = process.env.ENIGMA_CONFIG_HOME;
    process.env.ENIGMA_CONFIG_HOME = other;
    try {
        expect(binDir().startsWith(other)).toBe(true);
    } finally {
        process.env.ENIGMA_CONFIG_HOME = previous;
        rmSync(other, { recursive: true, force: true });
    }
});
