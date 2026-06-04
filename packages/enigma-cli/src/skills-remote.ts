/**
 * Remote skill updates: keep installed skills current with the GitHub repo
 * WITHOUT publishing a new npm package. `refreshRemoteSkills` checks the repo's
 * default branch for newer sealed skills and downloads verified updates into
 * ~/.enigma/skills-cache; skills.ts overlays that cache over the bundled assets
 * when planning installs and auto-syncs. Per-directory SHA signatures from the
 * git tree are cached in remote.json, so an unchanged repo costs two small API
 * calls and zero downloads.
 *
 * Fault tolerance is the contract: every network call is timeout-bounded, every
 * failure mode (API down, rate-limited, slow, truncated tree, corrupt payload)
 * degrades to the bundled/cached skills, a failed check is throttled like a
 * successful one, and one broken skill never blocks the others.
 *
 * Security: HTTPS only, hosts and repo pinned; skill names and file paths are
 * validated against traversal; files are size- and count-capped; a download is
 * adopted only when its computed content sha matches its sealed skill.json and
 * the provider is ours. Memory files are deliberately NOT remote-updated - they
 * are coupled to CLI code (renderMemory markers/placeholders), so they stay
 * package-versioned.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isDir, isNewer, readJson, computeContentSha } from "./util";
import { readConfig } from "./config";
import { isManagedProvider } from "./agents";
import type { SkillMeta } from "./skills";

const API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const REPO = "FJRG2007/enigma";
const SKILLS_PREFIX = "packages/enigma-cli/assets/skills/";
const CHECK_THROTTLE_MS = 10 * 60 * 1000; // skip re-checks for repeated runs (success AND failure)
const FETCH_TIMEOUT_MS = 8000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_SKILL = 32;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Branch or commit to track; override is for development/testing only. */
const skillsRef = (): string => process.env.ENIGMA_SKILLS_REF || "main";
const cacheRoot = (): string => join(homedir(), ".enigma", "skills-cache");
const cacheSkillsDir = (): string => join(cacheRoot(), "skills");
const stampFile = (): string => join(cacheRoot(), "remote.json");

/** One file of a remote skill, as listed by the git tree. */
interface RemoteFile { rel: string; sha: string; }

/**
 * Per-skill check record: `sig` is a signature over the tree's (path, blob sha)
 * pairs - the upstream change detector - and `version` is the remote version
 * seen at that signature, so an unchanged-but-not-adopted skill can be re-gated
 * locally (e.g. after a package downgrade) without re-fetching its skill.json.
 */
interface DirRecord { sig: string; version?: string; }

interface RemoteStamp {
    checkedAt?: number;
    commit?: string;
    dirs?: Record<string, DirRecord>;
}

export interface RemoteRefreshResult {
    /** False when the check was skipped (toggle off or recently checked). */
    checked: boolean;
    /** Skills whose cache was created/updated by this refresh. */
    updated: string[];
    error: string | null;
}

export interface CachedSkill { name: string; src: string; meta: SkillMeta; }

export interface RefreshOptions {
    force: boolean;
    /** Versions shipped inside this package, keyed by skill name (no overlay). */
    bundledVersions: Record<string, string>;
}

/** True when a refresh would actually hit the network (toggle on + throttle elapsed). */
export function shouldCheckRemote(force: boolean): boolean {
    if (!readConfig().config.remoteSkills) return false;
    if (force) return true;
    const stamp = readJson<RemoteStamp>(stampFile());
    return !stamp?.checkedAt || Date.now() - stamp.checkedAt >= CHECK_THROTTLE_MS;
}

function writeStamp(stamp: RemoteStamp): void {
    try {
        mkdirSync(cacheRoot(), { recursive: true });
        writeFileSync(stampFile(), JSON.stringify(stamp, null, 2) + "\n");
    } catch { /* best-effort: a missing stamp only costs an extra check */ }
}

/** Every path segment must be a plain filename - rejects traversal and absolute forms. */
function isSafeRelPath(rel: string): boolean {
    const parts = rel.split("/");
    return parts.length > 0 && parts.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..");
}

/** GET with a hard timeout; throws on abort/network errors (caller maps to a result). */
async function fetchWithTimeout(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "enigma-cli-skills-check", accept: "application/vnd.github+json" } });
    } finally {
        clearTimeout(t);
    }
}

