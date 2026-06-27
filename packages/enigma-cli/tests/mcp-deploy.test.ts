/**
 * MCP deployment: with `compress` on, the enigma MCP server is registered in each
 * tool's own config format (claude JSON mcpServers, codex [mcp_servers.enigma]
 * TOML, opencode mcp JSON) while preserving other keys; with it off the entry is
 * removed and unrelated keys survive. Temp HOME (set BEFORE import) isolates the
 * global config files the deploy writes to.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-mcp-deploy-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { applyMcpForAgent, applyMcpForAccount, applyMcpToggle } = await import("../src/mcp-deploy");
const { setEnigmaValue } = await import("../src/config");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

test("claude global: registers mcpServers.enigma, preserving existing keys", () => {
    const file = join(HOME, ".claude.json");
    writeFileSync(file, JSON.stringify({ numStartups: 7, mcpServers: { other: { type: "stdio", command: "x" } } }));
    setEnigmaValue("compress", true, "global");

    expect(applyMcpForAgent("claude", "global")).toBe(true);
    const cfg = readJson(file);
    expect(cfg.numStartups).toBe(7);                       // unrelated key preserved
    expect(cfg.mcpServers.other.command).toBe("x");        // other server preserved
    expect(cfg.mcpServers.enigma.args).toEqual(expect.arrayContaining(["mcp"]));
});

test("codex global: writes [mcp_servers.enigma] into config.toml", () => {
    const file = join(HOME, ".codex", "config.toml");
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    writeFileSync(file, "approval_policy = \"never\"\n");
    setEnigmaValue("compress", true, "global");

    expect(applyMcpForAgent("codex", "global")).toBe(true);
    const toml = readFileSync(file, "utf8");
    expect(toml).toContain("approval_policy = \"never\""); // existing key preserved
    expect(toml).toContain("[mcp_servers.enigma]");
    expect(toml).toMatch(/args = \[.*'mcp'.*\]/);
});

test("codex MCP entry is idempotent across repeated syncs (no phantom 'updated')", () => {
    const file = join(HOME, ".codex", "config.toml");
    writeFileSync(file, "approval_policy = \"never\"\n");
    setEnigmaValue("compress", true, "global");
    expect(applyMcpForAgent("codex", "global")).toBe(true);   // first write registers it
    expect(applyMcpForAgent("codex", "global")).toBe(false);  // re-running changes nothing
    expect(applyMcpForAgent("codex", "global")).toBe(false);  // ...and stays a fixed point
});

test("opencode account: writes mcp.enigma into the account opencode.json", () => {
    const dir = join(HOME, ".enigma", "opencode", "work");
    setEnigmaValue("compress", true, "global");
    expect(applyMcpForAccount("opencode", dir)).toBe(true);
    const cfg = readJson(join(dir, "xdg-config", "opencode", "opencode.json"));
    expect(cfg.mcp.enigma.type).toBe("local");
    expect(cfg.mcp.enigma.command).toEqual(expect.arrayContaining(["mcp"]));
});

test("turning compress off removes the entry but keeps other config", () => {
    const file = join(HOME, ".claude.json");
    setEnigmaValue("compress", false, "global");
    expect(applyMcpForAgent("claude", "global")).toBe(true);
    const cfg = readJson(file);
    expect(cfg.mcpServers.enigma).toBeUndefined();
    expect(cfg.mcpServers.other.command).toBe("x");        // unrelated server survives
    expect(cfg.numStartups).toBe(7);
});

test("codex has no project-local config: local scope is a no-op", () => {
    setEnigmaValue("compress", true, "global");
    expect(applyMcpForAgent("codex", "local")).toBe(false);
});

test("disabling when no config file exists does not create one", () => {
    const dir = join(HOME, ".enigma", "claude", "ghost");
    setEnigmaValue("compress", false, "global");
    expect(applyMcpForAccount("claude", dir)).toBe(false);
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
});

test("compress toggle applies immediately, only to tools with an existing config", () => {
    const home2 = mkdtempSync(join(tmpdir(), "enigma-mcp-toggle-"));
    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = home2;
    process.env.HOME = home2;
    try {
        const claudeCfg = join(home2, ".claude.json");
        writeFileSync(claudeCfg, JSON.stringify({ numStartups: 1 }));   // claude is used
        // codex/opencode have NO config here -> an enable must not create them.
        setEnigmaValue("compress", true, "global");
        const on = applyMcpToggle("global");
        expect(on).toEqual(["claude"]);
        expect(readJson(claudeCfg).mcpServers.enigma.args).toEqual(expect.arrayContaining(["mcp"]));
        expect(existsSync(join(home2, ".codex", "config.toml"))).toBe(false);

        setEnigmaValue("compress", false, "global");
        const off = applyMcpToggle("global");
        expect(off).toEqual(["claude"]);
        expect(readJson(claudeCfg).mcpServers?.enigma).toBeUndefined();
    } finally {
        process.env.USERPROFILE = prev;
        process.env.HOME = prev;
        rmSync(home2, { recursive: true, force: true });
    }
});
