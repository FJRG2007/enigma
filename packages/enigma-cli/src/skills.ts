/**
 * Skill management: discovery, integrity (seal/check), and install planning and
 * execution. Skills are authored once under assets/skills and deployed to every
 * selected agent; the matching memory file comes from assets/memory.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as p from "@clack/prompts";
import { isDir, isNewer, readJson, listFilesRel, computeContentSha } from "./util";
import { readConfig, setEnigmaValue, setSkillDiscarded, OUTPUT_STYLES } from "./config";
import type { OutputStyle } from "./config";
import { MANAGED_PROVIDER, isManagedProvider, discoverAgents, runningStatus } from "./agents";
import type { Agent, AgentTarget, DiscoveredAgent } from "./agents";
import { maybeOfferGitHooks } from "./security";
import type { SecurityOptions } from "./security";
import { clackReporter } from "./reporter";
import type { Reporter } from "./reporter";
import { disableClaudeAttribution, enableClaudeStatusline } from "./claude";
import { setGhTelemetry } from "./github";
import { applyLintWiring, mirrorLintWiring } from "./lint";
import { resolveBypassSelection, applyBypass, mirrorAccountSettings } from "./permissions";
import { getTool } from "./accounts";
import type { AccountTarget } from "./accounts";
import { cachedRemoteSkills, refreshRemoteSkills, shouldCheckRemote } from "./skills-remote";
import type { RemoteRefreshResult } from "./skills-remote";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
// In the compiled binary the assets are not on disk next to the code (they live in
// Bun's virtual fs); the launcher points ENIGMA_ASSETS_DIR at the real assets shipped
// in the main npm package. The __dirname path stays as the dev/tsx fallback.
const ASSETS = process.env.ENIGMA_ASSETS_DIR ?? join(PKG_ROOT, "assets");
export const SKILLS_ROOT = join(ASSETS, "skills");
export const MEMORY_ROOT = join(ASSETS, "memory");

export interface SkillMeta {
    name?: string;
    version?: string;
    provider?: string;
    description?: string;
    cliVersion?: string;
    sha?: string;
}

type StatusKind = "install" | "update" | "identical" | "tampered" | "reinstall";
interface SkillStatus { kind: StatusKind; from: string | null; to: string | null; }

interface SkillEntry { name: string; src: string; meta: SkillMeta; }
interface PlannedSkill extends SkillEntry { status: SkillStatus; overwrite: boolean; }
interface MemoryEntry { name: string; src: string; }
interface PruneEntry { name: string; dir: string; meta: SkillMeta; }
interface PlanItem {
    agent: DiscoveredAgent;
    target: AgentTarget;
    skills: PlannedSkill[];
    memory: MemoryEntry[];
    prune: PruneEntry[];
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
}

/** This CLI package's own version, stamped into skills at seal time. */
function cliVersion(): string {
    return (readJson<{ version?: string }>(join(PKG_ROOT, "package.json")) || {}).version || "0.0.0";
}

/**
 * Serialize skill metadata with a stable key order and exactly one trailing
 * newline (no blank last line). Keeps sealed files diff-friendly.
 */
function serializeMeta(meta: SkillMeta): string {
    const ordered: Record<string, unknown> = {};
    for (const k of ["name", "version", "provider", "description", "cliVersion", "sha"] as const) {
        if (meta[k] !== undefined) ordered[k] = meta[k];
    }
    for (const k of Object.keys(meta)) if (!(k in ordered)) ordered[k] = (meta as Record<string, unknown>)[k];
    return JSON.stringify(ordered, null, 2) + "\n";
}

