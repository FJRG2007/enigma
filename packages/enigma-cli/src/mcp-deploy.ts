/**
 * Register (or remove) enigma's context-compression MCP server in each managed
 * agent's own config, gated by the `compress` toggle. This is a "mirror settings"
 * deployment, not a verbatim file copy: every agent uses a different config file,
 * format and merge semantics, so each entry is merged into a shared config file -
 * preserving all other keys - and mirrored on presence AND absence (turning the
 * toggle off removes the entry on the next install/sync).
 *
 *   claude    mcpServers.enigma in ~/.claude.json (global) / .mcp.json (project) /
 *             <accountDir>/.claude.json
 *   codex     [mcp_servers.enigma] in ~/.codex/config.toml / <accountDir>/config.toml
 *             (no project-local config - matches enigma's command deployment)
 *   opencode  mcp.enigma in ~/.config/opencode/opencode.json (global) /
 *             ./opencode.json (project) / <accountDir>/xdg-config/opencode/opencode.json
 *   kimi      mcpServers.enigma in ~/.kimi-code/mcp.json (global) /
 *             ./.kimi-code/mcp.json (project) / <accountDir>/mcp.json
 *
 * The MCP server itself is `enigma mcp` (see mcp.ts), so the registered command is the
 * resolved enigma binary; on Windows, where that is an npm `.cmd` shim no shell-less spawn
 * can run, the agents that spawn without a shell (claude, opencode, kimi) are pointed at the
 * launcher under node instead - see mcpInvocation for why that beats the `cmd /c` wrapper.
 */

import { kimiHome } from "./kimi";
import { readConfig } from "./config";
import { dirname, join } from "node:path";
import { readJson, resolveBin, enigmaHome } from "./util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SERVER_NAME = "enigma";

type Scope = "global" | "local";

/**
 * Absolute path of the npm launcher (`bin/enigma.mjs`), or null when it cannot be located.
 *
 * The launcher points ENIGMA_ASSETS_DIR at `<pkgRoot>/assets` for the binary it execs, so the
 * package root - and the launcher sitting beside it - is recoverable from that one variable.
 * Nothing inside the compiled binary knows where its own package lives, its __dirname being a
 * path in Bun's virtual filesystem.
 */
function launcherScript(): string | null {
    const assets = process.env.ENIGMA_ASSETS_DIR;
    if (!assets) return null;
    const script = join(dirname(assets), "bin", "enigma.mjs");
    return existsSync(script) ? script : null;
}

/**
 * The command + args that launch the enigma MCP server, resolved per OS and tool.
 *
 * `platform` is a parameter rather than a read of `process.platform` so the Windows branch -
 * the only one with a decision in it - is reachable from a test on the Linux runner that CI
 * actually uses. Nothing else passes it.
 */
export function mcpInvocation(tool: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; } {
    const base = resolveBin("enigma") ?? "enigma";
    // On Windows `enigma` is an npm `.cmd` shim, which CreateProcess cannot run, so an agent
    // that spawns its servers without a shell (claude, opencode, kimi) needed a `cmd /c`
    // wrapper. Codex resolves `.cmd` via PATHEXT itself and never did.
    //
    // That wrapper costs a second process per session, held open for as long as the agent runs,
    // and - spawned by a parent with no console to inherit - a console window with it. Running
    // the launcher under node removes both: node.exe is a real executable, so it is spawned
    // directly, and it is the same entrypoint `enigma.cmd` would have reached anyway.
    if (platform === "win32" && tool !== "codex") {
        const script = launcherScript();
        const node = resolveBin("node");
        // Either half unresolved (an unusual install, node off PATH) means falling back rather
        // than writing an entry that cannot start: a registration that fails silently costs the
        // user every enigma tool, which is far worse than the extra process.
        if (script && node) return { command: node, args: [script, "mcp"] };
        return { command: "cmd", args: ["/c", base, "mcp"] };
    }
    return { command: base, args: ["mcp"] };
}

