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
 *
 * The MCP server itself is `enigma mcp` (see mcp.ts), so the registered command is
 * the resolved enigma binary; on Windows the agents that spawn without a shell
 * (claude, opencode) get a `cmd /c` wrapper so a `.cmd` launcher resolves.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readJson, resolveBin } from "./util";
import { readConfig } from "./config";

const SERVER_NAME = "enigma";

type Scope = "global" | "local";

/** The command + args that launch the enigma MCP server, resolved per OS and tool. */
function invocation(tool: string): { command: string; args: string[]; } {
    const base = resolveBin("enigma") ?? "enigma";
    // claude and opencode spawn the server without a shell, so a Windows `.cmd`
    // launcher needs a `cmd /c` wrapper. Codex resolves `.cmd` via PATHEXT itself.
    if (process.platform === "win32" && tool !== "codex") return { command: "cmd", args: ["/c", base, "mcp"] };
    return { command: base, args: ["mcp"] };
}

/** Config file that holds `tool`'s MCP servers at `scope`, or null if none applies. */
function mcpPath(tool: string, scope: Scope): string | null {
    switch (tool) {
        case "claude":
            return scope === "global" ? join(homedir(), ".claude.json") : join(process.cwd(), ".mcp.json");
        case "codex":
            // Codex has no project-local config dir; only the global/account config.toml.
            return scope === "global" ? join(homedir(), ".codex", "config.toml") : null;
        case "opencode":
            return scope === "global"
                ? join(homedir(), ".config", "opencode", "opencode.json")
                : join(process.cwd(), "opencode.json");
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
    writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
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
    const inv = invocation(tool);
    switch (tool) {
        case "claude":
            return applyJsonEntry(file, "mcpServers", enabled ? { type: "stdio", command: inv.command, args: inv.args } : null);
        case "opencode":
            return applyJsonEntry(file, "mcp", enabled ? { type: "local", command: [inv.command, ...inv.args], enabled: true } : null);
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
const MANAGED_TOOLS = ["claude", "codex", "opencode"] as const;

/**
 * Apply the MCP toggle's side effect immediately across managed agents at `scope` (driven by
 * the compress OR recall setting) - the on/off twin of dashboard's applyDashboardMode - so
 * toggling either setting takes effect without re-running `enigma install`. Mirrors presence
 * and absence, but to avoid creating config for a tool the user does not use, an ENABLE only
 * touches an agent whose config file already exists; a DISABLE is already a no-op on an absent
 * file. Returns the tools whose config changed.
 */
export function applyMcpToggle(scope: Scope): string[] {
    const enabled = mcpEnabled();
    const changed: string[] = [];
    for (const tool of MANAGED_TOOLS) {
        const file = mcpPath(tool, scope);
        if (!file) continue;
        if (enabled && !existsSync(file)) continue; // never create config for an unused tool
        if (writeEntry(tool, file, enabled)) changed.push(tool);
    }
    return changed;
}
