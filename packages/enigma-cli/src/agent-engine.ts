/**
 * Agent engines: the runtime an agent's MCP server runs on, installed once into the agent's
 * managed dir and started with node directly.
 *
 * An agent's asset bundle names its engine in `assets/engine.json` ({ package, version }), so the
 * bundled skill and the server it describes always ship as one pinned pair. The engine is
 * installed with npm into `<agentRoot>/engine` (version-gated, so a launch never re-installs) and
 * its MCP entry points at `<node> <bin script> mcp` - not `npx <pkg> mcp`, which resolves the
 * package on every agent start, needs a `cmd /c` wrapper (and a console window) on Windows, and
 * runs under whatever node is first on PATH even when the engine refuses it.
 *
 * When the bundle also ships `assets/engine-lock.json` (an npm lockfile for that pin, written by
 * the sync script), the engine is installed with `npm ci` from it, so every transitive package is
 * fixed to the version and integrity hash the bundle was released with.
 *
 * The node is picked against the engine's own `engines.node` range from every runtime this
 * machine has (PATH, nvm, nvm-windows): a developer whose shell defaults to an older Node still
 * gets a server that starts.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readJson, resolveBin } from "./util";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

/** An agent's pinned engine, as declared by its bundle's `assets/engine.json`. */
export interface EngineSpec {
    package: string;
    version: string;
    /** The bundle's npm lockfile for this pin (`assets/engine-lock.json`), when it ships one. */
    lockfile?: string;
}

/** A node executable and its version. */
export interface NodeRuntime {
    path: string;
    version: string;
    /** The node found on PATH, as opposed to a version-manager install. */
    onPath?: boolean;
}

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const HOST_NAME = "enigma-agent-engine-host";

/**
 * Read and validate `<assets>/engine.json`. Both fields reach an npm command line, so anything
 * but a plain package name and an exact x.y.z version is rejected, never passed on. A shipped
 * `engine-lock.json` that does not lock that exact pin makes the whole spec invalid.
 */
export function readEngineSpec(assets: string): EngineSpec | null {
    const raw = readJson<{ package?: unknown; version?: unknown; }>(join(assets, "engine.json"));
    if (!raw || typeof raw.package !== "string" || typeof raw.version !== "string") return null;
    if (!PACKAGE_NAME.test(raw.package) || !EXACT_VERSION.test(raw.version)) return null;
    const spec: EngineSpec = { package: raw.package, version: raw.version };
    const lockfile = join(assets, "engine-lock.json");
    if (!existsSync(lockfile)) return spec;
    return engineLockMatches(lockfile, spec) ? { ...spec, lockfile } : null;
}

interface EngineLock {
    packages?: Record<string, { version?: unknown; integrity?: unknown; dependencies?: Record<string, unknown>; }>;
}

/** Whether a lockfile pins `spec` as the host's only direct dependency, with an integrity hash. */
function engineLockMatches(lockfile: string, spec: EngineSpec): boolean {
    const packages = readJson<EngineLock>(lockfile)?.packages;
    const root = packages?.[""];
    const entry = packages?.[`node_modules/${spec.package}`];
    if (!root || !entry) return false;
    return JSON.stringify(root.dependencies ?? {}) === JSON.stringify({ [spec.package]: spec.version })
        && entry.version === spec.version && typeof entry.integrity === "string";
}

/** The engine's npm host dir inside an agent's managed root. */
export function engineDir(agentRoot: string): string {
    return join(agentRoot, "engine");
}

function enginePackageDir(agentRoot: string, pkg: string): string {
    return join(engineDir(agentRoot), "node_modules", ...pkg.split("/"));
}

interface EnginePackageJson {
    version?: unknown;
    bin?: unknown;
    engines?: { node?: unknown; };
}

/** Installed engine version, or null when absent/unreadable. */
export function installedEngineVersion(agentRoot: string, pkg: string): string | null {
    const v = readJson<EnginePackageJson>(join(enginePackageDir(agentRoot, pkg), "package.json"))?.version;
    return typeof v === "string" ? v : null;
}

/**
 * Install the pinned engine unless that exact version is already there. Returns null on
 * success, or the reason it failed (npm's own error line when it gave one).
 */
