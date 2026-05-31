/**
 * Skill management: discovery, integrity (seal/check), and install planning and
 * execution. Skills are authored once under assets/skills and deployed to every
 * selected agent; the matching memory file comes from assets/memory.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as p from "@clack/prompts";
import { isDir, readJson } from "./util";
import { MANAGED_PROVIDER, isManagedProvider, discoverAgents, runningStatus } from "./agents";
import type { Agent, AgentTarget, DiscoveredAgent } from "./agents";
import { maybeOfferGitHooks } from "./security";
import type { SecurityOptions } from "./security";
import { disableClaudeAttribution } from "./claude";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const ASSETS = join(PKG_ROOT, "assets");
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

/** List file paths under `dir` relative to it, posix-normalized. */
function listFilesRel(dir: string, base: string = dir): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (isDir(full)) out.push(...listFilesRel(full, base));
        else out.push(relative(base, full).split(sep).join("/"));
    }
    return out;
}

/** Deterministic sha256 over every file in a skill EXCEPT skill.json (which carries it). */
function computeContentSha(dir: string): string {
    const files = listFilesRel(dir).filter((f) => f !== "skill.json").sort();
    const h = createHash("sha256");
    for (const f of files) {
        h.update(f); h.update("\0");
        h.update(readFileSync(join(dir, f))); h.update("\0");
    }
    return h.digest("hex");
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

function filesEqual(a: string, b: string): boolean {
    try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}
function memoryStatus(srcFile: string, destFile: string): "install" | "identical" | "overwrite" {
    if (!existsSync(destFile)) return "install";
    return filesEqual(srcFile, destFile) ? "identical" : "overwrite";
}

function computePrune(destSkillsDir: string, sourceNames: string[]): PruneEntry[] {
    if (!isDir(destSkillsDir)) return [];
    return readdirSync(destSkillsDir)
        .filter((e) => isDir(join(destSkillsDir, e)) && existsSync(join(destSkillsDir, e, "SKILL.md")))
        .filter((e) => !sourceNames.includes(e))
        .map((e) => ({ name: e, dir: join(destSkillsDir, e), meta: readSkillMeta(join(destSkillsDir, e)) }))
        .filter((s) => isManagedProvider(s.meta.provider));
}

/** Shared skills: every folder with a SKILL.md under assets/skills. */
function inspectSkills(): SkillEntry[] {
    if (!isDir(SKILLS_ROOT)) return [];
    return readdirSync(SKILLS_ROOT)
        .filter((e) => isDir(join(SKILLS_ROOT, e)) && existsSync(join(SKILLS_ROOT, e, "SKILL.md")))
        .map((e) => ({ name: e, src: join(SKILLS_ROOT, e), meta: readSkillMeta(join(SKILLS_ROOT, e)) }));
}

/** The single shared memory file an agent uses (from assets/memory), if present. */
function inspectMemory(agent: Agent): MemoryEntry[] {
    if (!agent.memoryFile) return [];
    const src = join(MEMORY_ROOT, agent.memoryFile);
    return existsSync(src) ? [{ name: agent.memoryFile, src }] : [];
}

// --- maintenance: seal + check -------------------------------------------------

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
    if (problems.length) {
        console.error(`Integrity check FAILED (${problems.length} problem(s) across ${checked} skill(s)):`);
        for (const pr of problems) console.error(`  - ${pr}`);
        process.exit(1);
    }
    console.log(`Integrity check passed: ${checked} skill(s) well-formed and sealed.`);
}

// --- install -------------------------------------------------------------------

