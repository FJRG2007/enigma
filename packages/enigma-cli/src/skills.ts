/**
 * Skill management: discovery, integrity (seal/check), and install planning and
 * execution. Skills are authored once under assets/skills and deployed to every
 * selected agent; the matching memory file comes from assets/memory.
 */

import * as conf from "./config";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { getTool } from "./accounts";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ASSETS_DIR } from "./assets-dir";
import { clackReporter } from "./reporter";
import type { Reporter } from "./reporter";
import { maybeOfferGitHooks } from "./security";
import type { AccountTarget } from "./accounts";
import { applyDashboardMode } from "./dashboard";
import { execFileSync } from "node:child_process";
import type { SecurityOptions } from "./security";
import { dirname, join, resolve } from "node:path";
import { applyLintWiring, mirrorLintWiring } from "./lint";
import type { RemoteRefreshResult } from "./skills-remote";
import { setGhTelemetry, starRepoInBackground } from "./github";
import { applyTrimWiring, mirrorTrimWiring } from "./trim-deploy";
import type { Agent, AgentTarget, DiscoveredAgent } from "./agents";
import { applyMcpForAgent, applyMcpForAccount } from "./mcp-deploy";
import { isDir, isNewer, isOffline, readJson, listFilesRel, computeContentSha } from "./util";
import { applyVerifyWiring, isVerifyOn, mirrorVerifyWiring } from "./verify-deploy";
import { applyGuardrailsWiring, mirrorGuardrailsWiring } from "./guardrails-deploy";
import { resolveBypassSelection, applyBypass, mirrorAccountSettings } from "./permissions";
import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { cachedRemoteSkills, pinnedRef, refIsPinned as skillsRefIsPinned, refreshRemoteSkills, shouldCheckRemote, skillsOrigin } from "./skills-remote";
import { AGENTS, MANAGED_PROVIDER, isManagedProvider, discoverAgents, runningStatus, localTargetsAt } from "./agents";
import { disableClaudeAttribution, disableClaudeFeedbackSurvey, enableClaudeStatusline, getClaudeTrust, setClaudeTrust } from "./claude";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
// Assets beside the code when they are on disk (dev/tsx, dist), else the launcher's
// ENIGMA_ASSETS_DIR for the compiled binary - see assets-dir.ts.
let assets = ASSETS_DIR;
let assetsExplicit = false;

/**
 * Point every asset read at another tree (`install --assets-from <dir>`), so a closed
 * runner can install from a pre-staged copy with no network and no dependence on where
 * the package happens to live. The tree must have the same shape as the bundled one:
 * `skills/`, `memory/`, `commands/`. Throws when it does not.
 */
export function useAssetsFrom(dir: string): void {
    const root = resolve(dir);
    if (!isDir(join(root, "skills"))) throw new Error(`No skills directory in ${root} - --assets-from expects a copy of the package's assets/ (skills/, memory/, commands/).`);
    assets = root;
    assetsExplicit = root !== resolve(ASSETS_DIR);
}

/** Where assets are being read from (the bundled tree unless --assets-from moved it). */
export function assetsRoot(): string { return assets; }

const skillsRoot = (): string => join(assets, "skills");
const memoryRoot = (): string => join(assets, "memory");
const commandsRoot = (): string => join(assets, "commands");

export interface SkillMeta {
    name?: string;
    version?: string;
    provider?: string;
    description?: string;
    /**
     * .enigma.json keys this skill consumes as config. At deploy the matching {{key}}
     * placeholders in the skill's enigma:config block are rendered from the current value
     * (see renderSkill), so a config choice adapts the skill itself - loaded only when the
     * skill activates - instead of the always-on memory file.
     */
    config?: string[];
    /** ISO date of the last commit that changed this skill, stamped by seal (the catalog "last edited"). */
    updated?: string;
    cliVersion?: string;
    sha?: string;
}

type StatusKind = "install" | "update" | "identical" | "tampered" | "reinstall";
interface SkillStatus { kind: StatusKind; from: string | null; to: string | null; }

export interface SkillEntry { name: string; src: string; meta: SkillMeta; }
interface PlannedSkill extends SkillEntry { status: SkillStatus; overwrite: boolean; }
interface MemoryEntry { name: string; src: string; }
interface PruneEntry { name: string; dir: string; meta: SkillMeta; }
interface CommandEntry { name: string; src: string; }
type CommandStatusKind = "install" | "identical" | "replace";
interface PlannedCommand extends CommandEntry { status: CommandStatusKind; }
interface PlanItem {
    agent: DiscoveredAgent;
    target: AgentTarget;
    skills: PlannedSkill[];
    memory: MemoryEntry[];
    prune: PruneEntry[];
    commands: PlannedCommand[];
}

/**
 * Hook classes an install may wire into an agent's settings, by the event they run on.
 * A harness that owns its own hooks needs to install skills WITHOUT them: two Stop hooks
 * each deciding whether the agent may finish is a loop neither of them can see.
 */
export const HOOK_CLASSES = ["post-edit", "stop"] as const;
export type HookClass = typeof HOOK_CLASSES[number];

/** Parse a `--hooks` value (`all`, `none`, or a comma list). Throws on an unknown name. */
export function parseHookClasses(value: string): HookClass[] {
    const names = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!names.length || names.includes("none")) return [];
    if (names.includes("all")) return [...HOOK_CLASSES];
    for (const n of names) {
        if (!(HOOK_CLASSES as readonly string[]).includes(n)) {
            throw new Error(`Unknown hook class '${n}'. Use: ${HOOK_CLASSES.join(", ")} | all | none.`);
        }
    }
    return names as HookClass[];
}

export interface InstallOptions extends SecurityOptions {
    scope: "global" | "local" | null;
    agents: string[];
    allAgents: boolean;
    skills: string[];
    skillsOnly: boolean;
    memoryOnly: boolean;
    prune: boolean;
    keepModified: boolean;
    dryRun: boolean;
    bypass: string[] | null;
    noBypass: boolean;
    /** Output-compression level to set before deploying memory (off|lite|full|ultra), or null to leave/ask. */
    outputStyle: string | null;
    /** Minimal-code level to set before deploying memory (off|lite|full|ultra), or null to leave/ask. */
    minimalCode: string | null;
    /** Local savings dashboard mode to set (off|on-demand|always), or null to leave/ask. */
    dashboard: string | null;
    /** Enable the prompt secret guard at install (opt-in, default off); null to leave/ask. */
    promptSecretGuard: boolean | null;
    /**
     * Hook classes this install may wire (`--hooks`, `--no-hooks`); null leaves every hook
     * wiring on, as it has always been. It governs this run only - the durable switch is
     * `enigma config verify|guardrails|trim|lint off`.
     */
    hooks: HookClass[] | null;
    /** Skip the Claude Code statusLine entry for this install (`--no-statusline`). */
    noStatusline: boolean;
    /** Pin the skills ref (`--ref <tag|sha>`), so two runs on one CLI version get one skill set. */
    ref: string | null;
    /** Read skills/memory/commands from this tree instead of the bundled assets. Implies offline. */
    assetsFrom: string | null;
    /** Make the install reach nothing over the network (`--offline`). */
    offline: boolean;
}

/** This CLI package's own version, stamped into skills at seal time. */
function cliVersion(): string {
    return (readJson<{ version?: string; }>(join(PKG_ROOT, "package.json")) || {}).version || "0.0.0";
}

/**
 * Serialize skill metadata with a stable key order and exactly one trailing
 * newline (no blank last line). Keeps sealed files diff-friendly.
 */
function serializeMeta(meta: SkillMeta): string {
    const ordered: Record<string, unknown> = {};
    for (const k of ["name", "version", "provider", "description", "config", "updated", "cliVersion", "sha"] as const) {
        if (meta[k] !== undefined) ordered[k] = meta[k];
    }
    for (const k of Object.keys(meta)) if (!(k in ordered)) ordered[k] = (meta as Record<string, unknown>)[k];
    return JSON.stringify(ordered, null, 2) + "\n";
}

export function readSkillMeta(skillDir: string): SkillMeta {
    return readJson<SkillMeta>(join(skillDir, "skill.json")) || {};
}

/**
 * Decide what should happen to a skill at `destDir`: install / update /
 * identical (skip) / tampered (changed at destination) / reinstall (no hash).
 */
function skillStatus(destDir: string, srcMeta: SkillMeta): SkillStatus {
    if (!existsSync(destDir)) return { kind: "install", from: null, to: srcMeta.version || null };
    const destMeta = readSkillMeta(destDir);
    const from = destMeta.version || null;
    const to = srcMeta.version || null;
    if (from && to && from !== to) return { kind: "update", from, to };
    const recordedSha = destMeta.sha || null;
    if (!recordedSha) return { kind: "reinstall", from, to };
    const actualSha = computeContentSha(destDir);
    if (actualSha !== recordedSha) return { kind: "tampered", from, to };
    return { kind: "identical", from, to };
}

function statusLabel(st: SkillStatus): string {
    switch (st.kind) {
        case "install": return st.to ? `install v${st.to}` : "install";
        case "update": return `update ${st.from} -> ${st.to}`;
        case "identical": return st.to ? `up-to-date v${st.to} (skip)` : "up-to-date (skip)";
        case "tampered": return st.to ? `MODIFIED locally v${st.to}` : "MODIFIED locally";
        default: return st.to ? `reinstall v${st.to}` : "reinstall";
    }
}

/**
 * Remove an optional, marker-delimited block from memory-file content. The block is
 * bounded by `<!-- enigma:<id>:start -->` / `<!-- enigma:<id>:end -->` lines (authored
 * with a blank line on each side); we drop the markers and everything between them,
 * leaving a single blank line so the adjacent sections stay separated.
 */
function stripMarkedBlock(content: string, id: string): string {
    const re = new RegExp(`\\n<!-- enigma:${id}:start -->[\\s\\S]*?<!-- enigma:${id}:end -->\\n`, "g");
    return content.replace(re, "");
}

/**
 * `<!-- enigma:case:KEY=VALUE -->...<!-- enigma:case:end -->`: mutually exclusive alternatives,
 * of which exactly one is deployed. Matches the markers too, so a dropped case leaves nothing.
 */
const CASE_BLOCK = /<!-- enigma:case:([A-Za-z0-9]+)=(\S+) -->\n?([\s\S]*?)<!-- enigma:case:end -->\n?/g;

/**
 * Keep only the case whose VALUE equals the current config value of KEY, dropping the other
 * alternatives and every case marker. Shared by the two deployed surfaces that carry cases:
 * a skill's SKILL.md (per-skill config) and a memory file (the output-style level).
 */
function applyCaseBlocks(content: string, cfg: Record<string, unknown>): string {
    return content.replace(CASE_BLOCK, (_m, key: string, val: string, body: string) => (String(cfg[key]) === val ? body : ""));
}