/**
 * Config file that holds `tool`'s MCP servers at `scope`, or null if none applies.
 *
 * Through enigmaHome(), never a raw homedir(): bun on Linux does not reflect a runtime-
 * reassigned $HOME through os.homedir(), so these three paths escaped ENIGMA_CONFIG_HOME and
 * resolved to the REAL home. Kimi already went through kimiHome() and was the only one that
 * did, which is why its cases passed on the Linux runner while the others silently wrote
 * nowhere the test could see.
 */
function mcpPath(tool: string, scope: Scope): string | null {
    switch (tool) {
        case "claude":
            return scope === "global" ? join(enigmaHome(), ".claude.json") : join(process.cwd(), ".mcp.json");
        case "codex":
            // Codex has no project-local config dir; only the global/account config.toml.
            return scope === "global" ? join(enigmaHome(), ".codex", "config.toml") : null;
        case "opencode":
            return scope === "global"
                ? join(enigmaHome(), ".config", "opencode", "opencode.json")
                : join(process.cwd(), "opencode.json");
        case "kimi":
            // Through kimiHome(), the single source of truth for Kimi's data root, so every
            // kimi path in the CLI resolves the same way (and honors ENIGMA_CONFIG_HOME).
            return scope === "global"
                ? join(kimiHome(), "mcp.json")
                : join(process.cwd(), ".kimi-code", "mcp.json");
        default:
            return null;
    }
}

/** Config file that holds `tool`'s MCP servers inside a managed account dir. */
function mcpAccountPath(tool: string, dir: string): string | null {
    switch (tool) {
        case "claude": return join(dir, ".claude.json");
        case "codex": return join(dir, "config.toml");
        case "opencode": return join(dir, "xdg-config", "opencode", "opencode.json");
        case "kimi": return join(dir, "mcp.json");
        default: return null;
    }
}

/**
 * Merge or delete one named entry under `parentKey` in a JSON config file,
 * preserving every other key. Never clobbers a file it cannot parse, and never
 * creates a file just to remove an absent entry. Returns whether it changed.
 */
function applyJsonEntry(file: string, parentKey: string, entry: unknown | null): boolean {
    const fileExists = existsSync(file);
    if (!fileExists && entry === null) return false;
    const current = fileExists ? readJson<Record<string, unknown>>(file) : {};
    if (current === null) return false; // unparseable - refuse to overwrite user data
    const before = JSON.stringify(current);
    const parent = { ...(typeof current[parentKey] === "object" && current[parentKey] ? current[parentKey] as Record<string, unknown> : {}) };
    if (entry === null) delete parent[SERVER_NAME];
    else parent[SERVER_NAME] = entry;
    if (Object.keys(parent).length) current[parentKey] = parent;
    else delete current[parentKey];
    if (JSON.stringify(current) === before) return false;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
    return true;
}

/** Drop the `[<header>]` table (and its body) from TOML content. */
function removeTomlTable(content: string, header: string): string {
    const lines = content.split("\n");
    const out: string[] = [];
    let skip = false;
    for (const line of lines) {
        if (/^\s*\[/.test(line)) skip = line.trim() === `[${header}]`;
        if (!skip) out.push(line);
    }
    return out.join("\n");
}

/** TOML single-quoted literal (paths/args never contain a single quote here). */
function tomlLiteral(value: string): string {
    return `'${value.replace(/'/g, "")}'`;
}

/** Merge or delete `[mcp_servers.enigma]` in a codex config.toml. Returns whether it changed. */
function applyCodexEntry(file: string, command: string | null, args: string[]): boolean {
    const fileExists = existsSync(file);
    if (!fileExists && command === null) return false;
    const before = fileExists ? readFileSync(file, "utf8") : "";
    // Rebuild deterministically so the transform is a fixed point: take the config without
    // our table, strip trailing whitespace, then re-append the block with exactly one blank
    // line before it. The previous version toggled that blank line between syncs (removeTomlTable
    // drops the trailing newline inconsistently), so every "Check & update" rewrote the file
    // and reported a phantom change.
    const head = removeTomlTable(before, "mcp_servers.enigma").replace(/\s*$/, "");
    let after: string;
    if (command !== null) {
        const block = `[mcp_servers.enigma]\ncommand = ${tomlLiteral(command)}\nargs = [${args.map(tomlLiteral).join(", ")}]\n`;
        after = head ? `${head}\n\n${block}` : block;
    } else {
        after = head ? `${head}\n` : "";
    }
    if (after === before) return false;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, after);
    return true;
}

