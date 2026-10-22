/**
 * MCP deployment: with `compress` on, the enigma MCP server is registered in each
 * tool's own config format (claude JSON mcpServers, codex [mcp_servers.enigma]
 * TOML, opencode mcp JSON, kimi JSON mcpServers) while preserving other keys; with it off the entry is
 * removed and unrelated keys survive. Temp HOME (set BEFORE import) isolates the
 * global config files the deploy writes to.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-mcp-deploy-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// Kimi's paths resolve through ENIGMA_CONFIG_HOME (see kimi.ts), so pin it here too: without
// it this file would inherit whatever temp dir a test file that ran earlier left behind.
process.env.ENIGMA_CONFIG_HOME = HOME;

const { applyMcpForAgent, applyMcpForAccount, applyMcpToggle, mcpInvocation, browserInvocation, applyContextServer, hasContextServer, repairProjectBrowserEntries, isStaleBrowserEntry } = await import("../src/mcp-deploy");
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

test("kimi global: registers mcpServers.enigma in mcp.json, stdio-shaped", () => {
    const file = join(HOME, ".kimi-code", "mcp.json");
    mkdirSync(join(HOME, ".kimi-code"), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { url: "https://mcp.example.com/mcp" } } }));
    setEnigmaValue("compress", true, "global");

    expect(applyMcpForAgent("kimi", "global")).toBe(true);
    const cfg = readJson(file);
    expect(cfg.mcpServers.other.url).toBe("https://mcp.example.com/mcp"); // other server preserved
    expect(cfg.mcpServers.enigma.args).toEqual(expect.arrayContaining(["mcp"]));
    // Kimi infers stdio from `command`; a `type` field is outside its schema.
    expect(cfg.mcpServers.enigma.type).toBeUndefined();
    expect(applyMcpForAgent("kimi", "global")).toBe(false); // idempotent
});

test("kimi account: writes mcp.json inside the account data root", () => {
    const dir = join(HOME, ".enigma", "kimi", "work");
    setEnigmaValue("compress", true, "global");
    expect(applyMcpForAccount("kimi", dir)).toBe(true);
    expect(readJson(join(dir, "mcp.json")).mcpServers.enigma.command).toBeTruthy();
});

test("turning off the last enabled family removes the entry but keeps other config", () => {
    const file = join(HOME, ".claude.json");
    setEnigmaValue("compress", false, "global");
    // The server is shared: it is registered while ANY family wants it, so a test about the
    // entry disappearing has to turn off the code graph too (on by default) rather than assume it.
    setEnigmaValue("codeGraph", false, "global");
    expect(applyMcpForAgent("claude", "global")).toBe(true);
    const cfg = readJson(file);
    expect(cfg.mcpServers.enigma).toBeUndefined();
    expect(cfg.mcpServers.other.command).toBe("x");        // unrelated server survives
    expect(cfg.numStartups).toBe(7);
});

/**
 * One enigma MCP server hosts every tool family, so its registration follows whether ANY of them
 * is enabled - not whether a particular one is. Turning off compress while the code graph is on
 * must leave the server in place, or disabling one feature would silently take the others down.
 */
test("the server survives one family being turned off while another is on", () => {
    const file = join(HOME, ".claude.json");
    setEnigmaValue("codeGraph", true, "global");
    setEnigmaValue("compress", false, "global");
    applyMcpForAgent("claude", "global");
    expect(readJson(file).mcpServers.enigma).toBeDefined();
});

test("codex has no project-local config: local scope is a no-op", () => {
    setEnigmaValue("compress", true, "global");
    expect(applyMcpForAgent("codex", "local")).toBe(false);
});

test("disabling when no config file exists does not create one", () => {
    const dir = join(HOME, ".enigma", "claude", "ghost");
    setEnigmaValue("compress", false, "global");
    setEnigmaValue("codeGraph", false, "global");
    setEnigmaValue("browser", false, "global");
    expect(applyMcpForAccount("claude", dir)).toBe(false);
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
});

test("compress toggle applies immediately, only to tools with an existing config", () => {
    const home2 = mkdtempSync(join(tmpdir(), "enigma-mcp-toggle-"));
    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = home2;
    process.env.HOME = home2;
    process.env.ENIGMA_CONFIG_HOME = home2;
    try {
        const claudeCfg = join(home2, ".claude.json");
        writeFileSync(claudeCfg, JSON.stringify({ numStartups: 1 }));   // claude is used
        // codex/opencode/kimi have NO config here -> an enable must not create them.
        setEnigmaValue("codeGraph", false, "global");
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
        process.env.ENIGMA_CONFIG_HOME = prev;
        rmSync(home2, { recursive: true, force: true });
    }
});