/**
 * Read a source memory file and apply the user's .enigma.json toggles to it:
 * - parallelSubagents off -> strip the parallel sub-agent block (decomposition stays).
 * - outputStyle off -> strip the token-efficient output block; otherwise keep it, bind
 *   {{output-level}} to the chosen level (lite/full/ultra) and let applyCaseBlocks leave only
 *   that level's rules, so the deployed file never spends context describing the other two.
 * - recall off -> strip the "use session memory" block; kept when on so the agent is told
 *   to query the enigma_recall MCP tools.
 * - gate off -> strip the "AI quality gate (automatic)" block; kept when on so the agent
 *   auto-drives the gate after finishing work, without being asked or running setup.
 * Everything else is passed through verbatim, preserving the exact trailing newline.
 */
function renderMemory(srcFile: string): string {
    const cfg = conf.readConfig().config;
    let out = readFileSync(srcFile, "utf8");
    if (!cfg.parallelSubagents) out = stripMarkedBlock(out, "parallel-subagents");
    if (cfg.outputStyle === "off") out = stripMarkedBlock(out, "output-style");
    else out = out.replace(/\{\{output-level\}\}/g, cfg.outputStyle);
    if (!cfg.recall) out = stripMarkedBlock(out, "recall");
    if (!cfg.gate) out = stripMarkedBlock(out, "gate");
    return applyCaseBlocks(out, cfg as unknown as Record<string, unknown>);
}

/** Compare the toggle-rendered source against the deployed file, not the raw bytes. */
function memoryStatus(srcFile: string, destFile: string): "install" | "identical" | "overwrite" {
    if (!existsSync(destFile)) return "install";
    return readFileSync(destFile, "utf8") === renderMemory(srcFile) ? "identical" : "overwrite";
}

/**
 * Render a skill's SKILL.md for deployment so the deployed copy describes ONLY the user's
 * active option, not every possible one:
 *  - `<!-- enigma:case:KEY=VALUE -->...<!-- enigma:case:end -->` blocks: keep the one whose
 *    VALUE equals the current .enigma.json value of KEY, drop the rest (and all case markers).
 *  - `{{KEY}}` placeholders: bind to the current value.
 * A config choice thus adapts the skill itself (in context only when the skill activates)
 * instead of the always-on memory. Case blocks MUST live inside the skill's enigma:config
 * block, which util.computeContentSha strips before hashing, so the rendered value never reads
 * as a local edit. Skills with no config are returned verbatim.
 */
function renderSkill(srcSkillMd: string, keys: string[] | undefined): string {
    let out = readFileSync(srcSkillMd, "utf8");
    if (!keys?.length) return out;
    const cfg = conf.readConfig().config as unknown as Record<string, unknown>;
    out = applyCaseBlocks(out, cfg);
    for (const k of keys) out = out.split(`{{${k}}}`).join(String(cfg[k]));
    return out;
}

/** Copy a skill to `destDir`, then render its SKILL.md config placeholders if it declares any. */
function deploySkill(src: string, destDir: string, meta: SkillMeta): void {
    cpSync(src, destDir, { recursive: true, force: true });
    if (meta.config?.length) writeFileSync(join(destDir, "SKILL.md"), renderSkill(join(src, "SKILL.md"), meta.config));
}

/**
 * True when a config-declaring skill's deployed SKILL.md no longer matches its rendered value
 * (the config was changed since deploy). skillStatus reports such a skill as "identical" because
 * the config block is excluded from the hash, so this drift check drives the in-place re-render.
 */
function skillConfigDrifted(sk: SkillEntry, destDir: string): boolean {
    if (!sk.meta.config?.length) return false;
    const md = join(destDir, "SKILL.md");
    return existsSync(md) && readFileSync(md, "utf8") !== renderSkill(join(sk.src, "SKILL.md"), sk.meta.config);
}

// --- sync state ------------------------------------------------------------
// ~/.enigma/state.json records the sha256 of every memory file enigma writes,
// keyed by absolute destination path. A CLAUDE.md/AGENTS.md existing is NOT
// proof enigma wrote it (users have their own), so auto-sync uses this record
// to distinguish "stale because the package updated" (safe to rewrite) from
// "user-authored or user-edited" (never touched silently).

const STATE_FILE = join(homedir(), ".enigma", "state.json");
// `memory` records the sha enigma last wrote to a dest (managed render); `memoryEdited`
// records the sha of a user's deliberate dashboard edit. A managed write clears the edit
// marker (the edit was superseded); the overwrite/keep policy below reads the marker to
// distinguish a deliberate edit (apply skillUpdatePolicy) from package-stale managed content.
interface SyncState { memory?: Record<string, string>; memoryEdited?: Record<string, string>; }

const contentHash = (content: string): string => createHash("sha256").update(content).digest("hex");

function readSyncState(): SyncState {
    return readJson<SyncState>(STATE_FILE) || {};
}

function writeSyncState(state: SyncState): void {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function recordMemoryWrite(dest: string, content: string): void {
    const state = readSyncState();
    state.memory = { ...state.memory, [dest]: contentHash(content) };
    if (state.memoryEdited) delete state.memoryEdited[dest]; // a managed write supersedes any edit
    writeSyncState(state);
}

/** Record a deliberate user edit of a deployed memory file (marks it for the keep policy). */
function recordMemoryEdit(dest: string, content: string): void {
    const state = readSyncState();
    const h = contentHash(content);
    state.memory = { ...state.memory, [dest]: h };
    state.memoryEdited = { ...state.memoryEdited, [dest]: h };
    writeSyncState(state);
}

/** True when `dest` is byte-identical to a user edit enigma recorded (vs an unrelated change). */
function isMemoryEdited(dest: string): boolean {
    const recorded = (readSyncState().memoryEdited || {})[dest];
    return Boolean(recorded) && existsSync(dest) && recorded === contentHash(readFileSync(dest, "utf8"));
}

/** True when the file at `dest` is byte-identical to what enigma last wrote there. */
function isEnigmaWritten(dest: string): boolean {
    const recorded = (readSyncState().memory || {})[dest];
    return Boolean(recorded) && existsSync(dest) && recorded === contentHash(readFileSync(dest, "utf8"));
}

/** Write the rendered memory file and record its hash so auto-sync can trust it later. */
function writeMemory(src: string, dest: string): void {
    const content = renderMemory(src);
    writeFileSync(dest, content);
    recordMemoryWrite(dest, content);
}

function computePrune(destSkillsDir: string, sourceNames: string[]): PruneEntry[] {
    if (!isDir(destSkillsDir)) return [];
    return readdirSync(destSkillsDir)
        .filter((e) => isDir(join(destSkillsDir, e)) && existsSync(join(destSkillsDir, e, "SKILL.md")))
        .filter((e) => !sourceNames.includes(e))
        .map((e) => ({ name: e, dir: join(destSkillsDir, e), meta: readSkillMeta(join(destSkillsDir, e)) }))
        .filter((s) => isManagedProvider(s.meta.provider));
}

/** The one bundled command whose deployment is conditional (the `gate` toggle). */
const GATE_COMMAND = "gate.md";

/**
 * Slash commands bundled with this package: every *.md under assets/commands. Each
 * is deployed verbatim to an agent's command dir (Claude commands, opencode command,
 * codex prompts), where the file name (minus .md) becomes the command, e.g.
 * improve.md -> /improve.
 */
function bundledCommands(): CommandEntry[] {
    if (!isDir(commandsRoot())) return [];
    // /gate follows the `gate` toggle, which is ON by default: the command ships to
    // agents unless the user turned the gate off (globally or for this project), in
    // which case it is left out of the set and `applyGateToggle` removes any copy.
    const gateOn = conf.readConfig().config.gate;
    return readdirSync(commandsRoot())
        .filter((e) => e.endsWith(".md") && !isDir(join(commandsRoot(), e)))
        .filter((e) => e !== GATE_COMMAND || gateOn)
        .map((e) => ({ name: e, src: join(commandsRoot(), e) }));
}

/**
 * Decide what should happen to a command at `dest`. Commands are enigma-managed and
 * stateless: install (absent), identical (byte-equal, skip), or replace (present but
 * different - an older enigma copy OR a foreign same-named command; both are
 * overwritten so enigma's command always wins the name, per the conflict policy).
 */
function commandStatus(dest: string, src: string): CommandStatusKind {
    if (!existsSync(dest)) return "install";
    return readFileSync(dest, "utf8") === readFileSync(src, "utf8") ? "identical" : "replace";
}

/** Skills bundled with this package: every folder with a SKILL.md under assets/skills. */
function bundledSkills(): SkillEntry[] {
    if (!isDir(skillsRoot())) return [];
    return readdirSync(skillsRoot())
        .filter((e) => isDir(join(skillsRoot(), e)) && existsSync(join(skillsRoot(), e, "SKILL.md")))
        .map((e) => ({ name: e, src: join(skillsRoot(), e), meta: readSkillMeta(join(skillsRoot(), e)) }));
}

/**
 * The effective skill set used for installs and syncs: the bundled assets,
 * overlaid with any verified GitHub-cached skill that is strictly newer (see
 * skills-remote.ts). The overlay also surfaces skills published to the repo
 * that this package version does not bundle yet.
 *
 * Two things suppress the overlay entirely, because in both the cache would make the run
 * report a source it is not installing from: an explicit `--assets-from` tree (that tree is
 * the whole source) and an offline run (nothing fetched from GitHub may reach the plan, and
 * a cache left by an earlier online install is exactly that). Under a pinned ref the cache
 * WINS outright rather than only when newer - the pin decides what is adopted.
 */
function resolveSkills(): { skills: SkillEntry[]; adopted: string[]; } {
    const skills = bundledSkills();
    const remote = assetsExplicit || isOffline() ? [] : cachedRemoteSkills();
    if (!remote.length) return { skills, adopted: [] };
    const pinned = skillsRefIsPinned();
    const adopted: string[] = [];
    const byName = new Map(skills.map((s) => [s.name, s]));
    for (const r of remote) {
        const bundled = byName.get(r.name);
        if (!bundled || pinned || isNewer(r.meta.version || "", bundled.meta.version || "")) { byName.set(r.name, r); adopted.push(r.name); }
    }
    return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), adopted: adopted.sort() };
}

export function inspectSkills(): SkillEntry[] {
    return resolveSkills().skills;
}

/**
 * The cached remote skills the plan ACTUALLY takes over the bundle. A cache entry is not an
 * adoption: an entry the bundle has caught up with loses the version gate and survives on
 * disk until a refresh prunes it, which a throttled run never performs. Counting the cache
 * directory instead would let `install` report skills over the bundle for a run that installs
 * purely bundled ones, so the reported provenance is derived from this one decision.
 */
export function adoptedRemoteSkills(): string[] {
    return resolveSkills().adopted;
}

/** The set of skill names the user discarded (skipped by installs/updates, pruned everywhere). */
function discardedSkillNames(): Set<string> {
    return new Set(conf.readConfig().config.discardedSkills);
}

/** skillName -> agents it is turned off for (per-agent opt-out, on top of the global discard). */
function skillAgentsOffMap(): Record<string, string[]> {
    return conf.readConfig().config.skillAgentsOff || {};
}

/** True when `skill` is turned off for `agentName` (per-agent opt-out). */
function isSkillOffForAgent(skill: string, agentName: string, map = skillAgentsOffMap()): boolean {
    return (map[skill] || []).includes(agentName);
}

