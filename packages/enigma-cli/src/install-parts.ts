/**
 * The parts an `enigma install` writes, named after the config key that governs each one, so a
 * host can leave some of them out with `--skip <part,...>` (Polaris owns its own Stop hook, for
 * example: two Stop hooks each deciding whether the agent may finish loop forever).
 *
 * A skip governs ONE run and writes no config: the durable switch for a feature is still
 * `enigma config <key> off`. Skipping a part leaves whatever an earlier install wrote in place.
 */

export interface InstallPart {
    /** Stable name, equal to the governing `enigma config` key where there is one. */
    name: string;
    /** What the install writes for this part. */
    description: string;
    /** Other spellings accepted for the same part. */
    aliases?: readonly string[];
}

export const INSTALL_PARTS: readonly InstallPart[] = [
    { name: "skills", description: "policy skills deployed into each agent" },
    { name: "memory", description: "the always-on memory file (CLAUDE.md / AGENTS.md)" },
    { name: "commands", description: "slash commands (/gate, /handoff, /improve, /qa)" },
    { name: "gate", description: "the /gate slash command" },
    { name: "output-style", description: "the output-style choice made at install" },
    { name: "minimal-code", description: "the minimal-code choice made at install" },
    { name: "dashboard", description: "the dashboard mode choice made at install" },
    { name: "prompt-secret-guard", description: "the prompt secret guard choice made at install" },
    { name: "statusline", description: "the Claude Code status bar entry" },
    { name: "claude-attribution", description: "turning off Claude Code commit/PR attribution" },
    { name: "claude-survey", description: "turning off the Claude Code feedback survey" },
    { name: "claude-trust", description: "pre-answering Claude Code workspace trust" },
    { name: "kimi-trust", description: "pre-answering Kimi Code workspace trust" },
    { name: "search-guard", description: "refusing a find across the whole disk" },
    { name: "browser-guard", description: "refusing shell commands that open a visible browser" },
    { name: "git-push-guard", description: "the agent and global git pre-push guard", aliases: ["commit-hooks"] },
    { name: "gh-telemetry", description: "turning off GitHub CLI telemetry" },
    { name: "permission-bypass", description: "each agent's approval-prompt bypass", aliases: ["bypass"] },
    { name: "auto-lint", description: "the post-edit linter hook" },
    { name: "guardrails", description: "the post-edit convention rules hook" },
    { name: "trim", description: "the post-edit trailing-blank-line hook" },
    { name: "code-graph", description: "the code graph session hooks and its MCP tools" },
    { name: "ci-watch", description: "the CI failure notifier hooks" },
    { name: "subagent-limit", description: "the subagent budget hook and compact window" },
    { name: "relay", description: "the handoff relay hooks" },
    { name: "verify", description: "the Stop hook that checks completion claims", aliases: ["stop-hook"] },
    { name: "compress", description: "the compress/retrieve MCP tools" },
    { name: "recall", description: "the session-memory MCP tools" },
    { name: "mcp", description: "the enigma MCP server registration as a whole" },
];

export type InstallPartName = string;

/** Every accepted spelling, for error messages and shell completion. */
export function installPartNames(): string[] {
    return INSTALL_PARTS.map((p) => p.name);
}

/**
 * Parse a `--skip` value (comma list, repeatable) into canonical part names. Aliases resolve to
 * their part. Throws, listing every valid name, on an unknown one: a skip that silently matched
 * nothing would install the very part the host asked to keep out.
 */
export function parseSkipParts(values: readonly string[]): Set<InstallPartName> {
    const out = new Set<InstallPartName>();
    for (const raw of values.flatMap((v) => v.split(","))) {
        const name = raw.trim().toLowerCase();
        if (!name) continue;
        const part = INSTALL_PARTS.find((p) => p.name === name || p.aliases?.includes(name));
        if (!part) {
            const valid = INSTALL_PARTS.map((p) => p.aliases?.length ? `${p.name} (${p.aliases.join(", ")})` : p.name).join(", ");
            throw new Error(`Unknown install part '${raw.trim()}'. Valid parts: ${valid}.`);
        }
        out.add(part.name);
    }
    return out;
}

/**
 * Whether the MCP server registration runs, given the skipped parts and which MCP-backed
 * features are on. It is one entry serving every tool, so it is written unless `mcp` itself is
 * skipped or every feature that is on was skipped.
 */
export function mcpRegistrationWanted(skip: ReadonlySet<InstallPartName>, on: { compress: boolean; recall: boolean; codeGraph: boolean; }): boolean {
    if (skip.has("mcp")) return false;
    const wanted = [on.compress && !skip.has("compress"), on.recall && !skip.has("recall"), on.codeGraph && !skip.has("code-graph")];
    const anyOn = on.compress || on.recall || on.codeGraph;
    return !anyOn || wanted.some(Boolean);
}