export function ensureEngine(agentRoot: string, spec: EngineSpec): string | null {
    if (installedEngineVersion(agentRoot, spec.package) === spec.version) return null;
    const dir = engineDir(agentRoot);
    mkdirSync(dir, { recursive: true });
    // Several sessions can launch the same agent at once; only one may run npm in this dir.
    // The others wait for it and then find the engine installed.
    const lock = join(dir, ".install.lock");
    if (!acquireLock(lock)) {
        return installedEngineVersion(agentRoot, spec.package) === spec.version ? null : "another enigma process is still installing it";
    }
    try {
        if (installedEngineVersion(agentRoot, spec.package) === spec.version) return null;
        return installEngine(agentRoot, dir, spec);
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}

const LOCK_STALE_MS = 15 * 60_000;
const LOCK_WAIT_MS = 10 * 60_000;

/**
 * Take an install lock (an exclusive mkdir). When another process holds it, wait until it is
 * released and return false; a lock older than any install could take is a crashed process's
 * leftover and is taken over.
 */
function acquireLock(lock: string): boolean {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            mkdirSync(lock);
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        let age = 0;
        try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
        if (age > LOCK_STALE_MS) {
            rmSync(lock, { recursive: true, force: true });
            continue;
        }
        while (existsSync(lock) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        return false;
    }
}

function installEngine(agentRoot: string, dir: string, spec: EngineSpec): string | null {
    const manifest = join(dir, "package.json");
    let args: string[];
    if (spec.lockfile) {
        writeFileSync(manifest, `${JSON.stringify({ name: HOST_NAME, private: true, dependencies: { [spec.package]: spec.version } }, null, 2)}\n`);
        copyFileSync(spec.lockfile, join(dir, "package-lock.json"));
        args = ["ci", "--no-audit", "--no-fund"];
    } else {
        if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: HOST_NAME, private: true }, null, 2)}\n`);
        args = ["install", `${spec.package}@${spec.version}`, "--no-audit", "--no-fund", "--save-exact"];
    }
    // `npm` is a .cmd shim on Windows, so it needs the shell; both arguments were validated by
    // readEngineSpec and cannot carry shell syntax.
    const result = spawnSync("npm", args, {
        cwd: dir, shell: true, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 600_000, windowsHide: true,
    });
    if (installedEngineVersion(agentRoot, spec.package) === spec.version) return null;
    const stderr = String(result.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return result.error?.message
        ?? stderr.find((l) => /^npm (error|ERR!)/.test(l))
        ?? (result.status === null ? "npm timed out" : `npm exited with code ${result.status}`);
}

/** Absolute path of the engine's `bin` script named `name`, or null when it is not installed. */
export function engineBin(agentRoot: string, pkg: string, name: string): string | null {
    const root = enginePackageDir(agentRoot, pkg);
    const bin = readJson<EnginePackageJson>(join(root, "package.json"))?.bin;
    const rel = typeof bin === "string" ? bin : (bin && typeof bin === "object" ? (bin as Record<string, unknown>)[name] : undefined);
    if (typeof rel !== "string") return null;
    const script = join(root, rel);
    return existsSync(script) ? script : null;
}

/** The engine's declared `engines.node` range, or null when it declares none. */
export function engineNodeRange(agentRoot: string, pkg: string): string | null {
    const range = readJson<EnginePackageJson>(join(enginePackageDir(agentRoot, pkg), "package.json"))?.engines?.node;
    return typeof range === "string" ? range : null;
}

function parse(version: string): [number, number, number] | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether `version` satisfies an npm `engines` range built from `||` alternatives of
 * space-separated comparators (`^x.y.z`, `~x.y.z`, `>=`, `>`, `<=`, `<`, `=` or a bare version) -
 * the forms engine ranges use. Returns null for a range it cannot read, so the caller can fall
 * back instead of trusting a guess.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
    const v = parse(version);
    if (!v) return null;
    let any = false;
    for (const alternative of range.split("||")) {
        const comparators = alternative.trim().split(/\s+/).filter(Boolean);
        if (!comparators.length) return null;
        let all = true;
        for (const comparator of comparators) {
            const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
            if (!m) return null;
            const op = m[1] ?? "=";
            const target: [number, number, number] = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
            const c = compare(v, target);
            const ok = op === "^" ? c >= 0 && (target[0] > 0 ? v[0] === target[0] : v[0] === 0 && v[1] === target[1])
                : op === "~" ? c >= 0 && v[0] === target[0] && v[1] === target[1]
                : op === ">=" ? c >= 0
                : op === ">" ? c > 0
                : op === "<=" ? c <= 0
                : op === "<" ? c < 0
                : c === 0;
            if (!ok) all = false;
        }
        if (all) any = true;
    }
    return any;
}

/** `node -v` of an executable, or null when it does not run. */
function nodeVersion(path: string): string | null {
    const result = spawnSync(path, ["-v"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const out = String(result.stdout || "").trim();
    return result.status === 0 && parse(out) ? out.replace(/^v/, "") : null;
}

/**
 * Every node runtime on this machine: the one on PATH first, then each version under nvm-windows
 * (NVM_HOME) and nvm (NVM_DIR or ~/.nvm). Version-manager installs are read from their directory
 * names, so only the PATH node is spawned.
 */
export function nodeRuntimes(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeRuntime[] {
    const found: NodeRuntime[] = [];
    const onPath = resolveBin("node");
    const pathVersion = onPath ? nodeVersion(onPath) : null;
    if (onPath && pathVersion) found.push({ path: onPath, version: pathVersion, onPath: true });
    const layouts = platform === "win32"
        ? [{ root: env.NVM_HOME ?? "", node: "node.exe" }]
        : [{ root: join(env.NVM_DIR || join(env.HOME || homedir(), ".nvm"), "versions", "node"), node: join("bin", "node") }];
    for (const layout of layouts) {
        if (!layout.root) continue;
        let names: string[];
        try { names = readdirSync(layout.root).filter((name) => /^v\d+\.\d+\.\d+$/.test(name)); } catch { continue; }
        for (const name of names) {
            const path = join(layout.root, name, layout.node);
            if (existsSync(path) && !found.some((r) => r.path === path)) found.push({ path, version: name.slice(1) });
        }
    }
    return found;
}

let cachedRuntimes: NodeRuntime[] | null = null;

/** This machine's node runtimes, probed once per process. */
function machineRuntimes(): NodeRuntime[] {
    return cachedRuntimes ??= nodeRuntimes();
}

/**
 * The node to run an engine on: the PATH node when it satisfies `range`, else the newest runtime
 * that does. With no readable range the PATH node is used as-is (the newest runtime when none is
 * on PATH). Null when nothing qualifies.
 */
export function pickNode(range: string | null, runtimes: NodeRuntime[] = machineRuntimes()): NodeRuntime | null {
    const pathNode = runtimes.find((r) => r.onPath) ?? null;
    const newest = (list: NodeRuntime[]) => [...list].sort((a, b) => compare(parse(b.version)!, parse(a.version)!))[0] ?? null;
    if (range === null) return pathNode ?? newest(runtimes);
    const fits = runtimes.filter((r) => satisfiesRange(r.version, range) !== false);
    if (pathNode && fits.includes(pathNode)) return pathNode;
    return newest(fits);
}