export interface SkillInfo { name: string; version: string | null; description: string | null; discarded: boolean; agentsOff: string[]; }

/**
 * Every known skill (bundled + remote overlay, discarded included) with its discard
 * state and per-agent opt-outs, for the hub's skills section and `enigma skills list`.
 */
export function listSkillsStatus(): SkillInfo[] {
    const discarded = discardedSkillNames();
    const offMap = skillAgentsOffMap();
    return inspectSkills().map((s) => ({
        name: s.name,
        version: s.meta.version || null,
        description: s.meta.description || null,
        discarded: discarded.has(s.name),
        agentsOff: offMap[s.name] || [],
    }));
}

/**
 * Discard or restore a skill and apply it to disk immediately: the discard state
 * is recorded in the global .enigma.json, then syncDeployed prunes the skill from
 * every existing deployment (discard) or re-installs it there (restore). Returns
 * the sync notices for display.
 */
export function discardSkill(name: string, discarded: boolean): string[] {
    conf.setSkillDiscarded(name, discarded);
    return syncDeployed();
}

/**
 * Turn a skill on/off for ONE agent and apply it immediately: record the per-agent
 * opt-out in the global config, then re-sync so the skill is pruned from (off) or
 * re-deployed to (on) that agent's existing deployments. Returns sync notices.
 */
export function setSkillAgent(name: string, agentName: string, off: boolean): string[] {
    conf.setSkillAgentOff(name, agentName, off);
    return syncDeployed([agentName]);
}

/** A skill as seen across the user's installed agents, for the dashboard Skills subpage. */
export interface SkillReport {
    name: string;
    source: "enigma" | "external";
    version: string | null;
    description: string | null;
    provider: string | null;
    /** enigma skills: true when the user disabled (discarded) it. */
    discarded: boolean;
    /** Labels of the installed agents whose global skills dir currently holds it. */
    agents: string[];
    /** enigma skills: deployment freshness; null for external (no canonical to compare). */
    update: "up-to-date" | "update" | "modified" | "not-deployed" | null;
    /** ISO date the skill was last edited (last commit), from skill.json; null if unsealed. */
    updated: string | null;
    /**
     * enigma skills: per installed agent (Claude Code, Codex, OpenCode...), whether this skill
     * is deployed there and whether the user turned it off for that agent (the per-agent
     * opt-out). Lets the UI enable/disable a skill app-by-app. Empty for external skills.
     */
    agentStates: { name: string; label: string; deployed: boolean; off: boolean; }[];
}

/** Worst-status escalation: modified beats update beats up-to-date. */
function updateSeverity(u: SkillReport["update"]): number {
    return u === "modified" ? 2 : u === "update" ? 1 : 0;
}

/**
 * Every skill the user has across installed agents (global scope): enigma's own (the
 * canonical bundled+remote set, disabled ones included) and any external/foreign skill
 * found deployed. For enigma skills it also reports whether the deployed copies are
 * up-to-date, have an update available, or were modified locally.
 */
export function skillsReport(): SkillReport[] {
    const discarded = discardedSkillNames();
    const offMap = skillAgentsOffMap();
    const agents = discoverAgents();
    const canonical = new Map(inspectSkills().map((s) => [s.name, s]));
    const byName = new Map<string, SkillReport>();

    for (const [name, s] of canonical) {
        byName.set(name, {
            name, source: "enigma", version: s.meta.version || null, description: s.meta.description || null,
            provider: MANAGED_PROVIDER, discarded: discarded.has(name), agents: [], update: "not-deployed", updated: s.meta.updated || null, agentStates: [],
        });
    }

    for (const agent of agents) {
        const root = agent.targets.global.skills;
        if (!isDir(root)) continue;
        for (const e of readdirSync(root)) {
            const sdir = join(root, e);
            if (!isDir(sdir) || !existsSync(join(sdir, "SKILL.md"))) continue;
            const canon = canonical.get(e);
            const meta = readSkillMeta(sdir);
            let entry = byName.get(e);
            if (!entry) {
                const enigma = isManagedProvider(meta.provider);
                entry = {
                    name: e, source: enigma ? "enigma" : "external", version: meta.version || null,
                    description: meta.description || null, provider: meta.provider || null,
                    discarded: false, agents: [], update: enigma ? "not-deployed" : null, updated: meta.updated || null, agentStates: [],
                };
                byName.set(e, entry);
            }
            if (!entry.agents.includes(agent.label)) entry.agents.push(agent.label);
            if (entry.source === "enigma" && canon) {
                const kind = skillStatus(sdir, canon.meta).kind;
                const mapped = kind === "tampered" ? "modified" : kind === "update" ? "update" : "up-to-date";
                if (entry.update === "not-deployed" || updateSeverity(mapped) > updateSeverity(entry.update)) entry.update = mapped;
            }
        }
    }

    // Per-agent state for enigma skills: across every installed agent, whether this skill is
    // currently on disk there and whether the user opted it out for that agent. External skills
    // are foreign (not enigma-managed), so they get no per-agent controls.
    for (const entry of byName.values()) {
        if (entry.source !== "enigma") continue;
        entry.agentStates = agents.map((a) => ({
            name: a.name,
            label: a.label,
            deployed: entry.agents.includes(a.label) && !isSkillOffForAgent(entry.name, a.name, offMap),
            off: isSkillOffForAgent(entry.name, a.name, offMap),
        }));
    }

    return [...byName.values()].sort((a, b) =>
        a.source === b.source ? a.name.localeCompare(b.name) : (a.source === "enigma" ? -1 : 1));
}

/** The SKILL.md content of `name`: a deployed agent copy if any, else the bundled source. */
export function readSkillSource(name: string): string | null {
    for (const agent of discoverAgents()) {
        const f = join(agent.targets.global.skills, name, "SKILL.md");
        if (existsSync(f)) { try { return readFileSync(f, "utf8"); } catch { /* try the next */ } }
    }
    const canon = inspectSkills().find((s) => s.name === name);
    if (canon) { try { return readFileSync(join(canon.src, "SKILL.md"), "utf8"); } catch { /* none */ } }
    return null;
}

/**
 * Overwrite the SKILL.md of `name` in every installed agent that holds it (never creates a
 * new deployment). Returns the agent labels written. Editing an enigma skill makes its copy
 * "modified" and a later sync/update will revert it - the caller surfaces that.
 */
export function writeSkillEverywhere(name: string, content: string, agentNames?: string[]): string[] {
    const out: string[] = [];
    for (const agent of discoverAgents()) {
        if (agentNames && !agentNames.includes(agent.name)) continue; // per-app save: only the chosen agents
        const file = join(agent.targets.global.skills, name, "SKILL.md");
        if (!existsSync(file)) continue;
        try { writeFileSync(file, content); out.push(agent.label); } catch { /* read-only */ }
    }
    return out;
}

/** Delete an external (non-managed) skill folder from every installed agent that holds it. */
export function removeExternalSkill(name: string): string[] {
    const out: string[] = [];
    for (const agent of discoverAgents()) {
        const dir = join(agent.targets.global.skills, name);
        if (!existsSync(join(dir, "SKILL.md"))) continue;
        if (isManagedProvider(readSkillMeta(dir).provider)) continue; // enigma skills use disable/enable
        try { rmSync(dir, { recursive: true, force: true }); out.push(agent.label); } catch { /* busy/locked */ }
    }
    return out;
}

/** Check GitHub for newer enigma skills and re-sync deployments. Returns what changed. */
export async function checkAndUpdateSkills(): Promise<{ updated: string[]; synced: string[]; }> {
    const r = await refreshSkillsFromGitHub(true);
    const synced = syncDeployed();
    return { updated: r.updated || [], synced };
}

/**
 * Refresh the GitHub remote-skill cache (see skills-remote.ts), feeding it this
 * package's bundled versions so only strictly newer releases are adopted. Safe
 * to call from anywhere: never throws, never blocks beyond its fetch timeouts.
 */
export async function refreshSkillsFromGitHub(force = false, ref?: string): Promise<RemoteRefreshResult> {
    const bundledVersions: Record<string, string> = {};
    for (const s of bundledSkills()) if (s.meta.version) bundledVersions[s.name] = s.meta.version;
    return refreshRemoteSkills({ force, bundledVersions, ref });
}

export { shouldCheckRemote, skillsOrigin };

/** The single shared memory file an agent uses (from assets/memory), if present. */
function inspectMemory(agent: Agent): MemoryEntry[] {
    if (!agent.memoryFile) return [];
    const src = join(memoryRoot(), agent.memoryFile);
    return existsSync(src) ? [{ name: agent.memoryFile, src }] : [];
}

// --- memory editing (dashboard global + per-project) ---------------------------
// The deployed CLAUDE.md/AGENTS.md can be customized from the dashboard. Several agents
// can share one file (codex + opencode both read AGENTS.md, and in a project they share
// the same <project>/AGENTS.md path), so targets are GROUPED by deployed path. Edits are
// written directly to the deployed file and marked (recordMemoryEdit); the overwrite/keep
// policy in syncTarget decides whether a later sync replaces them. Reads/writes resolve the
// path from this list server-side - a client never supplies an arbitrary path.

export interface MemoryGroup {
    /** Stable id (the first agent's name) used by the dashboard to reference a group. */
    id: string;
    /** Memory file name (CLAUDE.md / AGENTS.md). */
    file: string;
    /** Agents that read this exact file. */
    agents: { name: string; label: string; }[];
    /** The file exists on disk. */
    deployed: boolean;
    /** Edited via the dashboard and not since superseded (the keep policy applies). */
    edited: boolean;
    /** enigma wrote it last (managed); false for a hand-authored/edited file. */
    managed: boolean;
}

interface MemTargetRaw { name: string; label: string; file: string; src: string; dest: string; }

/** Memory deploy targets for a scope: global (each installed agent's own dir) or a project path. */
function memoryTargetsRaw(project?: string): MemTargetRaw[] {
    const out: MemTargetRaw[] = [];
    if (project) {
        const locals = localTargetsAt(project);
        for (const name of Object.keys(locals)) {
            const def = AGENTS[name];
            if (!def?.memoryFile) continue;
            out.push({ name, label: def.label, file: def.memoryFile, src: join(memoryRoot(), def.memoryFile), dest: join(locals[name]!.memory, def.memoryFile) });
        }
    } else {
        for (const a of discoverAgents()) {
            if (!a.installed || !a.memoryFile) continue;
            out.push({ name: a.name, label: a.label, file: a.memoryFile, src: join(memoryRoot(), a.memoryFile), dest: join(a.targets.global.memory, a.memoryFile) });
        }
    }
    return out;
}

/**
 * Group memory targets by file name (so a shared instruction file appears once even when each
 * agent deploys it to its own dir). AGENTS.md serves codex + opencode and CLAUDE.md serves
 * claude; the file name maps 1:1 to a single source template, so grouping by it is safe. Globally
 * codex and opencode read distinct paths (~/.codex/AGENTS.md vs ~/.config/opencode/AGENTS.md); they
 * still collapse into one row, and edits fan out to every path (see saveMemoryGroup/resetMemoryGroup).
 */