// --- Windows: no `cmd /c` wrapper ------------------------------------------------------

/**
 * The Windows entry used to be `cmd /c enigma.cmd mcp`, because an npm `.cmd` shim cannot be
 * started by a shell-less spawn. That wrapper is a whole extra process per agent session, held
 * open for as long as the agent runs - eight open sessions meant eight of them - and spawned by
 * a parent with no console to inherit, Windows gives it a console window too.
 *
 * The platform is passed in rather than read, so this runs on the Linux runner CI uses.
 */
const PKG_ROOT = join(HOME, "enigma-cli-pkg");
mkdirSync(join(PKG_ROOT, "assets"), { recursive: true });
mkdirSync(join(PKG_ROOT, "bin"), { recursive: true });
writeFileSync(join(PKG_ROOT, "bin", "enigma.mjs"), "// stand-in launcher\n");

/** Run `body` with the launcher discoverable, the way the real launcher leaves the env. */
function withLauncher<T>(body: () => T): T {
    const previous = process.env.ENIGMA_ASSETS_DIR;
    process.env.ENIGMA_ASSETS_DIR = join(PKG_ROOT, "assets");
    try { return body(); } finally {
        if (previous === undefined) delete process.env.ENIGMA_ASSETS_DIR;
        else process.env.ENIGMA_ASSETS_DIR = previous;
    }
}

test("windows registers the launcher under node, never a cmd /c wrapper", () => {
    for (const tool of ["claude", "opencode", "kimi"]) {
        const inv = withLauncher(() => mcpInvocation(tool, "win32"));
        expect(inv.command, `${tool} still goes through a shell`).not.toBe("cmd");
        expect(inv.args, `${tool} still passes /c`).not.toContain("/c");
        expect(inv.args.at(-1), `${tool} does not start the server`).toBe("mcp");
        expect(inv.args[0], `${tool} does not run the launcher`).toContain("enigma.mjs");
    }
});

test("codex is untouched: it resolves a .cmd itself and never needed the wrapper", () => {
    const inv = withLauncher(() => mcpInvocation("codex", "win32"));

    expect(inv.command).not.toBe("cmd");
    expect(inv.args).toEqual(["mcp"]);
});

test("a launcher that cannot be located falls back rather than writing a dead entry", () => {
    const previous = process.env.ENIGMA_ASSETS_DIR;
    process.env.ENIGMA_ASSETS_DIR = join(HOME, "nonexistent", "assets");
    try {
        const inv = mcpInvocation("claude", "win32");

        // Better one extra process than an entry that cannot start: a silent registration
        // failure costs the user every enigma tool.
        expect(inv.command).toBe("cmd");
        expect(inv.args.at(-1)).toBe("mcp");
    } finally {
        if (previous === undefined) delete process.env.ENIGMA_ASSETS_DIR;
        else process.env.ENIGMA_ASSETS_DIR = previous;
    }
});

test("every platform starts the same server", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
        expect(withLauncher(() => mcpInvocation("claude", platform)).args.at(-1), platform).toBe("mcp");
    }
});
// The Chrome DevTools server lets any agent test the app in a real, isolated Chrome. It rides
// next to the enigma server under its own toggle, launched through enigma's own launcher.
test("the browser server is registered per agent behind its own toggle", () => {
    setEnigmaValue("browser", true, "global");
    const dir = join(HOME, ".enigma", "claude", "browser-acct");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".claude.json"), "{}");
    applyMcpForAccount("claude", dir);
    const entry = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers["chrome-devtools"];
    expect(entry.args.at(-1)).toBe("__browser-mcp");
    setEnigmaValue("browser", false, "global");
    applyMcpForAccount("claude", dir);
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers?.["chrome-devtools"]).toBeUndefined();
    for (const platform of ["win32", "darwin", "linux"] as const) {
        expect(withLauncher(() => browserInvocation("claude", platform)).args.at(-1), platform).toBe("__browser-mcp");
    }
    expect(browserInvocation("codex", "win32").args).toEqual(["__browser-mcp"]);
});