/** Plan and apply a skills install. Prints progress via clack. */
export async function installSkills(opts: InstallOptions, interactive: boolean): Promise<void> {
    const available = discoverAgents();
    if (available.length === 0) {
        p.cancel("No installable agents known.");
        process.exit(1);
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
        if (unknown.length) p.log.warn(`Skipping unknown/absent agents: ${unknown.join(", ")}`);
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
        p.log.warn("No installed agents detected; defaulting to all supported agents.");
    }

    if (chosenAgents.length === 0) { p.cancel("No matching agents selected."); process.exit(1); }

    // Claude-specific: disable the Co-Authored-By/PR attribution deterministically
    // whenever Claude Code is a target (commits stay attributed solely to the user).
    const claudeScope = chosenAgents.some((a) => a.name === "claude") ? scope : null;
    const applyClaudeConfig = (): void => {
        if (!claudeScope || opts.dryRun) return;
        if (disableClaudeAttribution(claudeScope)) {
            p.log.info("Claude Code: disabled Co-Authored-By and PR attribution in settings.json.");
        }
    };

    // --- build the plan per agent ---
    const plan: PlanItem[] = [];
    for (const agent of chosenAgents) {
        const target = agent.targets[scope];
        if (!target) { p.log.warn(`${agent.label} has no '${scope}' target - skipping.`); continue; }
        const skills = inspectSkills();
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
        const prune = opts.prune && !opts.memoryOnly
            ? computePrune(target.skills, skills.map((s) => s.name))
            : [];

        plan.push({ agent, target, skills: skillsWithStatus, memory: opts.skillsOnly ? [] : memory, prune });
    }

    // --- locally-modified (tampered) skills ---
    const tampered = plan.flatMap((x) => x.skills.filter((s) => s.status.kind === "tampered"));
    if (tampered.length) {
        if (opts.keepModified) {
            for (const s of tampered) s.overwrite = false;
            p.log.warn(`${tampered.length} locally-modified skill(s) will be kept (--keep-modified).`);
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
            lines.push(`  ${"remove (orphaned)".padEnd(26)} skill   ${s.name}  [${s.meta.provider}${ver}]`);
        }
    }

    if (nInstall + nUpdate + nRemove === 0) {
        p.note(lines.join("\n"), "Nothing to do");
        applyClaudeConfig();
        await maybeOfferGitHooks(interactive, opts);
        p.log.success(`Everything up-to-date - ${nSkip} item(s) unchanged${nKept ? `, ${nKept} kept modified` : ""} (${scope}).`);
        return;
    }

    p.note(lines.join("\n"), opts.dryRun ? "Dry run - planned changes" : "Planned changes");

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

    if (opts.dryRun) { p.log.info("Dry run complete - no files written."); return; }

    // Which agents actually receive changes (computed before writing, since
    // memoryStatus flips to "identical" once files are copied). Used for the
    // restart notice below.
    const changedAgents = plan.filter((x) =>
        x.skills.some(willCopy) ||
        x.memory.some((m) => memoryStatus(m.src, join(x.target.memory, m.name)) !== "identical") ||
        x.prune.length > 0
    );

    const s = p.spinner();
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
                cpSync(m.src, join(x.target.memory, m.name), { force: true });
                copied++;
            }
            for (const pr of x.prune) rmSync(pr.dir, { recursive: true, force: true });
        }
    } catch (err) {
        s.stop("Failed.");
        p.cancel(`Error while installing: ${(err as Error).message}`);
        process.exit(1);
    }
    s.stop(`Wrote ${copied} item(s)${nRemove ? `, removed ${nRemove}` : ""}.`);
    applyClaudeConfig();
    await maybeOfferGitHooks(interactive, opts);
    p.log.success(`${nInstall} installed, ${nUpdate} updated/overwritten` +
        (nRemove ? `, ${nRemove} removed` : "") + (nSkip ? `, ${nSkip} unchanged` : "") +
        (nKept ? `, ${nKept} kept modified` : "") + ` (${scope}).`);

    // Agents load skills/memory at startup, so changes only take effect on a fresh
    // session. Tell the user to restart the affected agents that are running; if we
    // cannot read the process list, fall back to a conditional note.
    if (changedAgents.length) {
        const { known, running } = runningStatus(changedAgents.map((x) => x.agent));
        if (running.size) {
            const names = changedAgents.filter((x) => running.has(x.agent.name)).map((x) => x.agent.label);
            p.log.warn(`Restart ${names.join(", ")} to apply the changes (running now).`);
        } else if (!known) {
            const names = changedAgents.map((x) => x.agent.label);
            p.log.info(`If any of these agents are running, restart them to apply the changes: ${names.join(", ")}.`);
        }
    }
}