export function listMemoryGroups(project?: string): MemoryGroup[] {
    const byFile = new Map<string, MemoryGroup & { dests: Set<string>; }>();
    for (const r of memoryTargetsRaw(project)) {
        let g = byFile.get(r.file);
        if (!g) {
            g = { id: r.name, file: r.file, dests: new Set(), agents: [], deployed: true, edited: false, managed: true };
            byFile.set(r.file, g);
        }
        g.agents.push({ name: r.name, label: r.label });
        if (g.dests.has(r.dest)) continue; // codex+opencode share one path in project scope
        g.dests.add(r.dest);
        g.deployed = g.deployed && existsSync(r.dest);
        g.edited = g.edited || isMemoryEdited(r.dest);
        g.managed = g.managed && isEnigmaWritten(r.dest);
    }
    return [...byFile.values()].map(({ dests: _d, ...g }) => g);
}

/** Every deploy target sharing the referenced group's file (codex+opencode for AGENTS.md). */
function memTargetsForGroup(id: string, project?: string): MemTargetRaw[] {
    const targets = memoryTargetsRaw(project);
    const self = targets.find((x) => x.name === id);
    return self ? targets.filter((x) => x.file === self.file) : [];
}

/** The content shown in the editor: the first deployed file in the group, else the rendered template. */
export function readMemoryGroup(id: string, project?: string): string | null {
    const group = memTargetsForGroup(id, project);
    if (!group.length) return null;
    for (const r of group) if (existsSync(r.dest)) { try { return readFileSync(r.dest, "utf8"); } catch { /* try next */ } }
    return existsSync(group[0]!.src) ? renderMemory(group[0]!.src) : "";
}

/**
 * Save custom memory content to every file in the group (creating each if absent - an explicit
 * user edit is consent to deploy), marking them edited so the keep policy can preserve them. A
 * shared file (AGENTS.md) is written to each agent's path so they stay in sync. Returns the labels.
 */
export function saveMemoryGroup(id: string, content: string, project?: string): { ok: boolean; labels: string[]; } {
    const group = memTargetsForGroup(id, project);
    if (!group.length) return { ok: false, labels: [] };
    const written = new Set<string>();
    try {
        for (const r of group) {
            if (written.has(r.dest)) continue;
            written.add(r.dest);
            mkdirSync(dirname(r.dest), { recursive: true });
            writeFileSync(r.dest, content);
            recordMemoryEdit(r.dest, content);
        }
    } catch { return { ok: false, labels: [] }; }
    return { ok: true, labels: group.map((x) => x.label) };
}

/** Restore every file in the group to the managed (rendered) version, clearing the edit markers. */
export function resetMemoryGroup(id: string, project?: string): { ok: boolean; labels: string[]; } {
    const group = memTargetsForGroup(id, project);
    if (!group.length || !existsSync(group[0]!.src)) return { ok: false, labels: [] };
    const written = new Set<string>();
    try {
        for (const r of group) {
            if (written.has(r.dest)) continue;
            written.add(r.dest);
            mkdirSync(dirname(r.dest), { recursive: true });
            writeMemory(r.src, r.dest);
        }
    } catch { return { ok: false, labels: [] }; }
    return { ok: true, labels: group.map((x) => x.label) };
}

// --- maintenance: seal + check -------------------------------------------------

// CITATION.cff at the monorepo root cites the published CLI version. It only exists
// in a source checkout (the installed npm package has no monorepo root), so both
// helpers no-op when the file (or its version line) is absent.
const CITATION_PATH = resolve(PKG_ROOT, "..", "..", "CITATION.cff");

/** The version currently cited in CITATION.cff, or null when there is nothing to sync. */
function citationVersion(): string | null {
    if (!existsSync(CITATION_PATH)) return null;
    const m = readFileSync(CITATION_PATH, "utf8").match(/^version:[ \t]*(\S+)[ \t]*$/m);
    return m ? m[1]! : null;
}

/**
 * ISO date of the last commit that changed a skill's CONTENT, or null outside a git checkout.
 * Excludes skill.json: every release reseals it (cliVersion bump), so including it would stamp
 * the same release date on every skill and hide when the content (SKILL.md, references) actually
 * changed. `name` is the skill dir relative to skillsRoot() (the git pathspec base).
 */