/** Order-independent signature of a skill directory's tree listing. */
function dirSignature(files: RemoteFile[]): string {
    const lines = files.map((f) => `${f.rel}\0${f.sha}`).sort().join("\n");
    return createHash("sha256").update(lines).digest("hex");
}

/**
 * Validate a cached skill directory: sealed by us, internally consistent, and
 * named after its folder. Returns its meta, or null when invalid (a corrupt or
 * tampered cache entry is simply ignored - the bundled skill wins).
 */
function validCachedSkill(name: string): SkillMeta | null {
    const dir = join(cacheSkillsDir(), name);
    if (!existsSync(join(dir, "SKILL.md"))) return null;
    const meta = readJson<SkillMeta>(join(dir, "skill.json"));
    if (!meta || meta.name !== name || !meta.version || !isManagedProvider(meta.provider)) return null;
    try { if (meta.sha !== computeContentSha(dir)) return null; } catch { return null; }
    return meta;
}

/**
 * The verified remote-skill cache, for overlaying over the bundled assets.
 * Pure local read (no network); empty when the toggle is off or nothing cached.
 */
export function cachedRemoteSkills(): CachedSkill[] {
    if (!readConfig().config.remoteSkills) return [];
    const root = cacheSkillsDir();
    if (!isDir(root)) return [];
    const out: CachedSkill[] = [];
    for (const name of readdirSync(root)) {
        if (!SKILL_NAME_RE.test(name) || !isDir(join(root, name))) continue;
        const meta = validCachedSkill(name);
        if (meta) out.push({ name, src: join(root, name), meta });
    }
    return out;
}

/** Group the repo tree's blobs into per-skill file lists; oversized/invalid entries poison their skill. */
function groupTreeBySkill(tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>): Map<string, RemoteFile[] | null> {
    const skills = new Map<string, RemoteFile[] | null>();
    for (const e of tree) {
        if (e.type !== "blob" || !e.path?.startsWith(SKILLS_PREFIX) || !e.sha) continue;
        const rel = e.path.slice(SKILLS_PREFIX.length);
        const slash = rel.indexOf("/");
        if (slash <= 0) continue;
        const name = rel.slice(0, slash);
        const fileRel = rel.slice(slash + 1);
        if (!SKILL_NAME_RE.test(name)) continue;
        if (skills.get(name) === null) continue;
        if (!isSafeRelPath(fileRel) || (e.size ?? 0) > MAX_FILE_BYTES) { skills.set(name, null); continue; }
        const files = skills.get(name) ?? [];
        files.push({ rel: fileRel, sha: e.sha });
        skills.set(name, files);
    }
    return skills;
}

/**
 * Download one skill's files at the pinned commit into the cache, verifying the
 * sealed content sha before adopting it. Writes go to a temp dir and swap in
 * atomically, so a partial download can never become the active cache entry.
 * Returns true when the cache entry was replaced.
 */
