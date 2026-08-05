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

import { readConfig } from "./config";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { SkillMeta } from "./skills";
import { isManagedProvider } from "./agents";
import { isDir, isNewer, readJson, isOffline, enigmaHome, computeContentSha } from "./util";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

// Baked-in defaults. These are the ONLY origin compiled into the binary; the
// discovery manifest (below) can relocate every one of them WITHOUT an npm
// release, so an already-installed CLI keeps updating after the repo moves.
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_REPO = "FJRG2007/enigma";
const DEFAULT_SKILLS_PREFIX = "packages/enigma-cli/assets/skills/";
const CHECK_THROTTLE_MS = 10 * 60 * 1000; // skip re-checks for repeated runs (success AND failure)
const FETCH_TIMEOUT_MS = 8000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_SKILL = 32;
const MAX_REF_CACHES = 5; // pinned-ref cache trees kept; the default ref's tree is never evicted
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
/**
 * A ref is interpolated into an API URL and into a cache directory name, so the character
 * class is not enough on its own: `.` and `/` are both legal in a ref, which lets `../`
 * through REF_RE and walks the request off the intended endpoint. Every segment must be a
 * real name.
 */
const isSafeRef = (v: unknown): v is string =>
    typeof v === "string" && REF_RE.test(v) && !v.split("/").some((s) => s === "" || s === "." || s === "..");

/**
 * Discovery manifest: a small JSON file in the repo, fetched over raw (no API
 * key, no rate limit) and redirect-following. It is the indirection layer - the
 * skills source (repo/ref/prefix/host) is read from here, not hardcoded, so it
 * can be relocated by editing one static file; GitHub's own rename redirects
 * carry old clients to the new location until they read the updated manifest.
 * Override for development, mirrors, or tests with ENIGMA_SKILLS_MANIFEST_URL.
 */
const DEFAULT_MANIFEST_URL = `${DEFAULT_RAW_BASE}/${DEFAULT_REPO}/main/packages/enigma-cli/assets/skills-manifest.json`;
const manifestUrl = (): string => process.env.ENIGMA_SKILLS_MANIFEST_URL || DEFAULT_MANIFEST_URL;
// enigmaHome() honors ENIGMA_CONFIG_HOME, like the account registry does and for the same
// reason: bun on Linux does not reflect a runtime-reassigned $HOME via os.homedir(), so a raw
// homedir() here ignores a test's temp HOME and reads and writes the developer's real cache.
// It also means a user who points enigma at another home gets the skill cache there too.
const cacheRoot = (): string => join(enigmaHome(), ".enigma", "skills-cache");
/**
 * The pin exactly as the caller gave it, unvalidated and empty when unpinned. The
 * non-throwing half of pinnedRef, for the local reads (cache paths, the stamp, the reported
 * origin) that must keep working - and keep their contract - whatever a shell profile has
 * exported. Validation belongs where the value reaches a request, not on every command.
 */
const rawPin = (ref?: string): string => (ref ?? "").trim() || process.env.ENIGMA_SKILLS_REF || "";
/** The ref a local read is scoped to, without validating it. See rawPin. */
const resolvedRef = (ref?: string): string => rawPin(ref) || "main";
/**
 * The cache is scoped per ref. A pinned run adopts THAT ref's skills even when they are
 * older, so its downloads must not land where a later unpinned run would pick them up as
 * "the newest published skills". The default branch keeps the unsuffixed paths.
 *
 * The suffix must be INJECTIVE, not merely filename-safe: `/` is legal in a ref, so a lossy
 * character replacement maps `release/1.0` and `release-1.0` onto one tree, and under a pin
 * the cache wins outright - the run would adopt the other ref's skills. The readable form is
 * kept for humans and disambiguated by a hash of the raw ref. Deliberately built from the raw
 * pin without validating it: these are local paths, the replacement already removes every
 * separator, and the stamp/cache helpers must not throw (refreshRemoteSkills is documented as
 * never throwing). A pin that is not safe to put in a URL is rejected by pinnedRef, where the
 * request is actually built.
 */
