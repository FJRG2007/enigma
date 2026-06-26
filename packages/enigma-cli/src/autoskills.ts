/*
 * autoskills: detect a project's technology stack and pull in the matching agent skills.
 *
 * This is a native, dependency-free port of the detection core of midudev/autoskills
 * (study clone under references/repos/autoskills, MIT). It reads the bundled detection
 * map (assets/autoskills/skills-map.json, generated from the upstream skills-map) and
 * scans a project directory the same way: npm/deno packages, config files, file
 * extensions, Ruby gems, and file-content patterns (incl. Gradle/.NET layouts), across
 * workspaces. The actual skill CONTENT is fetched on demand by autoskills-install.ts -
 * this module only decides WHAT applies. Stack skills are kept separate from enigma's
 * own policy skills (different provider, tracked in the project skills lock).
 */
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = process.env.ENIGMA_ASSETS_DIR ?? join(resolve(__dirname, ".."), "assets");
const MAP_PATH = join(ASSETS, "autoskills", "skills-map.json");

// ── Dataset types (mirror of the bundled JSON) ───────────────

export interface DetectConfigBlock {
    files?: string[];
    patterns: string[];
    scanGradleLayout?: boolean;
    scanDotNetLayout?: boolean;
}

export interface DetectConfig {
    packages?: string[];
    packagePatterns?: string[];
    configFiles?: string[];
    fileExtensions?: string[];
    gems?: string[];
    configFileContent?: DetectConfigBlock | DetectConfigBlock[];
}

export interface Technology {
    id: string;
    name: string;
    detect: DetectConfig;
    skills: string[];
}

export interface ComboSkill {
    id: string;
    name: string;
    requires: string[];
    skills: string[];
}

interface SkillsMap {
    technologies: Technology[];
    combos: ComboSkill[];
    frontendPackages: string[];
    frontendBonusSkills: string[];
    webFrontendExtensions: string[];
    agentFolders: Record<string, string>;
}

let _map: SkillsMap | null = null;
let _patternCache: Map<string, RegExp> | null = null;

/** Load (once) the bundled detection map. Throws a clear error if the asset is missing. */
export function loadSkillsMap(): SkillsMap {
    if (_map) return _map;
    try {
        _map = JSON.parse(readFileSync(MAP_PATH, "utf-8")) as SkillsMap;
    } catch {
        throw new Error(`autoskills dataset not found at ${MAP_PATH}. Reinstall enigma-cli.`);
    }
    _patternCache = new Map();
    return _map;
}

function compilePattern(source: string): RegExp {
    const cache = _patternCache ?? (_patternCache = new Map());
    let re = cache.get(source);
    if (!re) {
        re = new RegExp(source);
        cache.set(source, re);
    }
    return re;
}

// ── Scan constants (from the upstream lib.ts) ────────────────

const SCAN_SKIP_DIRS = new Set([
    "node_modules", ".git", "vendor", ".next", "dist", "build", ".output", ".nuxt",
    ".svelte-kit", "__pycache__", ".cache", "coverage", ".turbo", ".terraform", "var", "bin", "obj", ".vs",
]);

const GRADLE_SCAN_ROOT_FILES = [
    "build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle", "gradle/libs.versions.toml",
];

const DOTNET_SCAN_ROOT_FILES = [
    "global.json", "NuGet.Config", "Directory.Build.props", "Directory.Packages.props",
];

// ── Manifest readers ─────────────────────────────────────────

export function readPackageJson(dir: string): Record<string, unknown> | null {
    try {
        return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
        return null;
    }
}

export function readDenoJson(dir: string): Record<string, unknown> | null {
    for (const name of ["deno.json", "deno.jsonc"]) {
        try {
            return JSON.parse(readFileSync(join(dir, name), "utf-8"));
        } catch {
            continue;
        }
    }
    return null;
}

export function readGemfile(dir: string): string[] {
    const gemfilePath = join(dir, "Gemfile");
    if (!existsSync(gemfilePath)) return [];
    try {
        const content = readFileSync(gemfilePath, "utf-8");
        const gems: string[] = [];
        const gemRegex = /^\s*gem\s+['"]([^'"]+)['"]/gm;
        let match;
        while ((match = gemRegex.exec(content)) !== null) gems.push(match[1]);
        return gems;
    } catch {
        return [];
    }
}

export function getDenoImportNames(denoJson: Record<string, unknown> | null): string[] {
    if (!denoJson?.imports) return [];
    return Object.values(denoJson.imports as Record<string, string>)
        .filter((s) => typeof s === "string" && (s.startsWith("npm:") || s.startsWith("jsr:")))
        .map((specifier) => {
            const bare = specifier.replace(/^(?:npm|jsr):/, "");
            if (bare.startsWith("@")) return bare.replace(/^(@[^/]+\/[^@]+).*$/, "$1");
            return bare.replace(/@.*$/, "");
        });
}

