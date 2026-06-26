/*
 * autoskills installer: fetch the stack skills detected by autoskills.ts and install them
 * into the project, kept SEPARATE from enigma's policy skills.
 *
 * Content origin is midudev/autoskills' security-reviewed registry (study clone under
 * references/repos/autoskills, MIT): the registry index.json maps each skill name to its
 * files + sha256 + a bundleHash, and the files are fetched from raw.githubusercontent over
 * HTTPS, every file verified against its recorded hash and the whole bundle against the
 * bundleHash before anything is written. Downloads are cached under ~/.enigma/autoskills so
 * a re-run is offline. Installed skills are recorded in <project>/.enigma/autoskills-lock.json
 * (and never carry enigma's provider, so enigma's own skill sync/prune ignores them).
 *
 * Fault-tolerance: a missing registry entry, a failed download or a hash mismatch fails only
 * that one skill and is reported; it never aborts the rest or throws out of installStackSkills.
 */
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { parseSkillRef } from "./autoskills";
import type { SkillEntry } from "./autoskills";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync, statSync } from "node:fs";

const REGISTRY_MAIN = "https://raw.githubusercontent.com/midudev/autoskills/main/packages/autoskills/skills-registry";
const FETCH_TIMEOUT_MS = 15000;

interface RegistryEntry {
    source: string;
    files: string[];
    sha256: Record<string, string>;
    bundleHash: string;
}
interface Registry { version: number; skills: Record<string, RegistryEntry>; }

// Local project agent skill dirs for enigma's agents + the upstream agent folders, so a
// detected agent installs where it actually reads project-local skills.
const AGENT_DIRS: Record<string, string> = {
    "claude": ".claude/skills", "claude-code": ".claude/skills",
    "codex": ".codex/skills", "opencode": ".opencode/skills",
    "cline": ".cline/skills", "junie": ".junie/skills", "codebuddy": ".codebuddy/skills",
    "continue": ".continue/skills", "kiro-cli": ".kiro/skills", "universal": ".agents/skills",
};

function cacheRoot(): string {
    return process.env.ENIGMA_AUTOSKILLS_DIR ?? join(homedir(), ".enigma", "autoskills");
}

function sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
}

async function fetchBuf(url: string): Promise<Buffer | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "enigma-autoskills" } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Fetch the upstream registry index (cached for the day) so we know each skill's files+hashes. */
async function loadRegistry(): Promise<Registry | null> {
    const cached = join(cacheRoot(), "index.json");
    const fresh = (): Registry | null => {
        try {
            const ok = existsSync(cached) && (Date.now() - statSync(cached).mtimeMs < 86400000);
            return ok ? (JSON.parse(readFileSync(cached, "utf-8")) as Registry) : null;
        } catch {
            return null;
        }
    };
    const hit = fresh();
    if (hit) return hit;
    const buf = await fetchBuf(`${REGISTRY_MAIN}/index.json`);
    if (buf) {
        try {
            const reg = JSON.parse(buf.toString("utf-8")) as Registry;
            mkdirSync(cacheRoot(), { recursive: true });
            writeFileSync(cached, buf);
            return reg;
        } catch { /* fall through to any stale cache */ }
    }
    try {
        return existsSync(cached) ? (JSON.parse(readFileSync(cached, "utf-8")) as Registry) : null;
    } catch {
        return null;
    }
}

function copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true })) {
        const s = join(src, e.name), d = join(dest, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else if (e.isFile()) copyFileSync(s, d);
    }
}

/** Download + verify a skill's files into the cache (keyed by bundleHash); returns the dir or null. */
async function fetchSkillToCache(skillName: string, entry: RegistryEntry): Promise<string | null> {
    const skillDir = join(cacheRoot(), "cache", entry.bundleHash, skillName);
    // Already cached and complete -> reuse (offline).
    if (entry.files.every((rel) => existsSync(join(skillDir, ...rel.split(/[\\/]/))))) return skillDir;

    const downloaded: { rel: string; buf: Buffer }[] = [];
    for (const rel of entry.files) {
        const norm = rel.split("\\").join("/");
        if (norm.toLowerCase().endsWith(".zip")) return null; // refuse archives
        const expected = entry.sha256[rel] || entry.sha256[norm];
        if (!expected) return null;
        const url = `${REGISTRY_MAIN}/${[skillName, ...norm.split("/")].map(encodeURIComponent).join("/")}`;
        const buf = await fetchBuf(url);
        if (!buf || sha256(buf) !== expected) return null;
        downloaded.push({ rel: norm, buf });
    }
    const bundle = sha256(Buffer.from(downloaded.map((f) => `${f.rel}:${sha256(f.buf)}`).sort().join("\n")));
    if (bundle !== entry.bundleHash) return null;

    rmSync(skillDir, { recursive: true, force: true });
    for (const { rel, buf } of downloaded) {
        const dest = join(skillDir, ...rel.split("/"));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
    }
    return skillDir;
}

function targetDirs(projectDir: string, agents: string[]): string[] {
    const folders = new Set<string>();
    for (const a of agents) {
        const dir = AGENT_DIRS[a];
        if (dir) folders.add(dir);
    }
    if (folders.size === 0) folders.add(AGENT_DIRS["claude"]); // Claude Code is enigma's primary
    return [...folders].map((rel) => join(projectDir, rel));
}

function recordLock(projectDir: string, skillName: string, entry: RegistryEntry): void {
    const lockPath = join(projectDir, ".enigma", "autoskills-lock.json");
    let lock: { version: number; skills: Record<string, unknown> };
    try {
        lock = JSON.parse(readFileSync(lockPath, "utf-8"));
        if (!lock?.skills) lock = { version: 1, skills: {} };
    } catch {
        lock = { version: 1, skills: {} };
    }
    lock.skills[skillName] = { source: entry.source, bundleHash: entry.bundleHash };
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

export interface InstallSummary {
    installed: number;
    skipped: number;
    failed: number;
    agents: string[];
    errors: string[];
}

export interface InstallOpts {
    yes?: boolean;
    interactive?: boolean;
}

/** Install the given stack skills into the project for the chosen agents. Never throws. */
export async function installStackSkills(
    skills: SkillEntry[],
    projectDir: string,
    agents: string[],
    _opts: InstallOpts = {},
): Promise<InstallSummary> {
    const errors: string[] = [];
    const dirs = targetDirs(projectDir, agents);
    const registry = await loadRegistry();
    if (!registry) {
        return { installed: 0, skipped: 0, failed: skills.length, agents, errors: ["could not reach the skills registry (offline?)"] };
    }

    let installed = 0, skipped = 0, failed = 0;
    for (const { skill } of skills) {
        const { skillName } = parseSkillRef(skill);
        if (!skillName) { skipped++; continue; } // bare URLs are not in the registry
        const entry = registry.skills[skillName];
        if (!entry) { skipped++; continue; } // not in midudev's curated registry yet
        const cached = await fetchSkillToCache(skillName, entry);
        if (!cached) { failed++; errors.push(`${skillName}: download or integrity check failed`); continue; }
        try {
            for (const base of dirs) copyDir(cached, join(base, skillName));
            recordLock(projectDir, skillName, entry);
            installed++;
        } catch (e) {
            failed++;
            errors.push(`${skillName}: ${(e as Error).message}`);
        }
    }
    return { installed, skipped, failed, agents, errors };
}
