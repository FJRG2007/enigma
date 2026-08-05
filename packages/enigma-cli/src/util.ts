/**
 * Shared, side-effect-free helpers. Kept tiny and dependency-free so any module
 * can import them without pulling in heavier concerns.
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";

/** True if `pth` exists and is a directory. */
export function isDir(pth: string): boolean {
    try { return statSync(pth).isDirectory(); } catch { return false; }
}

/**
 * Environment marker stamped into every agent the gate spawns for a pipeline step
 * (see gate/agent/env.ts). Lives here so the hooks can read it without importing
 * the gate. It is a diagnostic signal, never authorization: it can be forged,
 * removed, or inherited, so nothing security-relevant may depend on it.
 */
export const GATE_ROLE_ENV_VAR = "ENIGMA_GATE";

/** True when this process runs inside an agent the gate spawned for a step. */
export function isGateAgentRun(): boolean {
    return process.env[GATE_ROLE_ENV_VAR] === "1";
}

/**
 * The home directory enigma anchors its config and managed agent dirs to.
 * ENIGMA_CONFIG_HOME overrides it - required because bun on Linux does not reflect
 * a runtime-reassigned $HOME via os.homedir(), so tests (and advanced users) cannot
 * rely on resetting $HOME. Both config.ts and agents.ts resolve home through here so
 * the config file and the agent skill/memory/command dirs never disagree.
 */
export function enigmaHome(): string {
    return process.env.ENIGMA_CONFIG_HOME || homedir();
}

/**
 * True when this process must not reach the network. Set by `install --offline` (and
 * `--assets-from`) for the run, or by the environment for a whole container.
 *
 * It is an env var rather than a parameter because the calls it has to stop are
 * DETACHED CHILDREN - the background linter install, the dashboard UI install, the
 * update check, the repo star. A child inherits the variable and stands down on its
 * own; a parameter would have to be threaded to every spawn site and would still miss
 * the second-order ones.
 */
export function isOffline(): boolean {
    return process.env.ENIGMA_OFFLINE === "1";
}

/**
 * Walk up from `start` to find the git repository root, or null. Stat-only (no git
 * spawn), so it is cheap enough for launch-path code. Lives here rather than in
 * security.ts so light modules can reuse it without pulling in that module's prompts.
 */
export function findGitRoot(start: string): string | null {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, ".git"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Parse a JSON file, returning null on any error. Strips a leading UTF-8 BOM
 * (common in Windows-edited files) so a valid-but-BOM-prefixed config is not
 * mistaken for unreadable - callers merge into the parsed object, so a false
 * null would clobber the user's existing settings.
 */
export function readJson<T = Record<string, unknown>>(file: string): T | null {
    try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T; } catch { return null; }
}

/** Executable extensions to try for a bare name: PATHEXT on Windows, none elsewhere. */
function execExtensions(): string[] {
    return sep === "\\"
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
        : [""];
}

/**
 * First existing `bin` (with each executable extension) found under any of `dirs`,
 * or null. Cross-platform, no spawn - the directory-scoped core shared by resolveBin
 * (which searches PATH) and the off-PATH discovery in tool-path.ts.
 */
export function resolveBinIn(bin: string, dirs: string[]): string | null {
    for (const d of dirs) {
        for (const ext of execExtensions()) {
            const candidate = join(d, bin + ext);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * Resolve the full path of an executable named `bin` on the user's PATH, or null
 * if not found (cross-platform, no spawn). On Windows each PATHEXT extension is
 * tried in order so the real file (e.g. `claude.cmd`) is returned, which callers
 * need to spawn it correctly.
 */
export function resolveBin(bin: string): string | null {
    const dirs = (process.env.PATH || process.env.Path || "").split(sep === "\\" ? ";" : ":").filter(Boolean);
    return resolveBinIn(bin, dirs);
}

/** Is an executable named `bin` resolvable on the user's PATH? (cross-platform, no spawn) */
export function isOnPath(bin: string): boolean {
    return resolveBin(bin) !== null;
}

/** Split a version into [major, minor, patch], dropping a leading "v" and any prerelease tag. */
export function parseVersion(version: string): [number, number, number] {
    const core = String(version).trim().replace(/^v/, "").split("-")[0]!;
    const [major, minor, patch] = core.split(".").map((n) => parseInt(n, 10) || 0);
    return [major || 0, minor || 0, patch || 0];
}

/** True when `latest` is a strictly higher release than `current`. */
export function isNewer(latest: string, current: string): boolean {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    for (let i = 0; i < 3; i++) {
        if (a[i]! > b[i]!) return true;
        if (a[i]! < b[i]!) return false;
    }
    return false;
}

/** List file paths under `dir` relative to it, posix-normalized. */
export function listFilesRel(dir: string, base: string = dir): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (isDir(full)) out.push(...listFilesRel(full, base));
        else out.push(relative(base, full).split(sep).join("/"));
    }
    return out;
}

// A SKILL.md may carry an enigma:config block whose value is rendered per-user at deploy
// time from .enigma.json (see skills.ts renderSkill). It is excluded from the content hash so
// a user's config choice never counts as a local edit ("tampered"); everything else still does.
const SKILL_CONFIG_BLOCK = /<!-- enigma:config:start -->[\s\S]*?<!-- enigma:config:end -->/g;

/** Deterministic sha256 over every file in a skill EXCEPT skill.json (which carries it). */
export function computeContentSha(dir: string): string {
    const files = listFilesRel(dir).filter((f) => f !== "skill.json").sort();
    const h = createHash("sha256");
    for (const f of files) {
        h.update(f); h.update("\0");
        // SKILL.md's rendered config block is deploy-time state, not authored content - hash the
        // template (block stripped) so source and rendered deployment hash identically.
        if (f === "SKILL.md") h.update(readFileSync(join(dir, f), "utf8").replace(SKILL_CONFIG_BLOCK, ""));
        else h.update(readFileSync(join(dir, f)));
        h.update("\0");
    }
    return h.digest("hex");
}