function gitLastCommitISO(name: string): string | null {
    try {
        const out = execFileSync(
            "git",
            ["log", "-1", "--format=%cI", "--", name, `:(exclude)${name}/skill.json`],
            { cwd: skillsRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        ).trim();
        return out || null;
    } catch { return null; }
}

/** One official-skill catalog entry written to docs/skills-catalog.json by seal. */
interface CatalogEntry { name: string; version: string | null; description: string | null; provider: string; updated: string | null; sha: string | null; }

/** The single source of truth the web (and anyone) reads to list official skills. */
const CATALOG_PATH = resolve(PKG_ROOT, "..", "..", "docs", "skills-catalog.json");

/** Write the catalog only in a source checkout (docs/ exists); the installed package has no docs/. */
function writeCatalog(entries: CatalogEntry[], cli: string): void {
    if (!isDir(resolve(PKG_ROOT, "..", ".."))) return;
    const docsDir = resolve(PKG_ROOT, "..", "..", "docs");
    if (!isDir(docsDir)) return;
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const catalog = { generator: "enigma seal", cliVersion: cli, count: sorted.length, skills: sorted };
    writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
    console.log(`updated  docs/skills-catalog.json  ${sorted.length} skill(s)`);
}

/** (Re)compute each source skill's content hash into its skill.json. */
export function sealSources(): void {
    if (!isDir(skillsRoot())) { console.error(`No skills directory found at ${skillsRoot()}.`); process.exit(1); }
    const cli = cliVersion();
    let sealed = 0;
    const catalog: CatalogEntry[] = [];
    for (const name of readdirSync(skillsRoot())) {
        const dir = join(skillsRoot(), name);
        if (!isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
        const metaPath = join(dir, "skill.json");
        const meta = readJson<SkillMeta>(metaPath) || { name };
        const before = JSON.stringify(meta);
        // Auto-managed fields (never hand-written): canonical provider, the version
        // of the CLI doing the seal, the content hash, and the last-edited date (the
        // last commit that touched the skill; kept if git is unavailable).
        meta.provider = MANAGED_PROVIDER;
        meta.cliVersion = cli;
        meta.sha = computeContentSha(dir);
        meta.updated = gitLastCommitISO(name) || meta.updated || new Date().toISOString();
        const changed = JSON.stringify(meta) !== before;
        writeFileSync(metaPath, serializeMeta(meta));
        console.log(`${changed ? "updated" : "ok     "}  ${name}  cli=${cli}  sha=${meta.sha.slice(0, 12)}`);
        catalog.push({ name: meta.name || name, version: meta.version || null, description: meta.description || null, provider: meta.provider, updated: meta.updated || null, sha: meta.sha || null });
        sealed++;
    }
    writeCatalog(catalog, cli);
    const cited = citationVersion();
    if (cited !== null && cited !== cli) {
        const cff = readFileSync(CITATION_PATH, "utf8");
        writeFileSync(CITATION_PATH, cff.replace(/^version:[ \t]*\S+[ \t]*$/m, `version: ${cli}`));
        console.log(`updated  CITATION.cff  version ${cited} -> ${cli}`);
    }
    console.log(`\nSealed ${sealed} skill(s) at cliVersion ${cli}.`);
}

/**
 * Byte budget for a deployed memory file. Memory is the only always-on channel, so every
 * byte here is paid on every session of every user regardless of the task. Anything that is
 * not a truly universal rule belongs in a policy skill (loaded on demand) or a guardrail
 * rule (deterministic, token-free) instead - see the three-tier routing doctrine.
 */
export const MEMORY_BUDGET_BYTES = 24_000;

/**
 * What a source memory file can cost a session, which is not its size on disk: the case blocks
 * hold mutually exclusive alternatives and renderMemory deploys exactly one VALUE per key, so
 * charging all of them (plus their markers, which never ship either) would bill context nobody
 * pays. What deploys together is every block sharing the selected value, hence the sum per
 * `key=value`; what a user chooses between is the values, hence the max per key. Charging that
 * worst selectable case keeps the figure config-independent and still bounds every deployment.
 */
export function budgetedBytes(content: string): number {
    const perValue = new Map<string, { key: string; bytes: number; }>();
    const stripped = content.replace(CASE_BLOCK, (_m, key: string, val: string, body: string) => {
        const id = `${key}=${val}`;
        const seen = perValue.get(id) ?? { key, bytes: 0 };
        perValue.set(id, { key, bytes: seen.bytes + Buffer.byteLength(body) });
        return "";
    });
    const largest = new Map<string, number>();
    for (const { key, bytes } of perValue.values()) largest.set(key, Math.max(largest.get(key) ?? 0, bytes));
    let bytes = Buffer.byteLength(stripped);
    for (const size of largest.values()) bytes += size;
    return bytes;
}

/**
 * Report every authored case block whose KEY=VALUE can never match .enigma.json. Such a block
 * fails silently: applyCaseBlocks compares against `String(cfg[key])`, so an unknown key reads
 * as "undefined" and an unselectable value never equals the config, and the block plus its body
 * is dropped from every deployed copy with no error. On a skill that quietly weakens an
 * on-demand file; on the always-on memory kernel it deletes guidance every session was meant
 * to carry. Boolean settings accept "true"/"false"; enum settings, their declared choices; the
 * remaining free-form keys (paths, numbers, lists) are only checked for existence.
 */
export function checkCaseBlocks(label: string, content: string): string[] {
    const problems: string[] = [];
    for (const [, key, val] of content.matchAll(CASE_BLOCK)) {
        if (!(key! in conf.CONFIG_DEFAULTS)) { problems.push(`${label}: case block key '${key}' is not a .enigma.json setting - the block would never deploy`); continue; }
        const def = conf.CONFIG_DEFAULTS[key as conf.EnigmaConfigKey];
        const allowed = conf.CONFIG_CHOICES[key as conf.EnigmaConfigKey] ?? (typeof def === "boolean" ? ["true", "false"] : undefined);
        if (allowed && !allowed.includes(val!)) problems.push(`${label}: case block '${key}=${val}' is not one of ${allowed.join(", ")} - the block would never deploy`);
    }
    return problems;
}

/** Report every bundled memory file whose deployable size exceeds MEMORY_BUDGET_BYTES. */
function checkMemoryBudget(): string[] {
    if (!isDir(memoryRoot())) return [];
    const problems: string[] = [];
    for (const file of readdirSync(memoryRoot())) {
        if (!file.endsWith(".md")) continue;
        const content = readFileSync(join(memoryRoot(), file), "utf8");
        const bytes = budgetedBytes(content);
        if (bytes > MEMORY_BUDGET_BYTES) problems.push(`memory/${file}: ${bytes} bytes exceeds the ${MEMORY_BUDGET_BYTES}-byte always-on budget - move detail into a policy skill or a guardrail rule`);
        problems.push(...checkCaseBlocks(`memory/${file}`, content));
    }
    return problems;
}

/**
 * Integrity gate (CI/pre-commit): verify each source skill is well-formed and
 * sealed. Exits non-zero on any problem.
 */
export function checkSources(): void {
    if (!isDir(skillsRoot())) { console.error(`No skills directory found at ${skillsRoot()}.`); process.exit(1); }
    const cli = cliVersion();
    const problems: string[] = [];
    let checked = 0;
    for (const name of readdirSync(skillsRoot())) {
        const dir = join(skillsRoot(), name);
        if (!isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
        checked++;
        const md = readFileSync(join(dir, "SKILL.md"), "utf8");
        const fm = md.match(/^---\n([\s\S]*?)\n---/);
        if (!fm) problems.push(`${name}: SKILL.md is missing YAML frontmatter`);
        else {
            if (!/^name:\s*\S/m.test(fm[1]!)) problems.push(`${name}: frontmatter missing 'name'`);
            if (!/^description:\s*\S/m.test(fm[1]!)) problems.push(`${name}: frontmatter missing 'description'`);
        }
        problems.push(...checkCaseBlocks(name, md));
        const metaPath = join(dir, "skill.json");
        if (!existsSync(metaPath)) { problems.push(`${name}: missing skill.json`); continue; }
        const meta = readJson<SkillMeta>(metaPath);
        if (!meta) { problems.push(`${name}: skill.json is not valid JSON`); continue; }
        if (!isManagedProvider(meta.provider)) problems.push(`${name}: skill.json provider is not ${MANAGED_PROVIDER}`);
        if (!meta.version) problems.push(`${name}: skill.json missing 'version'`);
        if (meta.cliVersion !== cli) problems.push(`${name}: stale cliVersion (${meta.cliVersion || "none"} != ${cli}) - run 'enigma seal'`);
        if (!meta.sha) problems.push(`${name}: not sealed (run 'enigma seal')`);
        else if (meta.sha !== computeContentSha(dir)) problems.push(`${name}: stale sha - content changed since seal (run 'enigma seal')`);
    }
    const cited = citationVersion();
    if (cited !== null && cited !== cli) problems.push(`CITATION.cff: stale version (${cited} != ${cli}) - run 'enigma seal'`);
    problems.push(...checkMemoryBudget());
    if (problems.length) {
        console.error(`Integrity check FAILED (${problems.length} problem(s) across ${checked} skill(s)):`);
        for (const pr of problems) console.error(`  - ${pr}`);
        process.exit(1);
    }
    console.log(`Integrity check passed: ${checked} skill(s) well-formed and sealed.`);
}

// --- install -------------------------------------------------------------------

/**
 * Resolve the token-efficient output level (off|lite|full|ultra) for this install and
 * persist it to .enigma.json at `scope`, so renderMemory bakes the matching section into
 * the deployed memory file. Honors an explicit --output-style flag, otherwise asks once
 * when interactive (defaulting to the current value). Never writes on a dry run.
 */
async function resolveOutputStyle(opts: InstallOptions, scope: "global" | "local", interactive: boolean, reporter: Reporter): Promise<void> {
    let style = opts.outputStyle?.toLowerCase() ?? null;
    if (style && !conf.OUTPUT_STYLES.includes(style as conf.OutputStyle)) {
        reporter.warn(`Ignoring --output-style '${opts.outputStyle}': use one of ${conf.OUTPUT_STYLES.join(", ")}.`);
        style = null;
    }
    if (!style && interactive && !opts.dryRun) {
        const r = await p.select({
            message: "Token-efficient output? (shorter replies; code/commits/PRs stay normal)",
            options: [
                { value: "off", label: "Off", hint: "full prose (default)" },
                { value: "lite", label: "Lite", hint: "professional terse - drop filler, keep grammar" },
                { value: "full", label: "Full", hint: "drop articles, fragments, answers sized to the question" },
                { value: "ultra", label: "Ultra", hint: "telegraphic, maximum compression" },
            ],
            initialValue: conf.readConfig().config.outputStyle,
        });
        if (p.isCancel(r)) return;          // keep the current value; do not abort the whole install
        style = r as string;
    }
    if (style && !opts.dryRun && style !== conf.readConfig().config.outputStyle) {
        conf.setEnigmaValue("outputStyle", style, scope);
        reporter.info(`Token-efficient output: ${style} (${scope}).`);
    }
}

/**
 * Resolve the minimal-code (anti-overengineering) level (off|lite|full|ultra) for this
 * install and persist it to .enigma.json at `scope`, so renderMemory bakes the matching
 * section into the deployed memory file. Honors an explicit --minimal-code flag, otherwise
 * asks once when interactive (defaulting to the current value). Never writes on a dry run.
 */
async function resolveMinimalCode(opts: InstallOptions, scope: "global" | "local", interactive: boolean, reporter: Reporter): Promise<void> {
    let level = opts.minimalCode?.toLowerCase() ?? null;
    if (level && !conf.MINIMAL_CODE_LEVELS.includes(level as conf.MinimalCode)) {
        reporter.warn(`Ignoring --minimal-code '${opts.minimalCode}': use one of ${conf.MINIMAL_CODE_LEVELS.join(", ")}.`);
        level = null;
    }
    if (!level && interactive && !opts.dryRun) {
        const r = await p.select({
            message: "Minimal-code discipline? (laziest solution that works; security/validation stay non-negotiable)",
            options: [
                { value: "off", label: "Off", hint: "no extra anti-overengineering pressure" },
                { value: "lite", label: "Lite", hint: "build what's asked, name the lazier alternative" },
                { value: "full", label: "Full", hint: "YAGNI ladder enforced - stdlib/native first, shortest diff (default)" },
                { value: "ultra", label: "Ultra", hint: "YAGNI extremist - deletion before addition" },
            ],
            initialValue: conf.readConfig().config.minimalCode,
        });
        if (p.isCancel(r)) return;          // keep the current value; do not abort the whole install
        level = r as string;
    }
    if (level && !opts.dryRun && level !== conf.readConfig().config.minimalCode) {
        conf.setEnigmaValue("minimalCode", level, scope);
        reporter.info(`Minimal-code discipline: ${level} (${scope}).`);
    }
}

/**
 * Offer the local savings dashboard at install. Opt-in (default off): enabling defaults
 * to on-demand (zero idle cost). Applies the mode side effects (hosts entry for
 * http://enigma; background daemon for "always") and reports what needs manual admin.
 */
async function resolveDashboard(opts: InstallOptions, scope: "global" | "local", interactive: boolean, reporter: Reporter): Promise<void> {
    let mode = opts.dashboard?.toLowerCase() ?? null;
    if (mode && !conf.DASHBOARD_MODES.includes(mode as conf.DashboardMode)) {
        reporter.warn(`Ignoring --dashboard '${opts.dashboard}': use one of ${conf.DASHBOARD_MODES.join(", ")}.`);
        mode = null;
    }
    if (!mode && interactive && !opts.dryRun) {
        const r = await p.select({
            message: "Local savings dashboard? (visualize token savings in your browser at http://enigma)",
            options: [
                { value: "off", label: "Off", hint: "no dashboard (default)" },
                { value: "on-demand", label: "On-demand", hint: "runs only while 'enigma dashboard' is open - zero idle cost (recommended)" },
                { value: "always", label: "Always on", hint: "lightweight background daemon, reachable any time" },
            ],
            initialValue: conf.readConfig().config.dashboard,
        });
        if (p.isCancel(r)) return;          // keep the current value; do not abort the whole install
        mode = r as string;
    }
    if (mode && !opts.dryRun && mode !== conf.readConfig().config.dashboard) {
        conf.setEnigmaValue("dashboard", mode, scope);
        const result = applyDashboardMode(mode as conf.DashboardMode);
        reporter.info(`Local dashboard: ${mode} (${scope}).`);
        if (result.hosts?.needsAdmin) {
            reporter.warn(`Could not map http://enigma (needs admin). Add this line to ${result.hosts.path} manually, or just use http://localhost:24282:\n  127.0.0.1 enigma`);
        }
    }
    // Choosing a dashboard turns on real tool-usage stats by default, so it actually reflects
    // your Claude Code usage. It reads local transcripts on demand (no background process), so
    // there is no idle cost; turn it off any time with `enigma config usage-stats off`.
    if (mode && mode !== "off" && !opts.dryRun && !conf.readConfig().config.usageStats) {
        conf.setEnigmaValue("usageStats", true, scope);
        reporter.info("Enabled real tool-usage stats for the dashboard (off: enigma config usage-stats off).");
    }
}

/**
 * Offer the prompt secret guard at install (opt-in, default OFF per the user's choice).
 * When on, `enigma claude` routes through the local proxy and blocks credentials in chat
 * messages before they reach the model. Claude Code only. Honors --prompt-secret-guard.
 */
async function resolveSecretGuard(opts: InstallOptions, scope: "global" | "local", interactive: boolean, reporter: Reporter): Promise<void> {
    let enable = opts.promptSecretGuard;
    if (enable === null && interactive && !opts.dryRun && !conf.readConfig().config.promptSecretGuard) {
        const r = await p.confirm({
            message: "Enable the prompt secret guard? Blocks API keys/secrets pasted into Claude Code chat before they reach the model (Claude Code only, via a local proxy). Default: off.",
            initialValue: false,
        });
        if (p.isCancel(r)) return;          // keep current value; do not abort the install
        enable = r;
    }
    if (enable && !opts.dryRun && !conf.readConfig().config.promptSecretGuard) {
        conf.setEnigmaValue("promptSecretGuard", true, scope);
        reporter.info(`Prompt secret guard: on (mode ${conf.readConfig().config.promptSecretMode}); applies when you launch 'enigma claude'. Off: enigma config prompt-secret-guard off.`);
    }
}

/**
 * Plan and apply a skills install. Progress is emitted through `reporter`:
 * clack for the CLI, or a buffering reporter when driven inline by the TUI.
 * Interactive prompts (scope/agent/skill selection) still use clack directly and
 * only run when `interactive` is true, so the TUI never triggers them.
 */
export async function installSkills(opts: InstallOptions, interactive: boolean, reporter: Reporter = clackReporter()): Promise<void> {
    const available = discoverAgents();
    if (available.length === 0) reporter.fatal("No installable agents known.");

    // An explicit asset tree is the whole source: overlaying a GitHub cache on top of it
    // would defeat the point of staging one, so it implies offline. inspectSkills() enforces
    // that on the plan itself - stopping only the fetch would still install a cache an
    // earlier online run had left behind.
    if (opts.assetsFrom) {
        try { useAssetsFrom(opts.assetsFrom); }
        catch (err) { reporter.fatal((err as Error).message); }
        reporter.info(`Assets: ${assetsRoot()} (--assets-from; no skill update check).`);
    }
    const offline = opts.offline || Boolean(opts.assetsFrom);
    // Offline is published in the environment, not threaded as a parameter, because the calls
    // it must stop are detached children (see util.isOffline). Set here as well as in the CLI
    // so the plan is offline whichever entry point asked for it.
    if (offline) process.env.ENIGMA_OFFLINE = "1";
    // Same validation the CLI applies, for the inline (TUI) entry point: a ref that cannot be
    // honoured stops the install instead of quietly resolving to the default branch.
    try { pinnedRef(opts.ref ?? undefined); }
    catch (err) { reporter.fatal((err as Error).message); }
    if (opts.ref) process.env.ENIGMA_SKILLS_REF = opts.ref;

    // Refresh the GitHub skill cache first so the plan below uses the newest
    // published skills, not only the ones bundled with this package version.
    // Strictly best-effort: any failure falls back to bundled/cached skills.
    if (!offline && shouldCheckRemote(Boolean(opts.ref), opts.ref ?? undefined)) {
        const sp = reporter.spinner();
        sp.start("Checking GitHub for skill updates...");
        const r = await refreshSkillsFromGitHub(Boolean(opts.ref), opts.ref ?? undefined);
        if (r.error) sp.stop(`Skill update check failed (${r.error}); using bundled skills.`);
        else if (r.updated.length) sp.stop(`Skill update(s) from GitHub: ${r.updated.join(", ")}.`);
        else sp.stop("Skills are up to date with GitHub.");
    }
    // Always reported, checked or not: skills can be updated from the repo without an npm
    // release, so "which CLI version" does not identify which skills a run worked with.
    // This line is the one to record alongside the CLI version.
    // The line states what was ACTUALLY installed, never what was merely resolved: a ref that
    // resolved but yielded no adopted skill is a bundled install, and claiming its commit as
    // the provenance would misrecord exactly the run that pinned it for reproducibility.
    if (opts.assetsFrom) {
        reporter.info(`Skills source: ${assetsRoot()} (--assets-from; no remote skills), CLI ${cliVersion()}.`);
    } else if (offline) {
        reporter.info(`Skills source: bundled with enigma-cli ${cliVersion()} (offline - no remote skills).`);
    } else {
        const origin = skillsOrigin(opts.ref ?? undefined);
        const adopted = adoptedRemoteSkills().length;
        reporter.info(origin.commit && adopted
            ? `Skills source: ${origin.repo}@${origin.ref} (commit ${origin.commit.slice(0, 7)}), ${adopted} skill(s) over the bundle, CLI ${cliVersion()}.`
            : `Skills source: bundled with enigma-cli ${cliVersion()} (nothing adopted from ${origin.repo}@${origin.ref}).`);
    }

    // --- scope ---
    let scope: "global" | "local";
    if (opts.scope) {
        scope = opts.scope;
    } else if (interactive) {
        const r = await p.select({
            message: "Where should skills be installed?",
            options: [
                { value: "global", label: "Global (user)", hint: "~/.claude, ~/.codex, ~/.config/opencode" },
                { value: "local", label: "Local (this project)", hint: process.cwd() },
            ],
        });
        if (p.isCancel(r)) { p.cancel("Aborted."); return; }
        scope = r as "global" | "local";
    } else {
        scope = "global";
    }

    // --- agents (auto-detect installed) ---
    const detected = available.filter((a) => a.installed);
    let chosenAgents = available;
    if (opts.agents.length) {
        chosenAgents = available.filter((a) => opts.agents.includes(a.name));
        const unknown = opts.agents.filter((n) => !available.some((a) => a.name === n));
        if (unknown.length) reporter.warn(`Skipping unknown/absent agents: ${unknown.join(", ")}`);
    } else if (opts.allAgents) {
        chosenAgents = available;
    } else if (interactive && available.length > 1) {
        const preselect = (detected.length ? detected : available).map((a) => a.name);
        const r = await p.multiselect({
            message: "Which agents? (detected on this system are preselected)",
            options: available.map((a) => ({ value: a.name, label: a.label, hint: a.installed ? "detected" : "not detected" })),
            initialValues: preselect,
            required: true,
        });
        if (p.isCancel(r)) { p.cancel("Aborted."); return; }
        chosenAgents = available.filter((a) => (r as string[]).includes(a.name));
    } else if (detected.length) {
        chosenAgents = detected;
    } else {
        chosenAgents = available;
        reporter.warn("No installed agents detected; defaulting to all supported agents.");
    }

    if (chosenAgents.length === 0) reporter.fatal("No matching agents selected.");

    // Claude-specific: disable the Co-Authored-By/PR attribution deterministically
    // whenever Claude Code is a target (commits stay attributed solely to the user).
    const claudeScope = chosenAgents.some((a) => a.name === "claude") ? scope : null;
    const applyClaudeConfig = (): void => {
        if (!claudeScope || opts.dryRun) return;
        if (disableClaudeAttribution(claudeScope)) {
            reporter.info("Claude Code: disabled Co-Authored-By and PR attribution in settings.json.");
        }
        if (disableClaudeFeedbackSurvey(claudeScope)) {
            reporter.info("Claude Code: disabled the session feedback survey (re-enable with 'enigma config claude-survey on').");
        }
        if (!opts.noStatusline && conf.readConfig().config.statusline && enableClaudeStatusline(claudeScope)) {
            reporter.info("Claude Code: statusline shows the [ENIGMA] badge, context and cost, plus live gate progress during a run.");
        }
        // Workspace trust: pre-answer the "do you trust this folder" prompt (default on).
        // Only ever applied when the flag is on - a user who turned it off keeps the prompt,
        // and the workspaces they already trusted are left alone either way.
        if (conf.readConfig().config.claudeTrust && !getClaudeTrust() && setClaudeTrust(true)) {
            reporter.info("Claude Code: workspace trust pre-answered, so it stops asking in every folder (undo with 'enigma config claude-trust off').");
        }
    };

    // GitHub CLI (used by agents for PRs): disable usage telemetry by default.
    // Privacy win with zero functional cost (no gh feature depends on it), and it
    // sidesteps the Windows window-flash bug where the detached `gh send-telemetry`
    // spawns tzutil.exe unhidden (cli/cli#13354). No-op when gh is not installed.
    const applyGhConfig = (): void => {
        if (opts.dryRun) return;
        if (setGhTelemetry(false) === true) {
            reporter.info("GitHub CLI: telemetry disabled (privacy; re-enable with 'enigma config gh-telemetry on').");
        }
        // The only other outbound call an install makes, so --offline has to cover it too.
        if (!offline) starRepoInBackground();
    };

    // Optional, opt-in: disable each chosen agent's per-action approval prompts.
    // Asked here (right after agent selection) so it is grouped with that choice.
    const bypassAgents = await resolveBypassSelection(chosenAgents, opts, interactive);
    const applyBypassConfig = (): void => applyBypass(bypassAgents, scope, opts.dryRun);

    // Hook wiring is opt-out per class: a harness that runs its own hooks installs the
    // skills with --no-hooks (or --hooks post-edit) so enigma never writes into the event
    // it already owns. Null means "wire everything", which is the historical behaviour.
    const wires = (cls: HookClass): boolean => !opts.dryRun && (opts.hooks === null || opts.hooks.includes(cls));
    if (opts.hooks !== null) {
        const keys: Record<HookClass, string> = { "post-edit": "guardrails, trim, lint", stop: "verify" };
        const skipped = HOOK_CLASSES.filter((c) => !opts.hooks!.includes(c));
        if (skipped.length) {
            const off = skipped.map((c) => keys[c]).join(", ");
            reporter.info(`Not writing ${skipped.join(" / ")} hooks into agent settings (--hooks); this run only. To keep them off: enigma config <${off}> off.`);
        }
    }

    // Auto-lint: re-assert the post-write hook wiring to match the toggle (adds it
    // when on, removes it when off). No-op and cheap when off; on enable the linter
    // install runs in the background. Skipped on a dry run (writes nothing).
    const applyLintConfig = (): void => { if (wires("post-edit")) applyLintWiring(); };

    // Convention guardrails: re-assert the post-edit hook wiring to match the toggle
    // (default on). Same side-effect shape as the lint hook; skipped on a dry run.
    const applyGuardrailsConfig = (): void => { if (wires("post-edit")) applyGuardrailsWiring(); };

    // EOF trimmer: re-assert the post-edit hook wiring to match the toggle (default on),
    // same side-effect shape as the guardrails hook; skipped on a dry run.
    const applyTrimConfig = (): void => { if (wires("post-edit")) applyTrimWiring(); };

    // Completion gate: re-assert the turn-end hook wiring to match the toggle (default
    // on). Same side-effect shape as the guardrails hook; skipped on a dry run.
    const applyVerifyConfig = (): void => { if (wires("stop")) applyVerifyWiring(); };

    // Context-compression MCP: register enigma's MCP server in each chosen agent's
    // config when `compress` is on, remove it when off (mirror presence/absence).
    // Same side-effect shape as the bypass/claude/gh/lint hooks; skipped on dry run.
    const applyMcpConfig = (): void => {
        if (opts.dryRun) return;
        const cfg = conf.readConfig().config;
        const enabled = cfg.compress || cfg.recall || cfg.codeGraph;
        const changed: string[] = [];
        for (const agent of chosenAgents) if (applyMcpForAgent(agent.name, scope)) changed.push(agent.label);
        if (changed.length) {
            const tools = [cfg.compress && "compress", cfg.recall && "recall", cfg.codeGraph && "code graph"].filter(Boolean).join(" + ");
            reporter.info(`enigma MCP server ${enabled ? "registered in" : "removed from"} ${changed.join(", ")}${tools ? ` (tools: ${tools})` : ""}.`);
        }
    };

    // Output-compression level (memory section). Resolved before the plan so memoryStatus
    // and the deployed content reflect it. Irrelevant when only skills are installed.
    if (!opts.skillsOnly) await resolveOutputStyle(opts, scope, interactive, reporter);
    if (!opts.skillsOnly) await resolveMinimalCode(opts, scope, interactive, reporter);
    if (!opts.skillsOnly) await resolveDashboard(opts, scope, interactive, reporter);
    if (!opts.skillsOnly) await resolveSecretGuard(opts, scope, interactive, reporter);

    // Discarded skills never install or update; they are also pruned from every
    // target below (even with --no-prune), so a discard reliably removes the skill.
    const discarded = discardedSkillNames();
    const requestedDiscarded = opts.skills.filter((n) => discarded.has(n));
    if (requestedDiscarded.length) {
        reporter.warn(`Skipping discarded skill(s): ${requestedDiscarded.join(", ")} (restore with 'enigma skills restore <name>').`);
    }

    // --- build the plan per agent ---
    const plan: PlanItem[] = [];
    for (const agent of chosenAgents) {
        const target = agent.targets[scope];
        if (!target) { reporter.warn(`${agent.label} has no '${scope}' target - skipping.`); continue; }
        const skills = inspectSkills().filter((s) => !discarded.has(s.name) && !isSkillOffForAgent(s.name, agent.name));
        const memory = inspectMemory(agent);

        let chosenSkills = skills;
        if (!opts.memoryOnly && opts.skills.length) {
            chosenSkills = skills.filter((s) => opts.skills.includes(s.name));
        } else if (!opts.memoryOnly && interactive && skills.length > 1) {
            const r = await p.multiselect({
                message: `Skills for ${agent.label} - all selected; deselect any you don't want`,
                options: skills.map((s) => {
                    const st = skillStatus(join(target.skills, s.name), s.meta);
                    const prov = s.meta.provider ? ` ${s.meta.provider}` : "";
                    return { value: s.name, label: s.name, hint: `${statusLabel(st)}${prov}` };
                }),
                initialValues: skills.map((s) => s.name),
                required: false,
            });
            if (p.isCancel(r)) { p.cancel("Aborted."); return; }
            chosenSkills = skills.filter((s) => (r as string[]).includes(s.name));
        }

        const skillsWithStatus: PlannedSkill[] = (opts.memoryOnly ? [] : chosenSkills).map((s) => ({
            ...s, status: skillStatus(join(target.skills, s.name), s.meta), overwrite: true,
        }));
        // Source names exclude discarded skills, so a deployed discarded skill shows
        // up as an orphan; with --no-prune only those discard removals are kept.
        const prune = opts.memoryOnly ? [] : computePrune(target.skills, skills.map((s) => s.name))
            .filter((e) => opts.prune || discarded.has(e.name) || isSkillOffForAgent(e.name, agent.name));

        // Commands ride a full install only (neither --skills-only nor --memory-only)
        // and only for agents whose target declares a command dir.
        const commands: PlannedCommand[] = (opts.skillsOnly || opts.memoryOnly || !target.commands) ? []
            : bundledCommands().map((c) => ({ ...c, status: commandStatus(join(target.commands!, c.name), c.src) }));

        plan.push({ agent, target, skills: skillsWithStatus, memory: opts.skillsOnly ? [] : memory, prune, commands });
    }

    // --- locally-modified (tampered) skills ---
    const tampered = plan.flatMap((x) => x.skills.filter((s) => s.status.kind === "tampered"));
    if (tampered.length) {
        if (opts.keepModified) {
            for (const s of tampered) s.overwrite = false;
            reporter.warn(`${tampered.length} locally-modified skill(s) will be kept (--keep-modified).`);
        } else if (interactive && !opts.dryRun) {
            const sel = await p.multiselect({
                message: `${tampered.length} skill(s) were modified locally since install. Select which to OVERWRITE`,
                options: tampered.map((s, i) => ({ value: i, label: s.name, hint: s.meta.version ? `v${s.meta.version}` : "modified" })),
                initialValues: tampered.map((_, i) => i),
                required: false,
            });
            if (p.isCancel(sel)) { p.cancel("Aborted."); return; }
            tampered.forEach((s, i) => { s.overwrite = (sel as number[]).includes(i); });
        }
    }

    const willCopy = (s: PlannedSkill): boolean =>
        s.status.kind === "install" || s.status.kind === "update" ||
        s.status.kind === "reinstall" || (s.status.kind === "tampered" && s.overwrite);

    // --- preview + counts ---
    let nInstall = 0, nUpdate = 0, nRemove = 0, nSkip = 0, nKept = 0;
    const lines: string[] = [];
    for (const x of plan) {
        lines.push(`${x.agent.label}  (${scope})`);
        for (const s of x.skills) {
            const prov = s.meta.provider ? `  [${s.meta.provider}]` : "";
            let label: string;
            if (s.status.kind === "identical") { nSkip++; label = statusLabel(s.status); }
            else if (s.status.kind === "tampered" && !s.overwrite) { nKept++; label = `keep modified v${s.meta.version || "?"}`; }
            else if (s.status.kind === "tampered") { nUpdate++; label = `overwrite modified v${s.meta.version || "?"}`; }
            else if (s.status.kind === "install") { nInstall++; label = statusLabel(s.status); }
            else { nUpdate++; label = statusLabel(s.status); }
            lines.push(`  ${label.padEnd(26)} skill   ${s.name}${prov}`);
        }
        for (const m of x.memory) {
            const ms = memoryStatus(m.src, join(x.target.memory, m.name));
            if (ms === "identical") { nSkip++; lines.push(`  ${"up-to-date (skip)".padEnd(26)} memory  ${m.name}`); }
            else if (ms === "install") { nInstall++; lines.push(`  ${"install".padEnd(26)} memory  ${m.name}`); }
            else { nUpdate++; lines.push(`  ${"overwrite".padEnd(26)} memory  ${m.name}`); }
        }
        for (const s of x.prune) {
            nRemove++;
            const ver = s.meta.version ? ` v${s.meta.version}` : "";
            const reason = discarded.has(s.name) ? "remove (discarded)"
                : isSkillOffForAgent(s.name, x.agent.name) ? "remove (off for agent)" : "remove (orphaned)";
            lines.push(`  ${reason.padEnd(26)} skill   ${s.name}  [${s.meta.provider}${ver}]`);
        }
        for (const c of x.commands) {
            const cmd = `/${c.name.replace(/\.md$/, "")}`;
            if (c.status === "identical") { nSkip++; lines.push(`  ${"up-to-date (skip)".padEnd(26)} command ${cmd}`); }
            else if (c.status === "install") { nInstall++; lines.push(`  ${"install".padEnd(26)} command ${cmd}`); }
            else { nUpdate++; lines.push(`  ${"replace existing".padEnd(26)} command ${cmd}`); }
        }
    }

    if (nInstall + nUpdate + nRemove === 0) {
        reporter.note(lines.join("\n"), "Nothing to do");
        applyClaudeConfig();
        applyGhConfig();
        applyBypassConfig();
        applyLintConfig();
        applyGuardrailsConfig();
        applyTrimConfig();
        applyVerifyConfig();
        applyMcpConfig();
        await maybeOfferGitHooks(interactive, opts);
        reporter.success(`Everything up-to-date - ${nSkip} item(s) unchanged${nKept ? `, ${nKept} kept modified` : ""} (${scope}).`);
        return;
    }

    reporter.note(lines.join("\n"), opts.dryRun ? "Dry run - planned changes" : "Planned changes");

    if (interactive && !opts.dryRun) {
        const summary = [
            nInstall && `${nInstall} to install`,
            nUpdate && `${nUpdate} to update/overwrite`,
            nRemove && `${nRemove} to remove`,
            nSkip && `${nSkip} unchanged`,
        ].filter(Boolean).join(", ");
        const ok = await p.confirm({ message: `Apply: ${summary}?` });
        if (p.isCancel(ok) || !ok) { p.cancel("Aborted."); return; }
    }

    if (opts.dryRun) { applyBypassConfig(); reporter.info("Dry run complete - no files written."); return; }

    // Which agents actually receive changes (computed before writing, since
    // memoryStatus flips to "identical" once files are copied). Used for the
    // restart notice below.
    const changedAgents = plan.filter((x) =>
        x.skills.some(willCopy) ||
        x.memory.some((m) => memoryStatus(m.src, join(x.target.memory, m.name)) !== "identical") ||
        x.prune.length > 0 ||
        x.commands.some((c) => c.status !== "identical")
    );

    const s = reporter.spinner();
    s.start("Installing...");
    let copied = 0;
    try {
        for (const x of plan) {
            mkdirSync(x.target.skills, { recursive: true });
            mkdirSync(x.target.memory, { recursive: true });
            for (const sk of x.skills) {
                if (!willCopy(sk)) continue;
                deploySkill(sk.src, join(x.target.skills, sk.name), sk.meta);
                copied++;
            }
            for (const m of x.memory) {
                if (memoryStatus(m.src, join(x.target.memory, m.name)) === "identical") continue;
                writeMemory(m.src, join(x.target.memory, m.name));
                copied++;
            }
            if (x.target.commands) {
                for (const c of x.commands) {
                    if (c.status === "identical") continue;
                    mkdirSync(x.target.commands, { recursive: true });
                    writeFileSync(join(x.target.commands, c.name), readFileSync(c.src, "utf8"));
                    copied++;
                }
            }
            for (const pr of x.prune) rmSync(pr.dir, { recursive: true, force: true });
        }
    } catch (err) {
        s.stop("Failed.");
        reporter.fatal(`Error while installing: ${(err as Error).message}`);
    }
    s.stop(`Wrote ${copied} item(s)${nRemove ? `, removed ${nRemove}` : ""}.`);
    applyClaudeConfig();
    applyGhConfig();
    applyBypassConfig();
    applyLintConfig();
    applyGuardrailsConfig();
    applyTrimConfig();
    applyVerifyConfig();
    applyMcpConfig();
    await maybeOfferGitHooks(interactive, opts);
    reporter.success(`${nInstall} installed, ${nUpdate} updated/overwritten` +
        (nRemove ? `, ${nRemove} removed` : "") + (nSkip ? `, ${nSkip} unchanged` : "") +
        (nKept ? `, ${nKept} kept modified` : "") + ` (${scope}).`);

    // Agents load skills/memory at startup, so changes only take effect on a fresh
    // session. Tell the user to restart the affected agents that are running; if we
    // cannot read the process list, fall back to a conditional note.
    if (changedAgents.length) {
        const { known, running } = runningStatus(changedAgents.map((x) => x.agent));
        if (running.size) {
            const names = changedAgents.filter((x) => running.has(x.agent.name)).map((x) => x.agent.label);
            reporter.warn(`Restart ${names.join(", ")} to apply the changes (running now).`);
        } else if (!known) {
            const names = changedAgents.map((x) => x.agent.label);
            reporter.info(`If any of these agents are running, restart them to apply the changes: ${names.join(", ")}.`);
        }
    }
}

/**
 * Re-render the deployed memory file(s) at `scope` for every agent that already has
 * one, applying the current .enigma.json toggles (e.g. parallel-subagents). It only
 * touches files that already exist - it never creates a new deployment - so toggling a
 * setting just rewrites what `enigma install` previously wrote. Returns the agents whose
 * memory file actually changed; memory loads at startup, so those need a restart. With
 * `dryRun`, the changed set is computed without writing.
 */
export function applyMemoryToggles(scope: "global" | "local", dryRun = false): Agent[] {
    const changed: Agent[] = [];
    for (const agent of discoverAgents()) {
        const target = agent.targets[scope];
        if (!target) continue;
        for (const m of inspectMemory(agent)) {
            const dest = join(target.memory, m.name);
            if (!existsSync(dest) || memoryStatus(m.src, dest) === "identical") continue;
            if (!dryRun) writeMemory(m.src, dest);
            changed.push(agent);
        }
    }
    return changed;
}

/**
 * Re-render deployed skills whose config placeholders drifted after a config change (the
 * config-in-skill twin of applyMemoryToggles). For every agent with the skill deployed at
 * `scope`, rewrite its SKILL.md when the rendered value no longer matches. Only touches
 * already-deployed skills (never a first install). Returns the agents that changed.
 */
export function applySkillConfig(scope: "global" | "local", dryRun = false): Agent[] {
    const changed: Agent[] = [];
    for (const agent of discoverAgents()) {
        const target = agent.targets[scope];
        if (!target || !isDir(target.skills)) continue;
        for (const sk of currentSkillSet(agent.name)) {
            const dest = join(target.skills, sk.name);
            if (!existsSync(dest) || !skillConfigDrifted(sk, dest)) continue;
            if (!dryRun) writeFileSync(join(dest, "SKILL.md"), renderSkill(join(sk.src, "SKILL.md"), sk.meta.config));
            if (!changed.includes(agent)) changed.push(agent);
        }
    }
    return changed;
}

/**
 * True when `agent` already received an enigma deployment at `scope`: its skills
 * dir contains a managed-provider skill, or its memory file was written by enigma
 * (recorded in the sync state - a memory file merely EXISTING proves nothing, the
 * user may have authored it). This is the consent marker auto-sync relies on - an
 * agent without a deployment was never opted in, so sync must leave it untouched.
 */
export function hasDeployment(agent: Agent, scope: "global" | "local"): boolean {
    const target = agent.targets[scope];
    if (!target) return false;
    const recorded = readSyncState().memory || {};
    if (inspectMemory(agent).some((m) => join(target.memory, m.name) in recorded && existsSync(join(target.memory, m.name)))) return true;
    return isDir(target.skills) && readdirSync(target.skills)
        .some((e) => isManagedProvider(readSkillMeta(join(target.skills, e)).provider));
}

/**
 * Silently bring EXISTING deployments up to date with the shipped assets, so a
 * package update applies without re-running `enigma install`. For every agent
 * (optionally filtered by name) and scope that already has a deployment: copy
 * new/updated/unsealed skills, prune orphaned and discarded managed skills, and
 * re-render the memory file. Locally-modified (tampered) skills are never overwritten, a memory
 * file is only rewritten when it is byte-identical to what enigma last wrote
 * (isEnigmaWritten), and a first deployment is never created - all of those stay
 * explicit user decisions. Returns one human-readable line per agent+scope that
 * changed, for a brief notice.
 */
export function syncDeployed(agentNames?: string[]): string[] {
    const notices: string[] = [];
    // Discarded and per-agent-off skills are excluded from each agent's source set, so the
    // prune pass in syncTarget removes any deployed copy of them (propagates on every sync).
    const commands = bundledCommands();
    for (const agent of discoverAgents()) {
        if (agentNames && !agentNames.includes(agent.name)) continue;
        const skills = currentSkillSet(agent.name);
        // The /gate command IS carried by the copy loop below (bundledCommands filters it by
        // the toggle), so unlike the wiring re-asserts further down it needs no extra write -
        // only the "did it just arrive" observation, since the loop reports a bare item count
        // and the gate changes how the agent behaves enough to deserve one sentence.
        const gateCommand = agent.targets.global?.commands ? join(agent.targets.global.commands, GATE_COMMAND) : null;
        const gateBefore = gateCommand !== null && existsSync(gateCommand);
        for (const scope of ["global", "local"] as const) {
            const target = agent.targets[scope];
            if (!target || !hasDeployment(agent, scope)) continue;
            const changed = syncTarget(target, inspectMemory(agent), skills, commands, false);
            const mcpChanged = applyMcpForAgent(agent.name, scope);
            if (changed || mcpChanged) notices.push(`${agent.label}: ${changed + (mcpChanged ? 1 : 0)} item(s) updated (${scope})`);
        }
        if (gateCommand !== null && !gateBefore && existsSync(gateCommand)) {
            notices.push("Quality gate is on: once your work is committed the agent validates it (review, tests, docs, lint) before reporting it done. Turn off with 'enigma config gate off', or '/gate off' from the agent.");
        }
        // The completion gate is hook WIRING, not a file this loop copies, so re-assert it
        // here too: an on-by-default gate has to reach an existing deployment (and disappear
        // from it when switched off) without waiting for the next explicit install. Gated on
        // there already being one, so a sync never wires an agent enigma was not installed into.
        // Installing it changes how the agent behaves, so the one time that happens it says so
        // rather than letting the user first meet the gate as an unexplained blocked turn.
        if (agent.name === "claude" && hasDeployment(agent, "global") && applyVerifyWiring() && isVerifyOn()) {
            notices.push("Completion checks are on: when the agent reports work as finished, enigma now verifies that against the change. Turn off with 'enigma config verify off'.");
        }
        // Same reasoning: the status bar is on by default and is settings.json WIRING, not a
        // file the copy loop above touches, so an existing deployment has to pick it up on
        // update rather than only on an explicit install. Gated on the config flag, so a bar
        // the user turned off stays off, and `enableClaudeStatusline` never replaces a custom
        // one - which makes this safe to re-run on every sync.
        if (agent.name === "claude" && hasDeployment(agent, "global") && conf.readConfig().config.statusline
            && enableClaudeStatusline("global")) {
            notices.push("Status bar is on: Claude Code now shows the enigma badge, context and cost, plus live gate progress during a run. Turn off with 'enigma config statusline off'.");
        }
        // Workspace trust, same reasoning again - and this is the path that makes the setting
        // hold for ANY directory: every `enigma <tool>` launch, `enigma update` and the hub's
        // "update now" action come through here, so the workspace being opened gets its own
        // trust entry (what the client requires to skip its permission-grant backstop) without
        // the user ever meeting the prompt. See tests/sync-trust.test.ts. Silent after the first:
        // the notice is gated on the blanket not being in place yet, while the per-workspace
        // entry keeps being added quietly as new directories show up.
        if (agent.name === "claude" && hasDeployment(agent, "global") && conf.readConfig().config.claudeTrust) {
            const firstTime = !getClaudeTrust();
            if (setClaudeTrust(true) && firstTime) {
                notices.push("Workspace trust is pre-answered: Claude Code no longer asks whether you trust a folder. Turn off with 'enigma config claude-trust off'.");
            }
        }
    }
    return notices;
}

/**
 * The skill set to deploy to one agent: every skill except globally-discarded ones and
 * those turned off for this agent. Omit `agentName` for the global non-discarded set.
 */
function currentSkillSet(agentName?: string): SkillEntry[] {
    const discarded = discardedSkillNames();
    const offMap = skillAgentsOffMap();
    return inspectSkills().filter((s) => !discarded.has(s.name) && !(agentName && isSkillOffForAgent(s.name, agentName, offMap)));
}

/**
 * Bring one skills+memory destination up to date with the source set: copy
 * new/updated/unsealed skills, prune orphaned and discarded managed skills, and
 * re-render the memory file. Locally-modified (tampered) skills are never
 * overwritten and an existing memory file is only rewritten when enigma wrote it
 * last (isEnigmaWritten). `createMemory` additionally seeds a missing memory
 * file - only safe for enigma-owned destinations (managed account dirs); the
 * deployment-gated syncs pass false so a first deployment stays an explicit
 * `enigma install`. Returns the number of changed items.
 */
function syncTarget(target: AccountTarget, memory: MemoryEntry[], skills: SkillEntry[], commands: CommandEntry[], createMemory: boolean): number {
    let changed = 0;
    // skillUpdatePolicy governs a locally-edited (tampered) skill on update: "overwrite"
    // (default) replaces it with the shipped version; "keep" preserves the user's edits.
    const keepEdited = conf.readConfig().config.skillUpdatePolicy === "keep";
    if (target.skills) {
        for (const sk of skills) {
            const dest = join(target.skills, sk.name);
            const kind = skillStatus(dest, sk.meta).kind;
            if (kind === "identical") {
                // A config-declaring skill hashes as "identical" even when its rendered value
                // changed (the config block is excluded from the hash), so re-render on drift.
                if (skillConfigDrifted(sk, dest)) {
                    writeFileSync(join(dest, "SKILL.md"), renderSkill(join(sk.src, "SKILL.md"), sk.meta.config));
                    changed++;
                }
                continue;
            }
            if (kind === "tampered" && keepEdited) continue;
            mkdirSync(target.skills, { recursive: true });
            deploySkill(sk.src, dest, sk.meta);
            changed++;
        }
        for (const orphan of computePrune(target.skills, skills.map((s) => s.name))) {
            rmSync(orphan.dir, { recursive: true, force: true });
            changed++;
        }
    }
    for (const m of memory) {
        const dest = join(target.memory, m.name);
        if (existsSync(dest)) {
            if (memoryStatus(m.src, dest) === "identical") continue;
            // A deliberate dashboard edit follows skillUpdatePolicy: keep -> preserve it,
            // overwrite -> restore the managed render. A hand-authored/edited file that
            // enigma never recorded stays untouched (an explicit user decision).
            if (isMemoryEdited(dest)) { if (keepEdited) continue; }
            else if (!isEnigmaWritten(dest)) continue;
        } else if (!createMemory) {
            continue;
        }
        mkdirSync(target.memory, { recursive: true });
        writeMemory(m.src, dest);
        changed++;
    }
    // Commands are enigma-managed and always kept current (replace on drift), matching
    // the conflict policy: a same-named command that is not byte-identical is overwritten.
    if (target.commands) {
        for (const c of commands) {
            const dest = join(target.commands, c.name);
            if (commandStatus(dest, c.src) === "identical") continue;
            mkdirSync(target.commands, { recursive: true });
            writeFileSync(dest, readFileSync(c.src, "utf8"));
            changed++;
        }
    }
    return changed;
}

/**
 * True when a managed account's config dir already holds an enigma deployment:
 * a managed-provider skill in its skills dir, or a memory file enigma recorded
 * writing there. Mirrors `hasDeployment` for account dirs.
 */
export function hasAccountDeployment(toolName: string, dir: string): boolean {
    const target = getTool(toolName).accountTarget(dir);
    const agent = discoverAgents().find((a) => a.name === toolName);
    const recorded = readSyncState().memory || {};
    if (agent && inspectMemory(agent).some((m) => join(target.memory, m.name) in recorded && existsSync(join(target.memory, m.name)))) return true;
    return Boolean(target.skills) && isDir(target.skills!) && readdirSync(target.skills!)
        .some((e) => isManagedProvider(readSkillMeta(join(target.skills!, e)).provider));
}

/**
 * Deploy or refresh enigma's skills, memory and managed agent-native settings
 * into a managed account's config dir - the dir the tool resolves when enigma
 * launches it with the account's config-dir env injected. The dir is
 * enigma-created, so a missing memory file is seeded here (unlike syncDeployed);
 * tampered skills and user-edited memory follow the same never-overwrite rules.
 * Settings (bypass, attribution, statusline, ...) mirror the default account's
 * current posture on every sync. Returns notice lines for display.
 */
export function syncAccount(toolName: string, dir: string): string[] {
    const agent = discoverAgents().find((a) => a.name === toolName);
    if (!agent) return [];
    const target = getTool(toolName).accountTarget(dir);
    const changed = syncTarget(target, inspectMemory(agent), currentSkillSet(toolName), bundledCommands(), true);
    mirrorAccountSettings(toolName, dir);
    mirrorLintWiring(toolName, dir);
    mirrorGuardrailsWiring(toolName, dir);
    mirrorTrimWiring(toolName, dir);
    mirrorVerifyWiring(toolName, dir);
    const mcpChanged = applyMcpForAccount(toolName, dir);
    const total = changed + (mcpChanged ? 1 : 0);
    return total ? [`${agent.label}: ${total} item(s) updated (account)`] : [];
}
