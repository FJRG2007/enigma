/**
 * Per-project management for the dashboard: a user registers project folders and
 * the dashboard API server reads/manages each one BY PATH - its deployed skills,
 * its project-local .enigma.json config, git hooks and the AI quality gate -
 * alongside the existing global config.
 *
 * All the data-loading and management logic lives HERE (the dashboard's API server),
 * never as new `enigma` CLI subcommands: reads are direct, path-scoped file access;
 * config + per-skill changes are path-scoped file writes; the two cwd-bound setups
 * (git hooks, gate init/eject) reuse the EXISTING CLI by spawning it with cwd set to
 * the project, so no logic is duplicated or relocated into the CLI for the dashboard.
 *
 * Security: arbitrary-path writes only ever target a project the user explicitly
 * registered (addProject validates the path is a real directory); detail/action calls
 * refuse a path that is not in the registry. The server is already loopback-bound and
 * the routes are origin-guarded (see dashboard.ts).
 */

import type { EnigmaConfigKey } from "./config";
import { ALL_SETTINGS } from "./settings-registry";
import { inspectSkills, readSkillMeta } from "./skills";
import { execFile, execFileSync } from "node:child_process";
import { dirname, join, resolve, basename, isAbsolute } from "node:path";
import { isDir, readJson, resolveBin, enigmaHome } from "./util";
import { localTargetsAt, discoverAgents, isManagedProvider } from "./agents";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { CONFIG_FILE, readConfigAt, readProjectConfig, setEnigmaValueAt, unsetEnigmaValueAt } from "./config";

export interface ProjectEntry { path: string; label: string; description?: string; }

export interface ProjectStatus extends ProjectEntry {
    exists: boolean;
    isGitRepo: boolean;
    skills: number;
    hasLocalConfig: boolean;
    hooks: boolean;
    gate: boolean;
}

export interface ProjectSettingValue {
    key: string;
    label: string;
    hint: string;
    choices?: string[];
    offChoice?: string;
    /** Boolean face (a choice setting is "on" when its value is not the off choice). */
    value: boolean;
    /** Exact value for a choice setting. */
    choice?: string;
    /** True when the project's own .enigma.json sets this key (vs inheriting global/default). */
    overridden: boolean;
}

export interface ProjectAgentInfo { name: string; label: string; installed: boolean; deployed: string[]; }

export interface ProjectDetail extends ProjectStatus {
    agents: ProjectAgentInfo[];
    available: { name: string; description: string | null }[];
    config: ProjectSettingValue[];
}

export interface ActionResult { ok: boolean; error?: string; note?: string; }

// --- registry ------------------------------------------------------------------

/** Project list lives next to accounts.json; enigmaHome honors ENIGMA_CONFIG_HOME for tests. */
function registryPath(): string {
    return join(enigmaHome(), ".enigma", "projects.json");
}

interface Registry { projects: ProjectEntry[]; }

function readRegistry(): Registry {
    const r = readJson<Registry>(registryPath());
    if (!r || !Array.isArray(r.projects)) return { projects: [] };
    return { projects: r.projects.filter((p) => p && typeof p.path === "string").map((p) => ({ path: p.path, label: typeof p.label === "string" ? p.label : basename(p.path), description: typeof p.description === "string" ? p.description : undefined })) };
}

function writeRegistry(reg: Registry): void {
    mkdirSync(dirname(registryPath()), { recursive: true });
    writeFileSync(registryPath(), `${JSON.stringify(reg, null, 2)}\n`);
}

/** Absolute, normalized form used as the registry key. */
function normalize(path: string): string {
    return resolve(path);
}

function isRegistered(path: string): boolean {
    const norm = normalize(path);
    return readRegistry().projects.some((p) => normalize(p.path) === norm);
}

// --- status reads (direct, no CLI) ---------------------------------------------