export function getAllPackageNames(pkg: Record<string, unknown> | null): string[] {
    if (!pkg) return [];
    return [
        ...Object.keys((pkg.dependencies as Record<string, string>) || {}),
        ...Object.keys((pkg.devDependencies as Record<string, string>) || {}),
    ];
}

// ── Gradle / .NET layout scanning ────────────────────────────

export function parseSettingsGradleModules(content: string): string[] {
    const modules: string[] = [];
    const includeRe = /include\s*\(?\s*([^)]+)/g;
    let includeMatch;
    while ((includeMatch = includeRe.exec(content)) !== null) {
        const args = includeMatch[1];
        const quotedRe = /['"]([^'"]+)['"]/g;
        let quotedMatch;
        while ((quotedMatch = quotedRe.exec(args)) !== null) {
            modules.push(quotedMatch[1].replace(/^:/, "").replace(/:/g, "/"));
        }
    }
    return modules;
}

function gradleLayoutCandidatePaths(projectDir: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (filePath: string): void => {
        if (!seen.has(filePath)) { candidates.push(filePath); seen.add(filePath); }
    };
    for (const f of GRADLE_SCAN_ROOT_FILES) add(join(projectDir, f));
    let entries: import("node:fs").Dirent[];
    try {
        entries = readdirSync(projectDir, { withFileTypes: true });
    } catch {
        entries = [];
    }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP_DIRS.has(e.name)) continue;
        for (const g of ["build.gradle.kts", "build.gradle"]) add(join(projectDir, e.name, g));
    }
    for (const settingsFile of ["settings.gradle.kts", "settings.gradle"]) {
        let content: string;
        try {
            content = readFileSync(join(projectDir, settingsFile), "utf-8");
        } catch {
            continue;
        }
        for (const modulePath of parseSettingsGradleModules(content)) {
            for (const g of ["build.gradle.kts", "build.gradle"]) add(join(projectDir, modulePath, g));
        }
        break;
    }
    return candidates;
}

function dotNetLayoutCandidatePaths(projectDir: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (filePath: string): void => {
        if (!seen.has(filePath)) { candidates.push(filePath); seen.add(filePath); }
    };
    for (const f of DOTNET_SCAN_ROOT_FILES) add(join(projectDir, f));
    const scan = (dir: string, depth: number): void => {
        if (depth > 2) return;
        let entries: import("node:fs").Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isFile()) {
                const lower = e.name.toLowerCase();
                if (lower.endsWith(".sln") || lower.endsWith(".csproj") || lower.endsWith(".fsproj")) add(join(dir, e.name));
            } else if (e.isDirectory() && !e.name.startsWith(".") && !SCAN_SKIP_DIRS.has(e.name)) {
                scan(join(dir, e.name), depth + 1);
            }
        }
    };
    scan(projectDir, 0);
    return candidates;
}

function resolveConfigContentPaths(projectDir: string, config: DetectConfigBlock): string[] {
    if (config.scanGradleLayout) return gradleLayoutCandidatePaths(projectDir);
    if (config.scanDotNetLayout) return dotNetLayoutCandidatePaths(projectDir);
    return (config.files || []).map((f) => join(projectDir, f));
}

// ── File scanning ────────────────────────────────────────────

function hasFileWithExtension(projectDir: string, extensions: string[], maxDepth = 4): boolean {
    const normalized = extensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase());
    const scan = (dir: string, depth: number): boolean => {
        let entries: import("node:fs").Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return false;
        }
        for (const entry of entries) {
            if (entry.isFile()) {
                const lowerName = entry.name.toLowerCase();
                if (normalized.some((ext) => lowerName.endsWith(ext))) return true;
            } else if (entry.isDirectory() && depth < maxDepth) {
                if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
                if (scan(join(dir, entry.name), depth + 1)) return true;
            }
        }
        return false;
    };
    return scan(projectDir, 0);
}

export function hasWebFrontendFiles(projectDir: string, extensions: Set<string>, maxDepth = 3): boolean {
    const scan = (dir: string, depth: number): boolean => {
        let entries: import("node:fs").Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return false;
        }
        for (const entry of entries) {
            if (entry.isFile()) {
                const name = entry.name;
                if (name.endsWith(".blade.php")) return true;
                const dot = name.lastIndexOf(".");
                if (dot !== -1 && extensions.has(name.slice(dot))) return true;
            } else if (entry.isDirectory() && depth < maxDepth) {
                if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
                if (scan(join(dir, entry.name), depth + 1)) return true;
            }
        }
        return false;
    };
    return scan(projectDir, 0);
}