/** Write/remove the enigma MCP entry in `file` for `tool`, per `enabled`. */
function writeEntry(tool: string, file: string, enabled: boolean): boolean {
    const inv = mcpInvocation(tool);
    switch (tool) {
        case "claude":
            return applyJsonEntry(file, "mcpServers", enabled ? { type: "stdio", command: inv.command, args: inv.args } : null);
        case "opencode":
            return applyJsonEntry(file, "mcp", enabled ? { type: "local", command: [inv.command, ...inv.args], enabled: true } : null);
        // Kimi infers the stdio transport from the presence of `command`, and rejects
        // fields outside its documented schema - so the entry stays command + args only.
        case "kimi":
            return applyJsonEntry(file, "mcpServers", enabled ? { command: inv.command, args: inv.args } : null);
        case "codex":
            return applyCodexEntry(file, enabled ? inv.command : null, inv.args);
        default:
            return false;
    }
}

/**
 * Whether the enigma MCP server should be registered: when compression, recall OR the code
 * graph is on (all expose tools through the same server - enigma_compress/retrieve/stats,
 * enigma_recall*, enigma_codegraph*). Any one feature is enough for the agent to need the server.
 */
function mcpEnabled(): boolean {
    const cfg = readConfig().config;
    return cfg.compress || cfg.recall || cfg.codeGraph;
}

/**
 * Register or remove the enigma MCP server for `agent` at `scope`, following the MCP
 * toggle (compress or recall). Returns whether the agent's config changed.
 */
export function applyMcpForAgent(agent: string, scope: Scope): boolean {
    const file = mcpPath(agent, scope);
    if (!file) return false;
    return writeEntry(agent, file, mcpEnabled());
}

/** Register or remove the enigma MCP server in a managed account's config dir. */
export function applyMcpForAccount(tool: string, dir: string): boolean {
    const file = mcpAccountPath(tool, dir);
    if (!file) return false;
    return writeEntry(tool, file, mcpEnabled());
}

/** The agents whose own config can host the enigma MCP server. */
const MANAGED_TOOLS = ["claude", "codex", "opencode", "kimi"] as const;

/**
 * Whether `tool` is in use at `scope`, which is what gates creating config for it.
 *
 * For claude, codex and opencode the MCP entry lives in the tool's MAIN config file, so the
 * file existing is the same question. Kimi keeps MCP declarations in a dedicated `mcp.json`
 * that only exists once someone has added a server - absent for every Kimi user who never
 * did - so its data root (`~/.kimi-code`, or the project's `.kimi-code`) is the signal
 * instead. Reading the file itself there would mean the toggle never reached Kimi at all.
 */
function usesTool(tool: string, file: string): boolean {
    return existsSync(tool === "kimi" ? join(file, "..") : file);
}

/**
 * Apply the MCP toggle's side effect immediately across managed agents at `scope` (driven by
 * the compress OR recall setting) - the on/off twin of dashboard's applyDashboardMode - so
 * toggling either setting takes effect without re-running `enigma install`. Mirrors presence
 * and absence, but to avoid creating config for a tool the user does not use, an ENABLE only
 * touches an agent that is actually installed (see `usesTool`); a DISABLE is already a no-op
 * on an absent file. Returns the tools whose config changed.
 */
export function applyMcpToggle(scope: Scope): string[] {
    const enabled = mcpEnabled();
    const changed: string[] = [];
    for (const tool of MANAGED_TOOLS) {
        const file = mcpPath(tool, scope);
        if (!file) continue;
        if (enabled && !usesTool(tool, file)) continue; // never create config for an unused tool
        if (writeEntry(tool, file, enabled)) changed.push(tool);
    }
    return changed;
}