/** Run `git -C <path> config --get <key>`, returning the value or null (git absent / unset). */
function gitConfig(path: string, key: string): string | null {
    try {
        const out = execFileSync("git", ["-C", path, "config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return out || null;
    } catch { return null; }
}

/** Managed (enigma-provider) skills deployed under the project, keyed by agent name. */
function deployedSkills(projectPath: string): Record<string, string[]> {
    const targets = localTargetsAt(projectPath);
    const out: Record<string, string[]> = {};
    for (const [name, t] of Object.entries(targets)) {
        out[name] = [];
        const dir = t.skills;
        if (!dir || !isDir(dir)) continue;
        for (const e of readdirSync(dir)) {
            const sdir = join(dir, e);
            if (isDir(sdir) && isManagedProvider(readSkillMeta(sdir).provider)) out[name].push(e);
        }
    }
    return out;
}

function hooksInstalled(projectPath: string): boolean {
    // enigma's hook setup writes .githooks/guard.mjs and points core.hooksPath at it.
    return existsSync(join(projectPath, ".githooks", "guard.mjs"));
}

function gateInitialized(projectPath: string): boolean {
    // `enigma gate init` adds a git remote named "gate" pointing at the local bare gate repo.
    return gitConfig(projectPath, "remote.gate.url") !== null;
}

function statusOf(entry: ProjectEntry): ProjectStatus {
    const path = normalize(entry.path);
    const exists = isDir(path);
    const deployed = exists ? deployedSkills(path) : {};
    const skillNames = new Set(Object.values(deployed).flat());
    return {
        path,
        label: entry.label || basename(path),
        description: entry.description,
        exists,
        isGitRepo: exists && existsSync(join(path, ".git")),
        skills: skillNames.size,
        hasLocalConfig: exists && existsSync(join(path, CONFIG_FILE)),
        hooks: exists && hooksInstalled(path),
        gate: exists && gateInitialized(path),
    };
}

export function listProjects(): ProjectStatus[] {
    return readRegistry().projects.map(statusOf);
}

// --- project registry mutations ------------------------------------------------

/** Per-field validation for the create form, mirrored client-side for real-time feedback.
 *  `exceptPath` excludes one project (a rename validating against the others). */
export function checkProject(path: string, name: string, exceptPath?: string): { pathError: string | null; nameError: string | null } {
    const reg = readRegistry().projects;
    const exNorm = exceptPath ? normalize(exceptPath) : null;
    const raw = (path || "").trim();
    const norm = normalize(raw);
    let pathError: string | null = null;
    if (exceptPath === undefined) { // path is fixed when renaming - only validate it on create
        if (!raw) pathError = "Enter a path.";
        else if (!isAbsolute(raw)) pathError = "Enter an absolute path (e.g. /home/you/app or C:\\path).";
        else if (!isDir(norm)) pathError = "That folder does not exist.";
        else if (reg.some((p) => normalize(p.path) === norm)) pathError = "This folder is already an enigma project.";
    }
    const nm = (name || "").trim();
    let nameError: string | null = null;
    if (!nm) nameError = "Enter a name.";
    else if (reg.some((p) => normalize(p.path) !== exNorm && p.label.toLowerCase() === nm.toLowerCase())) nameError = "A project with this name already exists.";
    return { pathError, nameError };
}

export function addProject(path: string, name?: string, description?: string): { ok: boolean; error?: string; projects: ProjectStatus[] } {
    const norm = normalize((path || "").trim());
    const nm = (name || "").trim() || basename(norm);
    const { pathError, nameError } = checkProject(path, nm);
    if (pathError || nameError) return { ok: false, error: pathError || nameError || "Invalid input.", projects: listProjects() };
    const reg = readRegistry();
    reg.projects.push({ path: norm, label: nm, description: (description || "").trim() || undefined });
    writeRegistry(reg);
    return { ok: true, projects: listProjects() };
}

/** Rename a project and/or change its description (path is the immutable key). */
export function updateProject(path: string, name?: string, description?: string): { ok: boolean; error?: string; projects: ProjectStatus[] } {
    const norm = normalize(path || "");
    const reg = readRegistry();
    const p = reg.projects.find((x) => normalize(x.path) === norm);
    if (!p) return { ok: false, error: "Project is not registered.", projects: listProjects() };
    if (name !== undefined) {
        const { nameError } = checkProject(path, name, path);
        if (nameError) return { ok: false, error: nameError, projects: listProjects() };
        p.label = name.trim();
    }
    if (description !== undefined) p.description = description.trim() || undefined;
    writeRegistry(reg);
    return { ok: true, projects: listProjects() };
}

export function removeProject(path: string): { projects: ProjectStatus[] } {
    const norm = normalize(path || "");
    const reg = readRegistry();
    const next = reg.projects.filter((p) => normalize(p.path) !== norm);
    if (next.length !== reg.projects.length) writeRegistry({ projects: next });
    return { projects: listProjects() };
}

// --- project-local config (curated, .enigma.json-backed, per-project settings) --

/** The settings that make sense per-project and live in .enigma.json (not agent-native config). */
const PROJECT_SETTING_KEYS = ["gate", "auto-sync", "compress", "output-style", "minimal-code", "parallel-subagents", "skill-update-policy"];

/** kebab CLI key -> camelCase EnigmaConfig field (the registry's documented convention). */
function configField(cliKey: string): EnigmaConfigKey {
    return cliKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as EnigmaConfigKey;
}

function projectConfig(projectPath: string): ProjectSettingValue[] {
    const eff = readConfigAt(projectPath) as unknown as Record<string, unknown>;
    const own = readProjectConfig(projectPath) as unknown as Record<string, unknown>;
    const out: ProjectSettingValue[] = [];
    for (const key of PROJECT_SETTING_KEYS) {
        const s = ALL_SETTINGS.find((x) => x.key === key);
        if (!s) continue;
        const field = configField(key);
        const raw = eff[field];
        const offChoice = s.offChoice ?? "off";
        out.push({
            key,
            label: s.label,
            hint: s.hint,
            choices: s.choices ? [...s.choices] : undefined,
            offChoice: s.choices ? offChoice : undefined,
            value: s.choices ? String(raw) !== offChoice : Boolean(raw),
            choice: s.choices ? String(raw) : undefined,
            overridden: Object.prototype.hasOwnProperty.call(own, field),
        });
    }
    return out;
}

function setProjectConfig(projectPath: string, key: string, value: boolean | string): ActionResult {
    if (!PROJECT_SETTING_KEYS.includes(key)) return { ok: false, error: `Not a project setting: ${key}` };
    const s = ALL_SETTINGS.find((x) => x.key === key);
    const field = configField(key);
    if (typeof value === "string") {
        if (!s?.choices?.includes(value)) return { ok: false, error: `Invalid value for ${key}: ${value}` };
        setEnigmaValueAt(projectPath, field, value);
    } else {
        setEnigmaValueAt(projectPath, field, value);
    }
    return { ok: true };
}

// --- per-project skills (direct deploy/remove of the skill dir) -----------------

function setProjectSkill(projectPath: string, skillName: string, on: boolean): ActionResult {
    const src = inspectSkills().find((s) => s.name === skillName);
    if (!src) return { ok: false, error: `Unknown skill: ${skillName}` };
    const targets = localTargetsAt(projectPath);
    if (on) {
        // Deploy to the agents installed on this machine (mirrors `enigma install --local`).
        const agents = discoverAgents().filter((a) => a.installed && targets[a.name]?.skills);
        if (!agents.length) return { ok: false, error: "No installed agents to deploy into." };
        for (const a of agents) {
            const dir = targets[a.name].skills!;
            mkdirSync(dir, { recursive: true });
            cpSync(src.src, join(dir, skillName), { recursive: true, force: true });
        }
    } else {
        // Remove from every agent dir under the project so the skill is fully gone.
        for (const t of Object.values(targets)) {
            const dest = t.skills && join(t.skills, skillName);
            if (dest && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        }
    }
    return { ok: true };
}

// --- cwd-bound setups: reuse the existing CLI with cwd set to the project --------

/** Spawn the enigma CLI in `cwd` and capture its output. Used only for git-hooks + gate setup. */
function runEnigma(cwd: string, args: string[]): Promise<ActionResult> {
    const bin = resolveBin("enigma") || "enigma";
    const isWin = process.platform === "win32";
    // A Windows launcher may be a .cmd, which execFile cannot spawn without a shell wrapper.
    const cmd = isWin ? "cmd" : bin;
    const cmdArgs = isWin ? ["/c", bin, ...args] : args;
    return new Promise((res) => {
        execFile(cmd, cmdArgs, { cwd, timeout: 180_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            const output = `${stdout || ""}${stderr || ""}`.trim();
            res({ ok: !err, error: err ? (output || err.message) : undefined, note: output || undefined });
        });
    });
}

// --- detail + dispatch ---------------------------------------------------------

export function projectDetail(path: string): ProjectDetail | { error: string } {
    if (!isRegistered(path)) return { error: "Project is not registered." };
    const norm = normalize(path);
    const entry = readRegistry().projects.find((p) => normalize(p.path) === norm);
    const base = statusOf({ path: norm, label: entry?.label || basename(norm), description: entry?.description });
    const deployed = base.exists ? deployedSkills(norm) : {};
    const agents: ProjectAgentInfo[] = discoverAgents()
        .filter((a) => localTargetsAt(norm)[a.name]?.skills)
        .map((a) => ({ name: a.name, label: a.label, installed: a.installed, deployed: deployed[a.name] || [] }));
    const available = inspectSkills().map((s) => ({ name: s.name, description: s.meta.description ?? null }));
    return { ...base, agents, available, config: base.exists ? projectConfig(norm) : [] };
}

export interface ProjectActionPayload {
    op: "skill" | "config-set" | "config-unset" | "hooks" | "gate";
    name?: string;
    on?: boolean;
    key?: string;
    value?: boolean | string;
    gateOp?: "init" | "eject";
}

export async function applyProjectAction(path: string, payload: ProjectActionPayload): Promise<ActionResult & { detail?: ProjectDetail | { error: string } }> {
    if (!isRegistered(path)) return { ok: false, error: "Project is not registered." };
    const norm = normalize(path);
    if (!isDir(norm)) return { ok: false, error: "Project directory no longer exists." };
    let result: ActionResult;
    switch (payload.op) {
        case "skill":
            result = payload.name ? setProjectSkill(norm, payload.name, Boolean(payload.on)) : { ok: false, error: "Missing skill name." };
            break;
        case "config-set":
            result = payload.key !== undefined && payload.value !== undefined
                ? setProjectConfig(norm, payload.key, payload.value)
                : { ok: false, error: "Missing key/value." };
            break;
        case "config-unset":
            if (payload.key && PROJECT_SETTING_KEYS.includes(payload.key)) { unsetEnigmaValueAt(norm, configField(payload.key)); result = { ok: true }; }
            else result = { ok: false, error: "Missing or invalid key." };
            break;
        case "hooks":
            result = await runEnigma(norm, ["security", "-y"]);
            break;
        case "gate":
            result = payload.gateOp === "eject" || payload.gateOp === "init"
                ? await runEnigma(norm, ["gate", payload.gateOp])
                : { ok: false, error: "Invalid gate op." };
            break;
        default:
            result = { ok: false, error: "Unknown action." };
    }
    return { ...result, detail: projectDetail(norm) };
}