function readSkillMeta(skillDir: string): SkillMeta {
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
 * Read a source memory file and apply the user's .enigma.json toggles to it:
 * - parallelSubagents off -> strip the parallel sub-agent block (decomposition stays).
 * - outputStyle off -> strip the token-efficient output block; otherwise keep it and
 *   bind {{output-level}} to the chosen level (lite/full/ultra).
 * Everything else is passed through verbatim, preserving the exact trailing newline.
 */
function renderMemory(srcFile: string): string {
    const cfg = readConfig().config;
    let out = readFileSync(srcFile, "utf8");
    if (!cfg.parallelSubagents) out = stripMarkedBlock(out, "parallel-subagents");
    if (cfg.outputStyle === "off") out = stripMarkedBlock(out, "output-style");
    else out = out.replace(/\{\{output-level\}\}/g, cfg.outputStyle);
    return out;
}

/** Compare the toggle-rendered source against the deployed file, not the raw bytes. */
function memoryStatus(srcFile: string, destFile: string): "install" | "identical" | "overwrite" {
    if (!existsSync(destFile)) return "install";
    return readFileSync(destFile, "utf8") === renderMemory(srcFile) ? "identical" : "overwrite";
}

// --- sync state ------------------------------------------------------------
// ~/.enigma/state.json records the sha256 of every memory file enigma writes,
// keyed by absolute destination path. A CLAUDE.md/AGENTS.md existing is NOT
// proof enigma wrote it (users have their own), so auto-sync uses this record
// to distinguish "stale because the package updated" (safe to rewrite) from
// "user-authored or user-edited" (never touched silently).

const STATE_FILE = join(homedir(), ".enigma", "state.json");
interface SyncState { memory?: Record<string, string>; }

const contentHash = (content: string): string => createHash("sha256").update(content).digest("hex");

function readSyncState(): SyncState {
    return readJson<SyncState>(STATE_FILE) || {};
}

function recordMemoryWrite(dest: string, content: string): void {
    const state = readSyncState();
    state.memory = { ...state.memory, [dest]: contentHash(content) };
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
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

/** Skills bundled with this package: every folder with a SKILL.md under assets/skills. */
function bundledSkills(): SkillEntry[] {
    if (!isDir(SKILLS_ROOT)) return [];
    return readdirSync(SKILLS_ROOT)
        .filter((e) => isDir(join(SKILLS_ROOT, e)) && existsSync(join(SKILLS_ROOT, e, "SKILL.md")))
        .map((e) => ({ name: e, src: join(SKILLS_ROOT, e), meta: readSkillMeta(join(SKILLS_ROOT, e)) }));
}

/**
 * The effective skill set used for installs and syncs: the bundled assets,
 * overlaid with any verified GitHub-cached skill that is strictly newer (see
 * skills-remote.ts). The overlay also surfaces skills published to the repo
 * that this package version does not bundle yet.
 */
function inspectSkills(): SkillEntry[] {
    const skills = bundledSkills();
    const remote = cachedRemoteSkills();
    if (!remote.length) return skills;
    const byName = new Map(skills.map((s) => [s.name, s]));
    for (const r of remote) {
        const bundled = byName.get(r.name);
        if (!bundled || isNewer(r.meta.version || "", bundled.meta.version || "")) byName.set(r.name, r);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The set of skill names the user discarded (skipped by installs/updates, pruned everywhere). */
function discardedSkillNames(): Set<string> {
    return new Set(readConfig().config.discardedSkills);
}

export interface SkillInfo { name: string; version: string | null; description: string | null; discarded: boolean; }

/**
 * Every known skill (bundled + remote overlay, discarded included) with its
 * discard state, for the hub's skills section and `enigma skills list`.
 */
export function listSkillsStatus(): SkillInfo[] {
    const discarded = discardedSkillNames();
    return inspectSkills().map((s) => ({
        name: s.name,
        version: s.meta.version || null,
        description: s.meta.description || null,
        discarded: discarded.has(s.name),
    }));
}

/**
 * Discard or restore a skill and apply it to disk immediately: the discard state
 * is recorded in the global .enigma.json, then syncDeployed prunes the skill from
 * every existing deployment (discard) or re-installs it there (restore). Returns
 * the sync notices for display.
 */
export function discardSkill(name: string, discarded: boolean): string[] {
    setSkillDiscarded(name, discarded);
    return syncDeployed();
}

/**
 * Refresh the GitHub remote-skill cache (see skills-remote.ts), feeding it this
 * package's bundled versions so only strictly newer releases are adopted. Safe
 * to call from anywhere: never throws, never blocks beyond its fetch timeouts.
 */
export async function refreshSkillsFromGitHub(force = false): Promise<RemoteRefreshResult> {
    const bundledVersions: Record<string, string> = {};
    for (const s of bundledSkills()) if (s.meta.version) bundledVersions[s.name] = s.meta.version;
    return refreshRemoteSkills({ force, bundledVersions });
}

export { shouldCheckRemote };

/** The single shared memory file an agent uses (from assets/memory), if present. */
function inspectMemory(agent: Agent): MemoryEntry[] {
    if (!agent.memoryFile) return [];
    const src = join(MEMORY_ROOT, agent.memoryFile);
    return existsSync(src) ? [{ name: agent.memoryFile, src }] : [];
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

/** (Re)compute each source skill's content hash into its skill.json. */
export function sealSources(): void {
    if (!isDir(SKILLS_ROOT)) { console.error(`No skills directory found at ${SKILLS_ROOT}.`); process.exit(1); }
    const cli = cliVersion();
    let sealed = 0;
    for (const name of readdirSync(SKILLS_ROOT)) {
        const dir = join(SKILLS_ROOT, name);
        if (!isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
        const metaPath = join(dir, "skill.json");
        const meta = readJson<SkillMeta>(metaPath) || { name };
        const before = JSON.stringify(meta);
        // Auto-managed fields (never hand-written): canonical provider, the version
        // of the CLI doing the seal, and the content hash.
        meta.provider = MANAGED_PROVIDER;
        meta.cliVersion = cli;
        meta.sha = computeContentSha(dir);
        const changed = JSON.stringify(meta) !== before;
        writeFileSync(metaPath, serializeMeta(meta));
        console.log(`${changed ? "updated" : "ok     "}  ${name}  cli=${cli}  sha=${meta.sha.slice(0, 12)}`);
        sealed++;
    }
    const cited = citationVersion();
    if (cited !== null && cited !== cli) {
        const cff = readFileSync(CITATION_PATH, "utf8");
        writeFileSync(CITATION_PATH, cff.replace(/^version:[ \t]*\S+[ \t]*$/m, `version: ${cli}`));
        console.log(`updated  CITATION.cff  version ${cited} -> ${cli}`);
    }
    console.log(`\nSealed ${sealed} skill(s) at cliVersion ${cli}.`);
}

/**
 * Integrity gate (CI/pre-commit): verify each source skill is well-formed and
 * sealed. Exits non-zero on any problem.
 */
export function checkSources(): void {
    if (!isDir(SKILLS_ROOT)) { console.error(`No skills directory found at ${SKILLS_ROOT}.`); process.exit(1); }
    const cli = cliVersion();
    const problems: string[] = [];
    let checked = 0;
    for (const name of readdirSync(SKILLS_ROOT)) {
        const dir = join(SKILLS_ROOT, name);
        if (!isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
        checked++;
        const md = readFileSync(join(dir, "SKILL.md"), "utf8");
        const fm = md.match(/^---\n([\s\S]*?)\n---/);
        if (!fm) problems.push(`${name}: SKILL.md is missing YAML frontmatter`);
        else {
            if (!/^name:\s*\S/m.test(fm[1]!)) problems.push(`${name}: frontmatter missing 'name'`);
            if (!/^description:\s*\S/m.test(fm[1]!)) problems.push(`${name}: frontmatter missing 'description'`);
        }
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
    if (style && !OUTPUT_STYLES.includes(style as OutputStyle)) {
        reporter.warn(`Ignoring --output-style '${opts.outputStyle}': use one of ${OUTPUT_STYLES.join(", ")}.`);
        style = null;
    }
    if (!style && interactive && !opts.dryRun) {
        const r = await p.select({
            message: "Token-efficient output? (compress chat prose; code/commits/PRs stay normal)",
            options: [
                { value: "off", label: "Off", hint: "full prose (default)" },
                { value: "lite", label: "Lite", hint: "professional terse - drop filler, keep grammar" },
                { value: "full", label: "Full", hint: "drop articles and use fragments (most compressed)" },
                { value: "ultra", label: "Ultra", hint: "telegraphic, maximum compression" },
            ],
            initialValue: readConfig().config.outputStyle,
        });
        if (p.isCancel(r)) return;          // keep the current value; do not abort the whole install
        style = r as string;
    }
    if (style && !opts.dryRun && style !== readConfig().config.outputStyle) {
        setEnigmaValue("outputStyle", style, scope);
        reporter.info(`Token-efficient output: ${style} (${scope}).`);
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

    // Refresh the GitHub skill cache first so the plan below uses the newest
    // published skills, not only the ones bundled with this package version.
    // Strictly best-effort: any failure falls back to bundled/cached skills.
    if (shouldCheckRemote(false)) {
        const sp = reporter.spinner();
        sp.start("Checking GitHub for skill updates...");
        const r = await refreshSkillsFromGitHub();
        if (r.error) sp.stop(`Skill update check failed (${r.error}); using bundled skills.`);
        else if (r.updated.length) sp.stop(`Skill update(s) from GitHub: ${r.updated.join(", ")}.`);
        else sp.stop("Skills are up to date with GitHub.");
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
        if (enableClaudeStatusline(claudeScope)) {
            reporter.info("Claude Code: statusline shows an [ENIGMA] badge while token-efficient output is active.");
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
    };

    // Optional, opt-in: disable each chosen agent's per-action approval prompts.
    // Asked here (right after agent selection) so it is grouped with that choice.
    const bypassAgents = await resolveBypassSelection(chosenAgents, opts, interactive);
    const applyBypassConfig = (): void => applyBypass(bypassAgents, scope, opts.dryRun);

    // Auto-lint: re-assert the post-write hook wiring to match the toggle (adds it
    // when on, removes it when off). No-op and cheap when off; on enable the linter
    // install runs in the background. Skipped on a dry run (writes nothing).
    const applyLintConfig = (): void => { if (!opts.dryRun) applyLintWiring(); };

    // Output-compression level (memory section). Resolved before the plan so memoryStatus
    // and the deployed content reflect it. Irrelevant when only skills are installed.
    if (!opts.skillsOnly) await resolveOutputStyle(opts, scope, interactive, reporter);

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
        const skills = inspectSkills().filter((s) => !discarded.has(s.name));
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
            .filter((e) => opts.prune || discarded.has(e.name));

        plan.push({ agent, target, skills: skillsWithStatus, memory: opts.skillsOnly ? [] : memory, prune });
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
            const reason = discarded.has(s.name) ? "remove (discarded)" : "remove (orphaned)";
            lines.push(`  ${reason.padEnd(26)} skill   ${s.name}  [${s.meta.provider}${ver}]`);
        }
    }

    if (nInstall + nUpdate + nRemove === 0) {
        reporter.note(lines.join("\n"), "Nothing to do");
        applyClaudeConfig();
        applyGhConfig();
        applyBypassConfig();
        applyLintConfig();
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
        x.prune.length > 0
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
                cpSync(sk.src, join(x.target.skills, sk.name), { recursive: true, force: true });
                copied++;
            }
            for (const m of x.memory) {
                if (memoryStatus(m.src, join(x.target.memory, m.name)) === "identical") continue;
                writeMemory(m.src, join(x.target.memory, m.name));
                copied++;
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
    // Discarded skills are excluded from the source set, so the prune pass below
    // removes any deployed copy of them (a discard propagates on every sync).
    const skills = currentSkillSet();
    for (const agent of discoverAgents()) {
        if (agentNames && !agentNames.includes(agent.name)) continue;
        for (const scope of ["global", "local"] as const) {
            const target = agent.targets[scope];
            if (!target || !hasDeployment(agent, scope)) continue;
            const changed = syncTarget(target, inspectMemory(agent), skills, false);
            if (changed) notices.push(`${agent.label}: ${changed} item(s) updated (${scope})`);
        }
    }
    return notices;
}

/** The effective non-discarded skill set used by every sync. */
function currentSkillSet(): SkillEntry[] {
    const discarded = discardedSkillNames();
    return inspectSkills().filter((s) => !discarded.has(s.name));
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
function syncTarget(target: AccountTarget, memory: MemoryEntry[], skills: SkillEntry[], createMemory: boolean): number {
    let changed = 0;
    if (target.skills) {
        for (const sk of skills) {
            const dest = join(target.skills, sk.name);
            const kind = skillStatus(dest, sk.meta).kind;
            if (kind === "identical" || kind === "tampered") continue;
            mkdirSync(target.skills, { recursive: true });
            cpSync(sk.src, dest, { recursive: true, force: true });
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
            // Only rewrite a memory file enigma wrote and the user has not
            // touched since; a user-edited or user-authored file stays as-is.
            if (memoryStatus(m.src, dest) === "identical" || !isEnigmaWritten(dest)) continue;
        } else if (!createMemory) {
            continue;
        }
        mkdirSync(target.memory, { recursive: true });
        writeMemory(m.src, dest);
        changed++;
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
    const changed = syncTarget(target, inspectMemory(agent), currentSkillSet(), true);
    mirrorAccountSettings(toolName, dir);
    mirrorLintWiring(toolName, dir);
    return changed ? [`${agent.label}: ${changed} item(s) updated (account)`] : [];
}