async function downloadSkill(name: string, commit: string, files: RemoteFile[]): Promise<boolean> {
    const dest = join(cacheSkillsDir(), name);
    const tmp = join(cacheSkillsDir(), `.tmp-${name}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    try {
        await Promise.all(files.map(async (f) => {
            const res = await fetchWithTimeout(`${RAW_BASE}/${REPO}/${commit}/${SKILLS_PREFIX}${name}/${f.rel}`);
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.rel}`);
            const body = Buffer.from(await res.arrayBuffer());
            if (body.byteLength > MAX_FILE_BYTES) throw new Error(`${f.rel} exceeds size limit`);
            mkdirSync(dirname(join(tmp, f.rel)), { recursive: true });
            writeFileSync(join(tmp, f.rel), body);
        }));
        const meta = readJson<SkillMeta>(join(tmp, "skill.json"));
        if (!meta || meta.name !== name || !meta.version || !isManagedProvider(meta.provider)) return false;
        if (meta.sha !== computeContentSha(tmp)) return false; // raced push or corruption - keep the old entry
        rmSync(dest, { recursive: true, force: true });
        renameSync(tmp, dest);
        return true;
    } catch {
        return false;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/** Drop cache entries the bundle has caught up with, or that vanished upstream. */
function pruneCache(remoteNames: Set<string>, bundledVersions: Record<string, string>, dirs: Record<string, DirRecord>): void {
    for (const name of Object.keys(dirs)) if (!remoteNames.has(name)) delete dirs[name];
    const root = cacheSkillsDir();
    if (!isDir(root)) return;
    for (const name of readdirSync(root)) {
        if (name.startsWith(".tmp-")) { rmSync(join(root, name), { recursive: true, force: true }); continue; }
        const meta = validCachedSkill(name);
        const stale = !meta || !remoteNames.has(name) ||
            (bundledVersions[name] !== undefined && !isNewer(meta.version!, bundledVersions[name]!));
        if (stale) {
            rmSync(join(root, name), { recursive: true, force: true });
            delete dirs[name];
        }
    }
}

/**
 * Check GitHub for newer sealed skills and refresh the local cache. Never
 * throws: any failure is reported in `error` and the caller keeps working with
 * the bundled/cached skills. Throttled via the stamp unless `force`.
 */
export async function refreshRemoteSkills(opts: RefreshOptions): Promise<RemoteRefreshResult> {
    if (!shouldCheckRemote(opts.force)) return { checked: false, updated: [], error: null };
    const stamp = readJson<RemoteStamp>(stampFile()) || {};
    const dirs: Record<string, DirRecord> = { ...(stamp.dirs || {}) };
    // Stamp the attempt up front so an unreachable GitHub is also throttled.
    writeStamp({ ...stamp, checkedAt: Date.now() });
    const fail = (error: string): RemoteRefreshResult => ({ checked: true, updated: [], error });
    try {
        // Pin the ref to one commit, then list and fetch everything at that commit,
        // so a push mid-refresh can never mix file versions.
        const head = await fetchWithTimeout(`${API_BASE}/repos/${REPO}/commits/${skillsRef()}`);
        if (!head.ok) return fail(`GitHub API ${head.status}`);
        const commit = String(((await head.json()) as { sha?: string }).sha || "");
        if (!/^[0-9a-f]{7,40}$/.test(commit)) return fail("unexpected GitHub API response");
        const treeRes = await fetchWithTimeout(`${API_BASE}/repos/${REPO}/git/trees/${commit}?recursive=1`);
        if (!treeRes.ok) return fail(`GitHub API ${treeRes.status}`);
        const tree = (await treeRes.json()) as { tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }> };
        const skills = groupTreeBySkill(tree.tree || []);
        if (skills.size === 0) return fail("no skills found in the repo tree");

        const updated: string[] = [];
        // Each skill is processed independently (and concurrently): one bad or
        // slow skill never blocks the rest.
        await Promise.all([...skills].map(async ([name, files]) => {
            try {
                if (!files || files.length > MAX_FILES_PER_SKILL) return;
                if (!files.some((f) => f.rel === "skill.json") || !files.some((f) => f.rel === "SKILL.md")) return;
                const sig = dirSignature(files);
                const cached = validCachedSkill(name);
                const newestLocal = [opts.bundledVersions[name], cached?.version]
                    .filter((v): v is string => Boolean(v))
                    .reduce<string | null>((a, b) => (a === null || isNewer(b, a) ? b : a), null);
                const rec = dirs[name];
                if (rec?.sig === sig) {
                    // Unchanged upstream: skip when the cache is intact, or when the
                    // recorded remote version is still not newer than what we have.
                    if (cached) return;
                    if (rec.version && newestLocal && !isNewer(rec.version, newestLocal)) return;
                }
                // Version gate before downloading anything heavier than skill.json:
                // adopt only a strictly newer release than what we already have.
                const metaRes = await fetchWithTimeout(`${RAW_BASE}/${REPO}/${commit}/${SKILLS_PREFIX}${name}/skill.json`);
                if (!metaRes.ok) return;
                const remoteMeta = JSON.parse(await metaRes.text()) as SkillMeta;
                if (remoteMeta.name !== name || !remoteMeta.version || !remoteMeta.sha || !isManagedProvider(remoteMeta.provider)) return;
                if (newestLocal && !isNewer(remoteMeta.version, newestLocal)) { dirs[name] = { sig, version: remoteMeta.version }; return; }
                if (await downloadSkill(name, commit, files)) { dirs[name] = { sig, version: remoteMeta.version }; updated.push(name); }
            } catch { /* this skill stays on its current version */ }
        }));

        pruneCache(new Set(skills.keys()), opts.bundledVersions, dirs);
        writeStamp({ checkedAt: Date.now(), commit, dirs });
        return { checked: true, updated: updated.sort(), error: null };
    } catch (err) {
        const msg = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message || "network error";
        return fail(msg);
    }
}
