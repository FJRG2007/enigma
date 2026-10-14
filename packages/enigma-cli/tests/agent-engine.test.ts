/**
 * Agent engines (agent-engine.ts): the pinned runtime behind an agent's MCP server. Covers the
 * engine.json validation that guards the npm command line, the `engines.node` range reader that
 * picks which node runs the server, and the version-manager discovery behind it. Network-free:
 * nothing here installs a package.
 * Run under Bun: bun test tests/agent-engine.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const { readEngineSpec, satisfiesRange, pickNode, nodeRuntimes, engineBin, engineNodeRange, installedEngineVersion, ensureEngine } = await import("../src/agent-engine");

const TMP = mkdtempSync(join(tmpdir(), "enigma-engine-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function specIn(dir: string, body: unknown): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "engine.json"), JSON.stringify(body));
    return dir;
}

test("engine.json accepts only a plain package name and an exact version", () => {
    expect(readEngineSpec(specIn(join(TMP, "ok"), { package: "rea-agents", version: "6.5.0" }))).toEqual({ package: "rea-agents", version: "6.5.0" });
    expect(readEngineSpec(specIn(join(TMP, "scoped"), { package: "@scope/pkg", version: "1.2.3" }))).toEqual({ package: "@scope/pkg", version: "1.2.3" });
    // Both values reach an npm command line run through the shell, so anything else is refused.
    for (const bad of [
        { package: "rea-agents", version: "latest" },
        { package: "rea-agents", version: "^6.5.0" },
        { package: "rea-agents && calc", version: "6.5.0" },
        { package: "rea-agents", version: "6.5.0; rm -rf /" },
        { package: "rea-agents" },
        { version: "6.5.0" },
    ]) {
        expect(readEngineSpec(specIn(join(TMP, `bad-${Math.random().toString(36).slice(2)}`), bad))).toBeNull();
    }
    expect(readEngineSpec(join(TMP, "missing"))).toBeNull();
});

test("satisfiesRange reads the engines ranges REA declares", () => {
    const rea = "^22.19.0 || ^24.11.0 || >=26.0.0";
    expect(satisfiesRange("26.2.0", rea)).toBe(true);
    expect(satisfiesRange("24.11.0", rea)).toBe(true);
    expect(satisfiesRange("22.19.1", rea)).toBe(true);
    expect(satisfiesRange("20.20.2", rea)).toBe(false);
    expect(satisfiesRange("22.18.0", rea)).toBe(false);
    expect(satisfiesRange("24.10.9", rea)).toBe(false);
    expect(satisfiesRange("25.0.0", rea)).toBe(false);
    expect(satisfiesRange("v18.0.0", ">=18")).toBe(true);
    expect(satisfiesRange("18.5.0", ">=18 <19")).toBe(true);
    expect(satisfiesRange("19.0.0", ">=18 <19")).toBe(false);
    expect(satisfiesRange("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.3")).toBe(false);
    // A form it cannot read is unknown, never a guess.
    expect(satisfiesRange("26.0.0", "node-26")).toBeNull();
    expect(satisfiesRange("26.0.0", "1.x")).toBeNull();
});

test("pickNode keeps the PATH node when it qualifies, else the newest that does", () => {
    const range = "^22.19.0 || ^24.11.0 || >=26.0.0";
    const path = { path: "/path/node", version: "24.12.0" };
    const v20 = { path: "/nvm/v20/node", version: "20.20.2" };
    const v26 = { path: "/nvm/v26/node", version: "26.2.0" };
    const v22 = { path: "/nvm/v22/node", version: "22.20.0" };
    expect(pickNode(range, [path, v26])).toBe(path);
    // A shell defaulting to Node 20 still gets a server that starts.
    expect(pickNode(range, [v20, v22, v26])).toBe(v26);
    expect(pickNode(range, [v20])).toBeNull();
    // No declared range: the PATH node as-is.
    expect(pickNode(null, [v20, v26])).toBe(v20);
    expect(pickNode(range, [])).toBeNull();
});

test("nodeRuntimes lists nvm-windows and nvm versions from their directories", () => {
    const nvmHome = join(TMP, "nvm-win");
    for (const v of ["v20.20.2", "v26.2.0", "not-a-version"]) {
        mkdirSync(join(nvmHome, v), { recursive: true });
        writeFileSync(join(nvmHome, v, "node.exe"), "");
    }
    mkdirSync(join(nvmHome, "v24.0.0"), { recursive: true }); // no node.exe: skipped
    const win = nodeRuntimes({ NVM_HOME: nvmHome, PATH: "" }, "win32").filter((r) => r.path.startsWith(nvmHome));
    expect(win.map((r) => r.version).sort()).toEqual(["20.20.2", "26.2.0"]);

    const nvmDir = join(TMP, "nvm");
    mkdirSync(join(nvmDir, "versions", "node", "v22.19.0", "bin"), { recursive: true });
    writeFileSync(join(nvmDir, "versions", "node", "v22.19.0", "bin", "node"), "");
    const posix = nodeRuntimes({ NVM_DIR: nvmDir, PATH: "" }, "linux").filter((r) => r.path.startsWith(nvmDir));
    expect(posix).toEqual([{ path: join(nvmDir, "versions", "node", "v22.19.0", "bin", "node"), version: "22.19.0" }]);
});

test("an installed engine exposes its version, bin script and node range", () => {
    const root = join(TMP, "agent");
    const pkg = join(root, "engine", "node_modules", "rea-agents");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    writeFileSync(join(pkg, "scripts", "rea.mjs"), "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "6.5.0", bin: { rea: "scripts/rea.mjs" }, engines: { node: ">=26" } }));
    expect(installedEngineVersion(root, "rea-agents")).toBe("6.5.0");
    expect(engineBin(root, "rea-agents", "rea")).toBe(join(pkg, "scripts", "rea.mjs"));
    expect(engineBin(root, "rea-agents", "other")).toBeNull();
    expect(engineNodeRange(root, "rea-agents")).toBe(">=26");
    expect(installedEngineVersion(join(TMP, "none"), "rea-agents")).toBeNull();
});

test("a second session waits for the install another one holds instead of running npm again", () => {
    const root = join(TMP, "concurrent");
    const lock = join(root, "engine", ".install.lock");
    mkdirSync(lock, { recursive: true });
    // Stands in for the session holding the lock: it finishes the install, then releases.
    const pkg = join(root, "engine", "node_modules", "rea-agents");
    const finish = `setTimeout(() => { const fs = require("fs"); fs.mkdirSync(${JSON.stringify(pkg)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(join(pkg, "package.json"))}, JSON.stringify({ version: "6.5.0" })); fs.rmSync(${JSON.stringify(lock)}, { recursive: true }); }, 800);`;
    const child = spawn(process.execPath, ["-e", finish], { stdio: "ignore" });
    const started = Date.now();
    expect(ensureEngine(root, { package: "rea-agents", version: "6.5.0" })).toBeNull();
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(existsSync(lock)).toBe(false);
    child.kill();
});
