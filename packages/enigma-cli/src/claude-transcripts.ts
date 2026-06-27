/**
 * Shared discovery of Claude Code session transcripts. Both the usage observer (token
 * accounting) and recall (session memory) need to find every *.jsonl transcript across
 * the default config dir and each enigma-managed account, so that logic lives here once
 * rather than in each consumer. Node-builtins only and no enigma imports beyond the
 * accounts registry JSON shape, so it stays a light leaf with no cycles.
 *
 * Only Claude Code is covered today: it stores per-session JSONL under
 * ~/.claude/projects/<project>/*.jsonl. Codex and OpenCode use undocumented/absent local
 * session stores, so a reader is added here only when their format is verified.
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** One Claude account's transcript source: its display name and its projects directory. */
export interface ClaudeSource { account: string; dir: string; }

/**
 * Every Claude account's transcript directory: the default config dir plus each
 * enigma-managed account under ~/.enigma/claude/<name>/projects, so consumers reflect ALL
 * logins, not just the default one. ENIGMA_CLAUDE_PROJECTS overrides the default source
 * (used by tests).
 */
export function claudeProjectsDirs(): ClaudeSource[] {
    const out: ClaudeSource[] = [{ account: "default", dir: process.env.ENIGMA_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects") }];
    const base = join(homedir(), ".enigma", "claude");
    // Account directories are opaque (a UUID since names were decoupled from paths), so map
    // each back to its display name from the registry; fall back to the basename for a legacy
    // name-based dir or one not in the registry.
    const names = managedClaudeNames();
    try {
        for (const e of readdirSync(base, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const dir = join(base, e.name, "projects");
            if (existsSync(dir)) out.push({ account: names[e.name] ?? e.name, dir });
        }
    } catch { /* no managed accounts */ }
    return out;
}

/**
 * Map a managed Claude account's directory basename to its display name, read straight from
 * the accounts registry (not via accounts.ts - this stays light and only depends on the
 * registry's JSON shape, defensively). Absent/unreadable registry yields an empty map.
 */
function managedClaudeNames(): Record<string, string> {
    const map: Record<string, string> = {};
    try {
        const reg = JSON.parse(readFileSync(join(homedir(), ".enigma", "accounts.json"), "utf8")) as {
            tools?: { claude?: { accounts?: { name?: unknown; dir?: unknown }[] } };
        };
        for (const a of reg.tools?.claude?.accounts ?? []) {
            if (typeof a?.name === "string" && typeof a?.dir === "string") map[basename(a.dir)] = a.name;
        }
    } catch { /* no registry */ }
    return map;
}

/** Recursively list every *.jsonl under `dir` (sessions live nested in subagents/ too). */
export function listJsonl(dir: string): string[] {
    const out: string[] = [];
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...listJsonl(p));
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
    return out;
}

/** The project segment a transcript path belongs to (its dir under ~/.claude/projects). */
export function projectOf(path: string, root: string): string {
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    const seg = rel.split(/[\\/]/).filter(Boolean)[0];
    return seg || "unknown";
}
