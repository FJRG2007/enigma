/**
 * Supported coding agents and OS-level detection.
 *
 * Skills are shared (a single source under assets/skills) and deployed to every
 * agent. `memoryFile` selects which shared file from assets/memory an agent uses
 * as its instruction/memory file; `detect` drives auto-detection of what is
 * actually installed on this machine.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isOnPath } from "./util";

const HOME = homedir();

export interface AgentTarget {
    skills: string;
    memory: string;
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

export const AGENTS: Record<string, AgentDef> = {
    claude: {
        label: "Claude Code",
        memoryFile: "CLAUDE.md",
        detect: { bins: ["claude"], dirs: [join(HOME, ".claude")] },
        targets: {
            global: { skills: join(HOME, ".claude", "skills"), memory: join(HOME, ".claude") },
            local: { skills: join(process.cwd(), ".claude", "skills"), memory: process.cwd() },
        },
    },
    codex: {
        label: "OpenAI Codex",
        memoryFile: "AGENTS.md",
        // Codex reads AGENTS.md from its home (~/.codex) and project root, but
        // discovers skills from the shared `.agents/skills` location, not ~/.codex/skills.
        detect: { bins: ["codex"], dirs: [join(HOME, ".codex")] },
        targets: {
            global: { skills: join(HOME, ".agents", "skills"), memory: join(HOME, ".codex") },
            local: { skills: join(process.cwd(), ".agents", "skills"), memory: process.cwd() },
        },
    },
    opencode: {
        label: "opencode",
        memoryFile: "AGENTS.md",
        // opencode reads AGENTS.md from ~/.config/opencode (global) or the project
        // root (local); skills from ~/.config/opencode/skills and .opencode/skills.
        detect: { bins: ["opencode"], dirs: [join(HOME, ".config", "opencode"), join(HOME, ".opencode")] },
        targets: {
            global: { skills: join(HOME, ".config", "opencode", "skills"), memory: join(HOME, ".config", "opencode") },
            local: { skills: join(process.cwd(), ".opencode", "skills"), memory: process.cwd() },
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