const refDirSuffix = (ref?: string): string => {
    const raw = rawPin(ref);
    if (raw === "") return "";
    const readable = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
    return `@${readable}-${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
};
const cacheSkillsDir = (ref?: string): string => join(cacheRoot(), `skills${refDirSuffix(ref)}`);
const stampFile = (ref?: string): string => join(cacheRoot(), `remote${refDirSuffix(ref)}.json`);
const manifestFile = (): string => join(cacheRoot(), "manifest.json");

/** Resolved skills origin after applying the discovery manifest over the defaults. */
interface SkillSource {
    apiBase: string;
    rawBase: string;
    repo: string;
    skillsPrefix: string;
    ref: string;
}

/**
 * Discovery manifest shape. Every field is optional and validated before use;
 * anything missing or malformed falls back to the baked-in default, so a partial
 * or corrupt manifest can never break updates. Unknown keys (mirrors,
 * minCliVersion, deprecation, ...) are reserved for forward compatibility.
 */
interface SkillsManifest {
    source?: { repo?: string; ref?: string; skillsPrefix?: string; };
    apiBase?: string;
    rawBase?: string;
}

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
    /** The ref that commit came from, so a pinned run is never told a commit from another ref. */
    ref?: string;
    dirs?: Record<string, DirRecord>;
}

export interface RemoteRefreshResult {
    /** False when the check was skipped (toggle off or recently checked). */
    checked: boolean;
    /** Skills whose cache was created/updated by this refresh. */
    updated: string[];
    error: string | null;
    /** The ref the skills were read from, once resolved (`main`, a tag, or a sha). */
    ref?: string;
    /** The commit that ref pointed at - the value to record so a run is reproducible. */
    commit?: string;
}

/** Where the skills actually came from, for the record a caller keeps of a run. */
export interface SkillsOrigin {
    repo: string;
    ref: string;
    /** The commit last fetched at that ref, or null when nothing has been fetched. */
    commit: string | null;
}

/**
 * The resolved skills origin without touching the network: the cached manifest (or the
 * baked-in defaults) plus the commit recorded by the last successful refresh. This is what
 * `install` prints, so a run can record which skills it actually worked with - two runs on
 * the same pinned CLI can otherwise pick up different skills from the default branch.
 *
 * A pure local read, so it reports the pin rather than validating it: an unusable ref is
 * caught where a request is built, and a provenance line must not be the thing that fails.
 */
export function skillsOrigin(ref?: string): SkillsOrigin {
    const base: SkillSource = {
        apiBase: DEFAULT_API_BASE,
        rawBase: DEFAULT_RAW_BASE,
        repo: DEFAULT_REPO,
        skillsPrefix: DEFAULT_SKILLS_PREFIX,
        ref: resolvedRef(ref),
    };
    const manifest = readJson<SkillsManifest>(manifestFile());
    const source = manifest ? applyManifest(base, manifest, ref) : base;
    // Only the commit fetched at THIS ref: reporting the last commit from another ref would
    // make the recorded line wrong for exactly the pinned run it exists to make reproducible.
    const stamp = readJson<RemoteStamp>(stampFile(ref));
    const commit = stamp?.commit && (stamp.ref ?? "main") === source.ref ? stamp.commit : null;
    return { repo: source.repo, ref: source.ref, commit };
}

/**
 * The ref to read skills from: an explicit `--ref` first, then the ENIGMA_SKILLS_REF dev
 * override, then the default branch. Both pins also stop the discovery manifest from
 * relocating the ref, so a pinned run stays pinned.
 *
 * A pin is validated here, before it is interpolated into an API URL or a cache path: in a
 * harness the value can come from CI input, and `../` or `?` would silently redirect the
 * request to another endpoint. Rejecting it loudly beats a confusing 404 - and beats falling
 * back to the default branch, which is the same "asked for and quietly ignored" bug the
 * `--range` handling exists to prevent.
 */
export function pinnedRef(ref?: string): string {
    const explicit = (ref ?? "").trim();
    const [value, origin] = explicit !== "" ? [explicit, "--ref"] : [process.env.ENIGMA_SKILLS_REF || "", "ENIGMA_SKILLS_REF"];
    if (value === "") return "main";
    if (!isSafeRef(value)) throw new Error(`Invalid skills ref in ${origin}: "${value}" (letters, digits and . _ / - only, no path traversal).`);
    return value;
}

/**
 * True when the caller pinned the ref, by flag or by env. A pin is authoritative: it decides
 * which skills are ADOPTED, not only which ref is read, because pinning to an equal or older
 * tag is the ordinary reproducibility case and "fetched nothing" is the wrong answer to it.
 */
export function refIsPinned(ref?: string): boolean {
    return rawPin(ref) !== "";
}

export interface CachedSkill { name: string; src: string; meta: SkillMeta; }

export interface RefreshOptions {
    force: boolean;
    /** Versions shipped inside this package, keyed by skill name (no overlay). */
    bundledVersions: Record<string, string>;
    /** Pin the ref to read skills from (a tag or sha), instead of the default branch. */
    ref?: string;
}

/** True when a refresh would actually hit the network (toggle on + throttle elapsed). */
export function shouldCheckRemote(force: boolean, ref?: string): boolean {
    if (isOffline()) return false;
    if (!readConfig().config.remoteSkills) return false;
    if (force) return true;
    const stamp = readJson<RemoteStamp>(stampFile(ref));
    return !stamp?.checkedAt || Date.now() - stamp.checkedAt >= CHECK_THROTTLE_MS;
}

function writeStamp(stamp: RemoteStamp, ref?: string): void {
    try {
        mkdirSync(cacheRoot(), { recursive: true });
        writeFileSync(stampFile(ref), `${JSON.stringify(stamp, null, 2)}\n`);
    } catch { /* best-effort: a missing stamp only costs an extra check */ }
}

const isHttpsUrl = (u: unknown): u is string => typeof u === "string" && /^https:\/\/[^/\s]+/.test(u);
const stripTrailingSlash = (u: string): string => u.replace(/\/+$/, "");
/** A repo-relative skills prefix: no leading slash, no traversal, normalized to a trailing slash. */
const isSafePrefix = (p: unknown): p is string =>
    typeof p === "string" && /^[A-Za-z0-9._/-]+$/.test(p) && !p.startsWith("/") && !p.split("/").includes("..");

/** Fetch and cache the discovery manifest; null on any failure (caller falls back to cache/defaults). */
async function fetchManifest(): Promise<SkillsManifest | null> {
    try {
        const res = await fetchWithTimeout(manifestUrl()); // fetch follows redirects, so GitHub renames resolve
        if (!res.ok) return null;
        const body = await res.text();
        if (body.length > MAX_FILE_BYTES) return null;
        const m = JSON.parse(body) as unknown;
        if (!m || typeof m !== "object") return null;
        try {
            mkdirSync(cacheRoot(), { recursive: true });
            writeFileSync(manifestFile(), JSON.stringify(m, null, 2) + "\n");
        } catch { /* best-effort: a missing cache only costs a re-fetch */ }
        return m as SkillsManifest;
    } catch { return null; }
}

/** Overlay a validated manifest onto the default source; invalid fields are ignored, a pinned ref always wins. */
function applyManifest(base: SkillSource, m: SkillsManifest, ref?: string): SkillSource {
    const out = { ...base };
    if (isHttpsUrl(m.apiBase)) out.apiBase = stripTrailingSlash(m.apiBase);
    if (isHttpsUrl(m.rawBase)) out.rawBase = stripTrailingSlash(m.rawBase);
    const s = m.source || {};
    if (typeof s.repo === "string" && REPO_SLUG_RE.test(s.repo)) out.repo = s.repo;
    if (isSafePrefix(s.skillsPrefix)) out.skillsPrefix = s.skillsPrefix.endsWith("/") ? s.skillsPrefix : `${s.skillsPrefix}/`;
    if (!refIsPinned(ref) && isSafeRef(s.ref)) out.ref = s.ref;
    return out;
}

/**
 * Resolve the skills origin: fetch the discovery manifest, fall back to the
 * last cached manifest when offline, and to the baked-in defaults when neither
 * is available. An explicit ref (`--ref`) or ENIGMA_SKILLS_REF pins the ref.
 */
async function resolveSource(ref?: string): Promise<SkillSource> {
    const base: SkillSource = {
        apiBase: DEFAULT_API_BASE,
        rawBase: DEFAULT_RAW_BASE,
        repo: DEFAULT_REPO,
        skillsPrefix: DEFAULT_SKILLS_PREFIX,
        ref: pinnedRef(ref),
    };
    const manifest = (await fetchManifest()) || readJson<SkillsManifest>(manifestFile());
    return manifest ? applyManifest(base, manifest, ref) : base;
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
function validCachedSkill(name: string, ref?: string): SkillMeta | null {
    const dir = join(cacheSkillsDir(ref), name);
    if (!existsSync(join(dir, "SKILL.md"))) return null;
    const meta = readJson<SkillMeta>(join(dir, "skill.json"));
    if (!meta || meta.name !== name || !meta.version || !isManagedProvider(meta.provider)) return null;
    try { if (meta.sha !== computeContentSha(dir)) return null; } catch { return null; }
    return meta;
}

/**
 * The verified remote-skill cache for a ref, for overlaying over the bundled assets.
 * Pure local read (no network); empty when the toggle is off or nothing cached.
 *
 * Deliberately NOT gated on `isOffline()`. Offline means "make no request", not "pretend
 * the cache is empty": this same overlay feeds the auto-sync path, so hiding the cache
 * would downgrade and prune skills a previous run already deployed - a destructive local
 * change from a flag that only stands outbound calls down. What the plan took is reported
 * by the caller instead (see adoptedRemoteSkills in skills.ts).
 */
export function cachedRemoteSkills(ref?: string): CachedSkill[] {
    if (!readConfig().config.remoteSkills) return [];
    const root = cacheSkillsDir(ref);
    if (!isDir(root)) return [];
    const out: CachedSkill[] = [];
    for (const name of readdirSync(root)) {
        if (!SKILL_NAME_RE.test(name) || !isDir(join(root, name))) continue;
        const meta = validCachedSkill(name, ref);
        if (meta) out.push({ name, src: join(root, name), meta });
    }
    return out;
}

/** Group the repo tree's blobs into per-skill file lists; oversized/invalid entries poison their skill. */
function groupTreeBySkill(tree: Array<{ path?: string; type?: string; sha?: string; size?: number; }>, skillsPrefix: string): Map<string, RemoteFile[] | null> {
    const skills = new Map<string, RemoteFile[] | null>();
    for (const e of tree) {
        if (e.type !== "blob" || !e.path?.startsWith(skillsPrefix) || !e.sha) continue;
        const rel = e.path.slice(skillsPrefix.length);
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
async function downloadSkill(name: string, commit: string, files: RemoteFile[], source: SkillSource, ref?: string): Promise<boolean> {
    const dest = join(cacheSkillsDir(ref), name);
    const tmp = join(cacheSkillsDir(ref), `.tmp-${name}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    try {
        await Promise.all(files.map(async (f) => {
            const res = await fetchWithTimeout(`${source.rawBase}/${source.repo}/${commit}/${source.skillsPrefix}${name}/${f.rel}`);
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

/**
 * Drop cache entries the bundle has caught up with, or that vanished upstream. Under a pinned
 * ref the version comparison is skipped: that cache holds exactly what the pin asked for, and
 * deleting it for being older than the bundle would undo the adoption it just performed.
 */
function pruneCache(remoteNames: Set<string>, bundledVersions: Record<string, string>, dirs: Record<string, DirRecord>, ref?: string): void {
    for (const name of Object.keys(dirs)) if (!remoteNames.has(name)) delete dirs[name];
    const root = cacheSkillsDir(ref);
    if (!isDir(root)) return;
    const pinned = refIsPinned(ref);
    for (const name of readdirSync(root)) {
        if (name.startsWith(".tmp-")) { rmSync(join(root, name), { recursive: true, force: true }); continue; }
        const meta = validCachedSkill(name, ref);
        const stale = !meta || !remoteNames.has(name) ||
            (!pinned && bundledVersions[name] !== undefined && !isNewer(meta.version!, bundledVersions[name]!));
        if (stale) {
            rmSync(join(root, name), { recursive: true, force: true });
            delete dirs[name];
        }
    }
}

/**
 * Bound the per-ref cache. Every distinct pin gets its own `skills@<ref>/` tree and stamp, so
 * a harness pinning per commit - the reproducibility case the pin exists for - would otherwise
 * accumulate one full skill tree per build, forever. Keep the most recently stamped few
 * (the ref in use always among them) and drop the rest; the default branch's unsuffixed tree
 * is not a candidate, so ordinary unpinned use never re-downloads.
 *
 * Ordering is by stamp mtime alone - one stat per ref, never a walk of the trees - and the
 * whole thing is best-effort like every other cache write: a failed delete must not fail an
 * install.
 */
function pruneRefCaches(keepSuffix: string): void {
    try {
        const root = cacheRoot();
        if (!isDir(root)) return;
        const stampedAt = (suffix: string): number => {
            try { return statSync(join(root, `remote${suffix}.json`)).mtimeMs; } catch { return 0; }
        };
        const others = readdirSync(root)
            .filter((e) => e.startsWith("skills@") && isDir(join(root, e)))
            .map((e) => e.slice("skills".length))
            .filter((s) => s !== keepSuffix)
            .sort((a, b) => stampedAt(b) - stampedAt(a));
        for (const suffix of others.slice(keepSuffix === "" ? MAX_REF_CACHES : MAX_REF_CACHES - 1)) {
            rmSync(join(root, `skills${suffix}`), { recursive: true, force: true });
            rmSync(join(root, `remote${suffix}.json`), { force: true });
        }
    } catch { /* best-effort: an unreclaimed ref tree only costs disk */ }
}

/**
 * Check GitHub for newer sealed skills and refresh the local cache. Never
 * throws: any failure is reported in `error` and the caller keeps working with
 * the bundled/cached skills. Throttled via the stamp unless `force`.
 */
export async function refreshRemoteSkills(opts: RefreshOptions): Promise<RemoteRefreshResult> {
    if (!shouldCheckRemote(opts.force, opts.ref)) return { checked: false, updated: [], error: null, ref: resolvedRef(opts.ref) };
    const pinned = refIsPinned(opts.ref);
    const stamp = readJson<RemoteStamp>(stampFile(opts.ref)) || {};
    const dirs: Record<string, DirRecord> = { ...(stamp.dirs || {}) };
    // Stamp the attempt up front so an unreachable GitHub is also throttled.
    writeStamp({ ...stamp, checkedAt: Date.now() }, opts.ref);
    const fail = (error: string): RemoteRefreshResult => ({ checked: true, updated: [], error, ref: resolvedRef(opts.ref) });
    try {
        // Validated here, inside the try: an unusable pin is reported as a refresh error like
        // any other, so the documented "never throws" contract holds for a bad ENIGMA_SKILLS_REF.
        pinnedRef(opts.ref);
        // Resolve the (relocatable) origin from the discovery manifest, then pin
        // the ref to one commit and list/fetch everything at that commit, so a
        // push mid-refresh can never mix file versions.
        const source = await resolveSource(opts.ref);
        const head = await fetchWithTimeout(`${source.apiBase}/repos/${source.repo}/commits/${source.ref}`);
        if (!head.ok) return fail(`GitHub API ${head.status}`);
        const commit = String(((await head.json()) as { sha?: string; }).sha || "");
        if (!/^[0-9a-f]{7,40}$/.test(commit)) return fail("unexpected GitHub API response");
        const treeRes = await fetchWithTimeout(`${source.apiBase}/repos/${source.repo}/git/trees/${commit}?recursive=1`);
        if (!treeRes.ok) return fail(`GitHub API ${treeRes.status}`);
        const tree = (await treeRes.json()) as { tree?: Array<{ path?: string; type?: string; sha?: string; size?: number; }>; };
        const skills = groupTreeBySkill(tree.tree || [], source.skillsPrefix);
        if (skills.size === 0) return fail("no skills found in the repo tree");

        const updated: string[] = [];
        // Each skill is processed independently (and concurrently): one bad or
        // slow skill never blocks the rest.
        await Promise.all([...skills].map(async ([name, files]) => {
            try {
                if (!files || files.length > MAX_FILES_PER_SKILL) return;
                if (!files.some((f) => f.rel === "skill.json") || !files.some((f) => f.rel === "SKILL.md")) return;
                const sig = dirSignature(files);
                const cached = validCachedSkill(name, opts.ref);
                const newestLocal = [opts.bundledVersions[name], cached?.version]
                    .filter((v): v is string => Boolean(v))
                    .reduce<string | null>((a, b) => (a === null || isNewer(b, a) ? b : a), null);
                const rec = dirs[name];
                if (rec?.sig === sig) {
                    // Unchanged upstream: skip when the cache is intact, or when the
                    // recorded remote version is still not newer than what we have.
                    if (cached) return;
                    if (!pinned && rec.version && newestLocal && !isNewer(rec.version, newestLocal)) return;
                }
                // Version gate before downloading anything heavier than skill.json: adopt only
                // a strictly newer release than what we already have. A pinned ref bypasses it -
                // reproducibility means installing that ref's skills, older ones included.
                const metaRes = await fetchWithTimeout(`${source.rawBase}/${source.repo}/${commit}/${source.skillsPrefix}${name}/skill.json`);
                if (!metaRes.ok) return;
                const remoteMeta = JSON.parse(await metaRes.text()) as SkillMeta;
                if (remoteMeta.name !== name || !remoteMeta.version || !remoteMeta.sha || !isManagedProvider(remoteMeta.provider)) return;
                if (!pinned && newestLocal && !isNewer(remoteMeta.version, newestLocal)) { dirs[name] = { sig, version: remoteMeta.version }; return; }
                if (await downloadSkill(name, commit, files, source, opts.ref)) { dirs[name] = { sig, version: remoteMeta.version }; updated.push(name); }
            } catch { /* this skill stays on its current version */ }
        }));

        pruneCache(new Set(skills.keys()), opts.bundledVersions, dirs, opts.ref);
        writeStamp({ checkedAt: Date.now(), commit, ref: source.ref, dirs }, opts.ref);
        pruneRefCaches(refDirSuffix(opts.ref));
        return { checked: true, updated: updated.sort(), error: null, ref: source.ref, commit };
    } catch (err) {
        const msg = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message || "network error";
        return fail(msg);
    }
}