// The entry used to carry the server's own flags, so whoever rewrote it decided whether Chrome
// opened a window on the user's screen. Any older entry, with --headless or without it, is
// replaced by the launcher on the next sync, which reads the setting itself at start.
test("old npx browser entries are upgraded to the launcher", () => {
    setEnigmaValue("browser", true, "global");
    const dir = join(HOME, ".enigma", "claude", "headless-acct");
    mkdirSync(dir, { recursive: true });
    const old = { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@1.10.1", "--isolated", "--no-usage-statistics", "--no-performance-crux"] };
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { "chrome-devtools": old } }));
    expect(applyMcpForAccount("claude", dir)).toBe(true);
    const read = (): string[] => JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers["chrome-devtools"].args;
    expect(read().at(-1)).toBe("__browser-mcp");
    expect(read().join(" ")).not.toContain("chrome-devtools-mcp");
    expect(applyMcpForAccount("claude", dir)).toBe(false);
});

// A project's .mcp.json wins over the global entry. One written before the launcher existed
// started Chrome itself (cmd /c npx ...), which nothing ever closed; the sync repoints it.
test("stale browser entries in known projects are repointed at the launcher, nothing else is touched", () => {
    setEnigmaValue("browser", true, "global");
    const project = join(HOME, "work", "stale-project");
    const other = join(HOME, "work", "upstream-repo");
    mkdirSync(join(project, ".kimi-code"), { recursive: true });
    mkdirSync(other, { recursive: true });
    const stale = { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "chrome-devtools-mcp@1.10.1", "--isolated", "--headless"] };
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { enigma: { command: "x" }, "chrome-devtools": stale } }));
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ mcp: { "chrome-devtools": { type: "local", command: ["npx", "-y", "chrome-devtools-mcp@1.10.1"], enabled: true } } }));
    writeFileSync(join(project, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp@1.10.1"] } } }));
    // An upstream project's own browser server under another name is theirs, not enigma's.
    const upstream = JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest", "--headless"] } } });
    writeFileSync(join(other, ".mcp.json"), upstream);
    const config = join(HOME, "projects-claude.json");
    writeFileSync(config, JSON.stringify({ projects: { [project]: {}, [other]: {}, [join(HOME, "gone")]: {} } }));
    const fixed = repairProjectBrowserEntries([config, join(HOME, "missing.json")]);
    expect(fixed.sort()).toEqual([join(project, ".kimi-code", "mcp.json"), join(project, ".mcp.json"), join(project, "opencode.json")].sort());
    const claude = readJson(join(project, ".mcp.json")).mcpServers;
    expect(claude.enigma).toEqual({ command: "x" });
    expect(claude["chrome-devtools"].args.at(-1)).toBe("__browser-mcp");
    expect(readJson(join(project, "opencode.json")).mcp["chrome-devtools"].command.at(-1)).toBe("__browser-mcp");
    expect(readJson(join(project, ".kimi-code", "mcp.json")).mcpServers["chrome-devtools"].args.at(-1)).toBe("__browser-mcp");
    expect(readFileSync(join(other, ".mcp.json"), "utf8")).toBe(upstream);
    expect(repairProjectBrowserEntries([config])).toEqual([]);
    expect(isStaleBrowserEntry(undefined)).toBe(false);
});

// With two managed tables, re-appending each in turn moved one behind the other on every sync.
test("codex config with two managed servers reaches a fixed point", () => {
    setEnigmaValue("compress", true, "global");
    setEnigmaValue("browser", true, "global");
    const dir = join(HOME, ".enigma", "codex", "two-servers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.toml"), "model = 'x'\n");
    applyMcpForAccount("codex", dir);
    const first = readFileSync(join(dir, "config.toml"), "utf8");
    expect(first).toContain("[mcp_servers.enigma]");
    expect(first).toContain("[mcp_servers.chrome-devtools]");
    expect(applyMcpForAccount("codex", dir)).toBe(false);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(first);
});

test("hasContextServer reports only an entry that was actually written", () => {
    const server = { command: "node", args: ["engine.mjs"] };
    for (const tool of ["claude", "codex", "opencode", "kimi"]) {
        const dir = join(HOME, `ctx-${tool}`);
        mkdirSync(dir, { recursive: true });
        expect(hasContextServer(tool, dir, "rea")).toBe(false);
        applyContextServer(tool, dir, "rea", server);
        expect(hasContextServer(tool, dir, "rea")).toBe(true);
        applyContextServer(tool, dir, "rea", null);
        expect(hasContextServer(tool, dir, "rea")).toBe(false);
    }
    const broken = join(HOME, "ctx-broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".claude.json"), "{ not json");
    expect(applyContextServer("claude", broken, "rea", server)).toBe(false);
    expect(hasContextServer("claude", broken, "rea")).toBe(false);
});
