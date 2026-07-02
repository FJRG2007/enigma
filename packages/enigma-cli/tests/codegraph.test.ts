/**
 * Code-graph (codebase-memory-mcp) integration: with `codeGraph` on, the external server is
 * registered in each managed agent's own config (claude JSON mcpServers, codex
 * [mcp_servers.codebase-memory] TOML, opencode mcp JSON) under a distinct name from enigma's own
 * server, preserving other keys; off removes it. Query helpers degrade to empty when the tool is
 * not runnable.
 *
 * Assertions go through the ACCOUNT paths (which take an explicit dir) and the LOCAL scope (which
 * uses process.cwd()), never the GLOBAL scope - global config paths use os.homedir(), and bun on
 * Linux does not reflect a reassigned HOME, so a homedir-based test would pass on Windows yet fail
 * in CI. Config is pinned via ENIGMA_CONFIG_HOME (honored by enigmaHome()); ENIGMA_CBM_BIN pins
 * the tool binary so registration is deterministic and the query helpers hit their failure branch.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-codegraph-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.ENIGMA_CBM_BIN = join(HOME, "fake", "codebase-memory-mcp");

const cg = await import("../src/codegraph");
const { setEnigmaValue } = await import("../src/config");

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    delete process.env.ENIGMA_CBM_BIN;
    delete process.env.ENIGMA_CONFIG_HOME;
});

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

test("claude account: registers mcpServers['codebase-memory'], preserving enigma's own server", () => {
    const dir = join(HOME, "acct", "claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ".claude.json");
    writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { enigma: { type: "stdio", command: "enigma", args: ["mcp"] } } }));
    setEnigmaValue("codeGraph", true, "global");

    expect(cg.applyCodeGraphForAccount("claude", dir)).toBe(true);
    const c = readJson(file);
    expect(c.numStartups).toBe(3);                                 // unrelated key preserved
    expect(c.mcpServers.enigma.args).toEqual(["mcp"]);            // enigma's own server untouched
    const entry = c.mcpServers["codebase-memory"];
    expect(entry).toBeDefined();
    expect([entry.command, ...(entry.args || [])].join(" ")).toContain("codebase-memory-mcp");
});

test("codex account: writes [mcp_servers.codebase-memory] and is idempotent", () => {
    const dir = join(HOME, "acct", "codex");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.toml");
    writeFileSync(file, "approval_policy = \"never\"\n");
    setEnigmaValue("codeGraph", true, "global");

    expect(cg.applyCodeGraphForAccount("codex", dir)).toBe(true);
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain("approval_policy = \"never\"");
    expect(toml).toContain("[mcp_servers.codebase-memory]");
    expect(cg.applyCodeGraphForAccount("codex", dir)).toBe(false);  // fixed point, no phantom update
});

test("opencode account: writes mcp['codebase-memory'] into the account opencode.json", () => {
    const dir = join(HOME, "acct", "opencode");
    setEnigmaValue("codeGraph", true, "global");
    expect(cg.applyCodeGraphForAccount("opencode", dir)).toBe(true);
    const c = readJson(join(dir, "xdg-config", "opencode", "opencode.json"));
    expect(c.mcp["codebase-memory"].type).toBe("local");
});

test("turning codeGraph off removes the entry but keeps enigma's own server", () => {
    const dir = join(HOME, "acct", "claude");
    setEnigmaValue("codeGraph", false, "global");
    expect(cg.applyCodeGraphForAccount("claude", dir)).toBe(true);
    const c = readJson(join(dir, ".claude.json"));
    expect(c.mcpServers["codebase-memory"]).toBeUndefined();
    expect(c.mcpServers.enigma.args).toEqual(["mcp"]);            // enigma server survives
    expect(c.numStartups).toBe(3);
});

test("toggle applies immediately at local scope, only to tools with an existing config", () => {
    const proj = mkdtempSync(join(tmpdir(), "enigma-codegraph-proj-"));
    const prevCwd = process.cwd();
    process.chdir(proj);
    try {
        writeFileSync(join(proj, ".mcp.json"), "{}");           // claude local config exists
        writeFileSync(join(proj, "opencode.json"), "{}");       // opencode local config exists
        // codex has no project-local config -> it is skipped either way.
        setEnigmaValue("codeGraph", true, "global");
        const on = cg.applyCodeGraphToggle("local");
        expect(on).toContain("claude");
        expect(on).toContain("opencode");
        expect(readJson(join(proj, ".mcp.json")).mcpServers["codebase-memory"]).toBeDefined();
        expect(readJson(join(proj, "opencode.json")).mcp["codebase-memory"].type).toBe("local");

        setEnigmaValue("codeGraph", false, "global");
        cg.applyCodeGraphToggle("local");
        expect(readJson(join(proj, ".mcp.json")).mcpServers?.["codebase-memory"]).toBeUndefined();
    } finally {
        process.chdir(prevCwd);
        rmSync(proj, { recursive: true, force: true });
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
