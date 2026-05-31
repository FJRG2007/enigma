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
import { isDir, readJson } from "./util.mjs";
import { MANAGED_PROVIDER, discoverAgents, runningStatus } from "./agents.mjs";
import { maybeOfferGitHooks } from "./security.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "..", "assets");
export const SKILLS_ROOT = join(ASSETS, "skills");
export const MEMORY_ROOT = join(ASSETS, "memory");

// --- metadata + hashing --------------------------------------------------------

function readSkillMeta(skillDir) {
  return readJson(join(skillDir, "skill.json")) || {};
}

/** List file paths under `dir` relative to it, posix-normalized. */
function listFilesRel(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (isDir(full)) out.push(...listFilesRel(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/** Deterministic sha256 over every file in a skill EXCEPT skill.json (which carries it). */
function computeContentSha(dir) {
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
function skillStatus(destDir, srcMeta) {
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

function statusLabel(st) {
  switch (st.kind) {
    case "install": return st.to ? `install v${st.to}` : "install";
    case "update": return `update ${st.from} -> ${st.to}`;
    case "identical": return st.to ? `up-to-date v${st.to} (skip)` : "up-to-date (skip)";
    case "tampered": return st.to ? `MODIFIED locally v${st.to}` : "MODIFIED locally";
    default: return st.to ? `reinstall v${st.to}` : "reinstall";
  }
}

function filesEqual(a, b) {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}
function memoryStatus(srcFile, destFile) {
  if (!existsSync(destFile)) return "install";
  return filesEqual(srcFile, destFile) ? "identical" : "overwrite";
}

function computePrune(destSkillsDir, sourceNames) {
  if (!isDir(destSkillsDir)) return [];
  return readdirSync(destSkillsDir)
    .filter((e) => isDir(join(destSkillsDir, e)) && existsSync(join(destSkillsDir, e, "SKILL.md")))
    .filter((e) => !sourceNames.includes(e))
    .map((e) => ({ name: e, dir: join(destSkillsDir, e), meta: readSkillMeta(join(destSkillsDir, e)) }))
    .filter((s) => s.meta.provider === MANAGED_PROVIDER);
}

/** Shared skills: every folder with a SKILL.md under assets/skills. */
function inspectSkills() {
  if (!isDir(SKILLS_ROOT)) return [];
  return readdirSync(SKILLS_ROOT)
    .filter((e) => isDir(join(SKILLS_ROOT, e)) && existsSync(join(SKILLS_ROOT, e, "SKILL.md")))
    .map((e) => ({ name: e, src: join(SKILLS_ROOT, e), meta: readSkillMeta(join(SKILLS_ROOT, e)) }));
}

/** The single shared memory file an agent uses (from assets/memory), if present. */
function inspectMemory(agent) {
  if (!agent.memoryFile) return [];
  const src = join(MEMORY_ROOT, agent.memoryFile);
  return existsSync(src) ? [{ name: agent.memoryFile, src }] : [];
}

// --- maintenance: seal + check -------------------------------------------------

/** (Re)compute each source skill's content hash into its skill.json. */
export function sealSources() {
  if (!isDir(SKILLS_ROOT)) { console.error(`No skills directory found at ${SKILLS_ROOT}.`); process.exit(1); }
  let sealed = 0;
  for (const name of readdirSync(SKILLS_ROOT)) {
    const dir = join(SKILLS_ROOT, name);
    if (!isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
    const metaPath = join(dir, "skill.json");
    const meta = readJson(metaPath) || { name, provider: MANAGED_PROVIDER };
    const sha = computeContentSha(dir);
    const changed = meta.sha !== sha;
    meta.sha = sha;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    console.log(`${changed ? "updated" : "ok     "}  ${name}  sha=${sha.slice(0, 12)}`);
    sealed++;
  }
  console.log(`\nSealed ${sealed} skill(s).`);
}

/**
 * Integrity gate (CI/pre-commit): verify each source skill is well-formed and
 * sealed. Exits non-zero on any problem. Catches the silent-drift bug where a
 * SKILL.md is edited but seal was not re-run, leaving a stale sha.
 */
export function checkSources() {
  if (!isDir(SKILLS_ROOT)) { console.error(`No skills directory found at ${SKILLS_ROOT}.`); process.exit(1); }
  const problems = [];
  let checked = 0;
  for (const name of readdirSync(SKILLS_ROOT)) {
    const dir = join(SKILLS_ROOT, name);
    if (!isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
    checked++;
    const md = readFileSync(join(dir, "SKILL.md"), "utf8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) problems.push(`${name}: SKILL.md is missing YAML frontmatter`);
    else {
      if (!/^name:\s*\S/m.test(fm[1])) problems.push(`${name}: frontmatter missing 'name'`);
      if (!/^description:\s*\S/m.test(fm[1])) problems.push(`${name}: frontmatter missing 'description'`);
    }
    const metaPath = join(dir, "skill.json");
    if (!existsSync(metaPath)) { problems.push(`${name}: missing skill.json`); continue; }
    const meta = readJson(metaPath);
    if (!meta) { problems.push(`${name}: skill.json is not valid JSON`); continue; }
    if (meta.provider !== MANAGED_PROVIDER) problems.push(`${name}: skill.json provider is not ${MANAGED_PROVIDER}`);
    if (!meta.version) problems.push(`${name}: skill.json missing 'version'`);
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

/**
 * Plan and apply a skills install. `opts` mirrors the parsed CLI flags
 * (scope, agents, allAgents, skills, skillsOnly, memoryOnly, prune,
 * keepModified, dryRun). Returns nothing; prints progress via clack.
 */
export async function installSkills(opts, interactive) {
  const available = discoverAgents();
  if (available.length === 0) {
    p.cancel(`No installable agents known.`);
    process.exit(1);
  }

  // --- scope ---
  let scope = opts.scope;
  if (!scope) {
    if (interactive) {
      const r = await p.select({
        message: "Where should skills be installed?",
        options: [
          { value: "global", label: "Global (user)", hint: "~/.claude, ~/.codex, ~/.config/opencode" },
          { value: "local", label: "Local (this project)", hint: process.cwd() },
        ],
      });
      if (p.isCancel(r)) { p.cancel("Aborted."); return; }
      scope = r;
    } else {
      scope = "global";
    }
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
    chosenAgents = available.filter((a) => r.includes(a.name));
  } else if (detected.length) {
    chosenAgents = detected;
  } else {
    chosenAgents = available;
    p.log.warn("No installed agents detected; defaulting to all supported agents.");
  }

  if (chosenAgents.length === 0) { p.cancel("No matching agents selected."); process.exit(1); }

  // --- build the plan per agent ---
  const plan = [];
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
      chosenSkills = skills.filter((s) => r.includes(s.name));
    }

    const skillsWithStatus = (opts.memoryOnly ? [] : chosenSkills).map((s) => ({
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
      tampered.forEach((s, i) => { s.overwrite = sel.includes(i); });
    }
  }

  const willCopy = (s) =>
    s.status.kind === "install" || s.status.kind === "update" ||
    s.status.kind === "reinstall" || (s.status.kind === "tampered" && s.overwrite);

  // --- preview + counts ---
  let nInstall = 0, nUpdate = 0, nRemove = 0, nSkip = 0, nKept = 0;
  const lines = [];
  for (const x of plan) {
    lines.push(`${x.agent.label}  (${scope})`);
    for (const s of x.skills) {
      const prov = s.meta.provider ? `  [${s.meta.provider}]` : "";
      let label;
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
    p.cancel(`Error while installing: ${err.message}`);
    process.exit(1);
  }
  s.stop(`Wrote ${copied} item(s)${nRemove ? `, removed ${nRemove}` : ""}.`);
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
