/**
 * Supported coding agents and OS-level detection.
 *
 * Skills are shared (a single source under assets/skills) and deployed to every
 * agent. `memoryFile` selects which shared file from assets/memory an agent uses
 * as its instruction/memory file; `detect` drives auto-detection of what is
 * actually installed on this machine.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { isOnPath, enigmaHome } from "./util";
import { execFileSync } from "node:child_process";

const HOME = enigmaHome();

export interface AgentTarget {
    skills: string;
    memory: string;
    /**
     * Directory this agent reads custom slash commands from, when it supports
     * them. Claude: <root>/.claude/commands; opencode: <root>/.opencode/command
     * (and ~/.config/opencode/command); codex: <CODEX_HOME>/prompts (user scope
     * only - codex has no project-local prompt dir, so its local target omits this).
     */
    commands?: string;
}

export interface AgentDef {
    label: string;
    memoryFile: string;
    detect: { bins?: string[]; dirs?: string[]; procs?: string[] };
    targets: { global: AgentTarget; local: AgentTarget };
}

export interface Agent extends AgentDef {
    name: string;
}

export interface DiscoveredAgent extends Agent {
    installed: boolean;
}

/**
 * Pruning safety: an installed skill that no longer exists in the source is
 * removed ONLY if its destination skill.json declares one of our providers, so
 * we never delete skills authored by the user or other providers.
 *
 * MANAGED_PROVIDER is the current canonical value that seal writes; LEGACY_PROVIDERS
 * are older values we still recognize so existing installs keep being managed.
 */
export const MANAGED_PROVIDER = "FJRG2007/enigma";
export const LEGACY_PROVIDERS = ["FJRG2007"];

/** True if a skill.json `provider` is one we own (canonical or legacy). */
export function isManagedProvider(provider: unknown): boolean {
    return provider === MANAGED_PROVIDER || (typeof provider === "string" && LEGACY_PROVIDERS.includes(provider));
}

/**
 * Per-agent project-local (skills/memory/commands) target dirs rooted at `root`.
 * Single source of the local layout, so AGENTS.*.targets.local and the dashboard's
 * by-path project management (which operates on a project that is not process.cwd())
 * never drift. Codex has no project-local prompt dir, so it omits `commands`.
 */
export function localTargetsAt(root: string): Record<string, AgentTarget> {
    return {
        claude: { skills: join(root, ".claude", "skills"), memory: root, commands: join(root, ".claude", "commands") },
        // Codex discovers skills from the shared `.agents/skills` location, not ~/.codex/skills.
        codex: { skills: join(root, ".agents", "skills"), memory: root },
        // opencode's command dir is the singular `command` (accepted by current + older opencode).
        opencode: { skills: join(root, ".opencode", "skills"), memory: root, commands: join(root, ".opencode", "command") },
    };
}

const CWD_LOCAL = localTargetsAt(process.cwd());

export const AGENTS: Record<string, AgentDef> = {
    claude: {
        label: "Claude Code",
        memoryFile: "CLAUDE.md",
        detect: { bins: ["claude"], dirs: [join(HOME, ".claude")] },
        targets: {
            global: { skills: join(HOME, ".claude", "skills"), memory: join(HOME, ".claude"), commands: join(HOME, ".claude", "commands") },
            local: CWD_LOCAL.claude,
        },
    },
    codex: {
        label: "OpenAI Codex",
        memoryFile: "AGENTS.md",
        // Codex reads AGENTS.md from its home (~/.codex) and project root, but
        // discovers skills from the shared `.agents/skills` location, not ~/.codex/skills.
        detect: { bins: ["codex"], dirs: [join(HOME, ".codex")] },
        targets: {
            // Codex custom prompts live only in <CODEX_HOME>/prompts (top-level, user scope).
            global: { skills: join(HOME, ".agents", "skills"), memory: join(HOME, ".codex"), commands: join(HOME, ".codex", "prompts") },
            local: CWD_LOCAL.codex,
        },
    },
    opencode: {
        label: "OpenCode",
        memoryFile: "AGENTS.md",
        // opencode reads AGENTS.md from ~/.config/opencode (global) or the project
        // root (local); skills from ~/.config/opencode/skills and .opencode/skills.
        detect: { bins: ["opencode"], dirs: [join(HOME, ".config", "opencode"), join(HOME, ".opencode")] },
        targets: {
            global: { skills: join(HOME, ".config", "opencode", "skills"), memory: join(HOME, ".config", "opencode"), commands: join(HOME, ".config", "opencode", "command") },
            local: CWD_LOCAL.opencode,
        },
    },
};

/** An agent is "installed" if its CLI is on PATH or one of its config dirs exists. */
export function isInstalled(agent: AgentDef): boolean {
    const det = agent.detect || {};
    return (det.dirs || []).some((d) => existsSync(d)) || (det.bins || []).some((b) => isOnPath(b));
}

/** All supported agents, each tagged with whether it is installed on this OS. */
export function discoverAgents(): DiscoveredAgent[] {
    return Object.keys(AGENTS).map((name) => {
        const agent: Agent = { name, ...AGENTS[name]! };
        return { ...agent, installed: isInstalled(agent) };
    });
}

/**
 * Best-effort, OS-agnostic snapshot of running process names (lowercased).
 * Returns null if it cannot be determined.
 */
function processSnapshot(): string | null {
    try {
        if (process.platform === "win32") {
            return execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" }).toLowerCase();
        }
        return execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" }).toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Which of `agents` appear to be running right now.
 *   { known: false } when the process list is unavailable
 *   { known: true, running: Set<name> } otherwise
 */
export function runningStatus(agents: Agent[]): { known: boolean; running: Set<string> } {
    const snap = processSnapshot();
    if (snap == null) return { known: false, running: new Set() };
    const running = new Set<string>();
    for (const a of agents) {
        const det = a.detect || {};
        const names = det.procs || det.bins || [a.name];
        if (names.some((n) => snap.includes(String(n).toLowerCase()))) running.add(a.name);
    }
    return { known: true, running };
}
