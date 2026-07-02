/**
 * Code-graph (codebase-memory-mcp) integration: with `codeGraph` on, the external server is
 * registered in each managed agent's own config (claude JSON mcpServers, codex
 * [mcp_servers.codebase-memory] TOML, opencode mcp JSON) under a distinct name from enigma's own
 * server, preserving other keys; off removes it. Query helpers degrade to empty when the tool is
 * not runnable. Temp HOME + a pinned ENIGMA_CBM_BIN (both set BEFORE import) make it deterministic
 * without the real binary or npx.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-codegraph-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// Pin the tool binary to a fixed (non-existent) path: makes the registered command deterministic
// regardless of the CI PATH, and forces the query helpers down their graceful-failure branch.
process.env.ENIGMA_CBM_BIN = join(HOME, "fake", "codebase-memory-mcp");

const cg = await import("../src/codegraph");
const { setEnigmaValue } = await import("../src/config");

afterAll(() => { rmSync(HOME, { recursive: true, force: true }); delete process.env.ENIGMA_CBM_BIN; });

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

test("claude global: registers mcpServers['codebase-memory'], preserving existing keys", () => {
    const file = join(HOME, ".claude.json");
    writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { enigma: { type: "stdio", command: "enigma", args: ["mcp"] } } }));
    setEnigmaValue("codeGraph", true, "global");

    expect(cg.applyCodeGraphForAgent("claude", "global")).toBe(true);
    const c = readJson(file);
    expect(c.numStartups).toBe(3);                                 // unrelated key preserved
    expect(c.mcpServers.enigma.args).toEqual(["mcp"]);             // enigma's own server untouched
    const entry = c.mcpServers["codebase-memory"];
    expect(entry).toBeDefined();
    expect([entry.command, ...(entry.args || [])].join(" ")).toContain("codebase-memory-mcp");
});

test("codex global: writes [mcp_servers.codebase-memory] into config.toml", () => {
    const file = join(HOME, ".codex", "config.toml");
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    writeFileSync(file, "approval_policy = \"never\"\n");
    setEnigmaValue("codeGraph", true, "global");

    expect(cg.applyCodeGraphForAgent("codex", "global")).toBe(true);
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain("approval_policy = \"never\"");
    expect(toml).toContain("[mcp_servers.codebase-memory]");
    // Registering twice is a fixed point (no phantom "updated").
    expect(cg.applyCodeGraphForAgent("codex", "global")).toBe(false);
});

test("opencode account: writes mcp['codebase-memory'] into the account opencode.json", () => {
    const dir = join(HOME, ".enigma", "opencode", "work");
    setEnigmaValue("codeGraph", true, "global");
    expect(cg.applyCodeGraphForAccount("opencode", dir)).toBe(true);
    const c = readJson(join(dir, "xdg-config", "opencode", "opencode.json"));
    expect(c.mcp["codebase-memory"].type).toBe("local");
});

test("turning codeGraph off removes the entry but keeps enigma's own server", () => {
    const file = join(HOME, ".claude.json");
    setEnigmaValue("codeGraph", false, "global");
    expect(cg.applyCodeGraphForAgent("claude", "global")).toBe(true);
    const c = readJson(file);
    expect(c.mcpServers["codebase-memory"]).toBeUndefined();
    expect(c.mcpServers.enigma.args).toEqual(["mcp"]);             // enigma server survives
    expect(c.numStartups).toBe(3);
});

test("toggle applies immediately, only to tools with an existing config", () => {
    const home2 = mkdtempSync(join(tmpdir(), "enigma-codegraph-toggle-"));
    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = home2;
    process.env.HOME = home2;
    try {
        const claudeCfg = join(home2, ".claude.json");
        writeFileSync(claudeCfg, JSON.stringify({ numStartups: 1 }));  // claude is used
        setEnigmaValue("codeGraph", true, "global");
        expect(cg.applyCodeGraphToggle("global")).toEqual(["claude"]);
        expect(readJson(claudeCfg).mcpServers["codebase-memory"]).toBeDefined();
        expect(existsSync(join(home2, ".codex", "config.toml"))).toBe(false);  // never create unused config

        setEnigmaValue("codeGraph", false, "global");
        expect(cg.applyCodeGraphToggle("global")).toEqual(["claude"]);
        expect(readJson(claudeCfg).mcpServers?.["codebase-memory"]).toBeUndefined();
    } finally {
        process.env.USERPROFILE = prev;
        process.env.HOME = prev;
        rmSync(home2, { recursive: true, force: true });
    }
});

test("query helpers degrade gracefully when the tool cannot run", () => {
    // ENIGMA_CBM_BIN points at a non-existent file, so spawns fail: available (the path is set)
    // but projects/architecture come back empty/null rather than throwing.
    expect(cg.codeGraphAvailable()).toBe(true);
    expect(cg.codeGraphProjects()).toEqual([]);
    expect(cg.codeGraphArchitecture("anything")).toBeNull();
    const st = cg.codeGraphStatus();
    expect(st.available).toBe(true);
    expect(st.projects).toBe(0);
});