// ── Workspace resolution ─────────────────────────────────────

function parsePnpmWorkspaceYaml(content: string): string[] {
    const patterns: string[] = [];
    let inPackages = false;
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (line === "packages:" || line === "packages :") { inPackages = true; continue; }
        if (inPackages) {
            if (line.startsWith("- ")) {
                patterns.push(line.slice(2).trim().replace(/^['"]|['"]$/g, ""));
            } else if (line !== "" && !line.startsWith("#")) {
                break;
            }
        }
    }
    return patterns;
}

function expandWorkspacePatterns(projectDir: string, patterns: string[]): string[] {
    const dirs: string[] = [];
    const isWorkspace = (wsDir: string): boolean =>
        existsSync(join(wsDir, "package.json")) || existsSync(join(wsDir, "deno.json")) || existsSync(join(wsDir, "deno.jsonc"));
    for (const pattern of patterns) {
        if (pattern.includes("*")) {
            const parent = join(projectDir, pattern.replace(/\/?\*.*$/, ""));
            let entries: import("node:fs").Dirent[];
            try {
                entries = readdirSync(parent, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
                const wsDir = join(parent, entry.name);
                if (isWorkspace(wsDir)) dirs.push(wsDir);
            }
        } else {
            const wsDir = join(projectDir, pattern);
            if (isWorkspace(wsDir)) dirs.push(wsDir);
        }
    }
    return dirs;
}

interface Manifests {
    pkg: Record<string, unknown> | null;
    denoJson: Record<string, unknown> | null;
}

function resolveWorkspaces(projectDir: string, { pkg, denoJson }: Manifests): string[] {
    const notRoot = (d: string): boolean => resolve(d) !== resolve(projectDir);
    const pnpmPath = join(projectDir, "pnpm-workspace.yaml");
    if (existsSync(pnpmPath)) {
        try {
            const patterns = parsePnpmWorkspaceYaml(readFileSync(pnpmPath, "utf-8"));
            if (patterns.length > 0) return expandWorkspacePatterns(projectDir, patterns).filter(notRoot);
        } catch { /* fall through */ }
    }
    if (pkg) {
        const ws = pkg.workspaces;
        const patterns = Array.isArray(ws)
            ? (ws as string[])
            : Array.isArray((ws as Record<string, unknown>)?.packages)
                ? (ws as Record<string, string[]>).packages
                : null;
        if (patterns && patterns.length > 0) return expandWorkspacePatterns(projectDir, patterns).filter(notRoot);
    }
    if (denoJson?.workspace) {
        const members = Array.isArray(denoJson.workspace) ? (denoJson.workspace as string[]) : [];
        if (members.length > 0) return expandWorkspacePatterns(projectDir, members).filter(notRoot);
    }
    return [];
}

// ── Detection ────────────────────────────────────────────────

interface DirResult {
    detected: Technology[];
    isFrontendByPackages: boolean;
    isFrontendByFiles: boolean;
}

function detectInDir(dir: string, map: SkillsMap, skipFrontendFiles: boolean, preloaded?: Partial<Manifests>): DirResult {
    const pkg = preloaded?.pkg !== undefined ? preloaded.pkg : readPackageJson(dir);
    const allPackages = getAllPackageNames(pkg);
    const deno = preloaded?.denoJson !== undefined ? preloaded.denoJson : readDenoJson(dir);
    const denoImports = getDenoImportNames(deno);
    const allDepsSet = denoImports.length > 0 ? new Set([...allPackages, ...denoImports]) : new Set(allPackages);
    const allDepsArray = denoImports.length > 0 ? [...allDepsSet] : allPackages;
    let gemNames: string[] | undefined;
    const detected: Technology[] = [];
    const fileContentCache = new Map<string, string | null>();
    const existsCache = new Map<string, boolean>();
    const fileExtCache = new Map<string, boolean>();

    const cachedRead = (filePath: string): string | null => {
        if (fileContentCache.has(filePath)) return fileContentCache.get(filePath)!;
        let content: string | null = null;
        try {
            content = readFileSync(filePath, "utf-8");
        } catch { /* missing */ }
        fileContentCache.set(filePath, content);
        if (content !== null) existsCache.set(filePath, true);
        return content;
    };
    const cachedExists = (filePath: string): boolean => {
        if (existsCache.has(filePath)) return existsCache.get(filePath)!;
        const result = existsSync(filePath);
        existsCache.set(filePath, result);
        return result;
    };

    for (const tech of map.technologies) {
        let found = false;
        const d = tech.detect;
        if (d.packages) found = d.packages.some((p) => allDepsSet.has(p));
        if (!found && d.packagePatterns) {
            found = d.packagePatterns.some((src) => { const re = compilePattern(src); return allDepsArray.some((p) => re.test(p)); });
        }
        if (!found && d.configFiles) found = d.configFiles.some((f) => cachedExists(join(dir, f)));
        if (!found && d.fileExtensions) {
            const key = d.fileExtensions.join("\0");
            if (!fileExtCache.has(key)) fileExtCache.set(key, hasFileWithExtension(dir, d.fileExtensions));
            found = fileExtCache.get(key)!;
        }
        if (!found && d.gems) {
            if (gemNames === undefined) gemNames = readGemfile(dir);
            found = d.gems.some((g) => gemNames!.includes(g));
        }
        if (!found && d.configFileContent) {
            const configs = Array.isArray(d.configFileContent) ? d.configFileContent : [d.configFileContent];
            for (const cfg of configs) {
                for (const filePath of resolveConfigContentPaths(dir, cfg)) {
                    const content = cachedRead(filePath);
                    if (content === null) continue;
                    if (cfg.patterns.some((p) => content.includes(p))) { found = true; break; }
                }
                if (found) break;
            }
        }
        if (found) detected.push(tech);
    }

    const frontendPkgs = new Set(map.frontendPackages);
    const isFrontendByPackages = allDepsArray.some((p) => frontendPkgs.has(p));
    const isFrontendByFiles = isFrontendByPackages || skipFrontendFiles ? false : hasWebFrontendFiles(dir, new Set(map.webFrontendExtensions));
    return { detected, isFrontendByPackages, isFrontendByFiles };
}

export interface DetectResult {
    detected: Technology[];
    isFrontend: boolean;
    combos: ComboSkill[];
}

/** Scan a project (and its workspaces) for known technologies and cross-tech combos. */
export function detectTechnologies(projectDir: string): DetectResult {
    const map = loadSkillsMap();
    const pkg = readPackageJson(projectDir);
    const denoJson = readDenoJson(projectDir);
    const root = detectInDir(projectDir, map, false, { pkg, denoJson });
    const seenIds = new Map<string, Technology>(root.detected.map((t) => [t.id, t]));
    let isFrontend = root.isFrontendByPackages || root.isFrontendByFiles;

    for (const wsDir of resolveWorkspaces(projectDir, { pkg, denoJson })) {
        const ws = detectInDir(wsDir, map, isFrontend);
        for (const tech of ws.detected) if (!seenIds.has(tech.id)) seenIds.set(tech.id, tech);
        if (ws.isFrontendByPackages || ws.isFrontendByFiles) isFrontend = true;
    }

    const detected = [...seenIds.values()];
    const ids = new Set(detected.map((t) => t.id));
    const combos = map.combos.filter((combo) => combo.requires.every((id) => ids.has(id)));
    return { detected, isFrontend, combos };
}

// ── Skill collection ─────────────────────────────────────────

export interface SkillEntry {
    skill: string;
    sources: string[];
}

/** Parse an "owner/repo/skill" reference into its name (last segment) and repo. */
export function parseSkillRef(skill: string): { repo: string; skillName: string; full: string } {
    if (skill.startsWith("http")) return { repo: skill, skillName: "", full: skill };
    const parts = skill.split("/");
    return { repo: parts.slice(0, 2).join("/"), skillName: parts.slice(2).join("/"), full: skill };
}

/** Flatten detected technologies, combos and the frontend bonus into a deduped skill list. */
export function collectSkills(result: DetectResult): SkillEntry[] {
    const map = loadSkillsMap();
    const bySkill = new Map<string, SkillEntry>();
    const add = (skill: string, source: string): void => {
        const existing = bySkill.get(skill);
        if (!existing) bySkill.set(skill, { skill, sources: [source] });
        else if (!existing.sources.includes(source)) existing.sources.push(source);
    };
    for (const tech of result.detected) for (const skill of tech.skills) add(skill, tech.name);
    for (const combo of result.combos) for (const skill of combo.skills) add(skill, combo.name);
    if (result.isFrontend) for (const skill of map.frontendBonusSkills) add(skill, "Frontend");
    return [...bySkill.values()];
}

// ── Agent detection ──────────────────────────────────────────

/** Coding agents present on this machine (by their skills folder), for install targeting. */
export function detectAgents(home: string = homedir()): string[] {
    const map = loadSkillsMap();
    const agents = ["universal"];
    for (const [folder, agentName] of Object.entries(map.agentFolders)) {
        if (existsSync(join(home, folder, "skills"))) agents.push(agentName);
    }
    return agents;
}
