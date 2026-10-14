/**
 * Every Node version's enigma-cli: discovery under nvm-windows and nvm, and the update that
 * brings an older one to the version just installed.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { runtimeInstalls, updateRuntimeInstalls } from "@/update";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const ROOT = mkdtempSync(join(tmpdir(), "enigma-runtimes-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** Lays out one Node version: its node binary, npm, and (optionally) an enigma-cli. */
function nodeVersion(prefix: string, modules: string, node: string, enigma?: string): void {
    mkdirSync(join(prefix, modules, "npm", "bin"), { recursive: true });
    writeFileSync(join(prefix, modules, "npm", "bin", "npm-cli.js"), "");
    mkdirSync(join(prefix, node, ".."), { recursive: true });
    writeFileSync(join(prefix, node), "");
    if (!enigma) return;
    mkdirSync(join(prefix, modules, "enigma-cli"), { recursive: true });
    writeFileSync(join(prefix, modules, "enigma-cli", "package.json"), JSON.stringify({ name: "enigma-cli", version: enigma }));
}

test("nvm-windows: one install per Node version that has enigma-cli", () => {
    const home = join(ROOT, "nvm-windows");
    nodeVersion(join(home, "v20.20.2"), "node_modules", "node.exe", "1.56.1");
    nodeVersion(join(home, "v26.2.0"), "node_modules", "node.exe", "1.63.5");
    nodeVersion(join(home, "v22.1.0"), "node_modules", "node.exe");
    mkdirSync(join(home, "not-a-version"), { recursive: true });
    const found = runtimeInstalls({ NVM_HOME: home }, "win32");
    expect(found.map((i) => [i.prefix, i.version]).sort()).toEqual([[join(home, "v20.20.2"), "1.56.1"], [join(home, "v26.2.0"), "1.63.5"]]);
    const v20 = found.find((i) => i.prefix === join(home, "v20.20.2"))!;
    expect(v20.node).toBe(join(v20.prefix, "node.exe"));
    expect(v20.npmCli).toBe(join(v20.prefix, "node_modules", "npm", "bin", "npm-cli.js"));
});

test("nvm: versions/node under NVM_DIR, falling back to ~/.nvm", () => {
    const dir = join(ROOT, "nvm");
    nodeVersion(join(dir, "versions", "node", "v20.1.0"), join("lib", "node_modules"), join("bin", "node"), "1.50.0");
    expect(runtimeInstalls({ NVM_DIR: dir }, "linux").map((i) => i.version)).toEqual(["1.50.0"]);
    const home = join(ROOT, "home");
    nodeVersion(join(home, ".nvm", "versions", "node", "v18.0.0"), join("lib", "node_modules"), join("bin", "node"), "1.40.0");
    expect(runtimeInstalls({ HOME: home }, "linux").map((i) => i.version)).toEqual(["1.40.0"]);
});

test("no version manager, or an install missing its node, finds nothing", () => {
    expect(runtimeInstalls({}, "win32")).toEqual([]);
    expect(runtimeInstalls({ NVM_HOME: join(ROOT, "missing") }, "win32")).toEqual([]);
    const home = join(ROOT, "broken");
    nodeVersion(join(home, "v20.0.0"), "node_modules", "node.exe", "1.0.0");
    rmSync(join(home, "v20.0.0", "node.exe"));
    expect(runtimeInstalls({ NVM_HOME: home }, "win32")).toEqual([]);
});

test("only an older install is updated, and a failed update says how to finish it", () => {
    const prefix = join(ROOT, "nope");
    const install = (version: string) => ({ prefix, node: join(prefix, "no-such-node.exe"), npmCli: join(prefix, "npm-cli.js"), version });
    expect(updateRuntimeInstalls("1.63.5", [install("1.63.5"), install("1.64.0")])).toEqual([]);
    const [line] = updateRuntimeInstalls("1.63.5", [install("1.56.1")]);
    expect(line).toContain("still enigma-cli 1.56.1");
    expect(line).toContain("npm i -g enigma-cli@latest");
});
