#!/usr/bin/env node
/**
 * Install / update AI agent skills globally (user level) or locally (project)
 * into each agent's standard config location, with a single command.
 *
 * Source layout (repo `skills/` dir):
 *   skills/<agent>/<skill-name>/SKILL.md   -> a skill
 *   skills/<agent>/*.md                     -> memory/instruction files (CLAUDE.md, AGENTS.md, ...)
 *
 * Usage (interactive):
 *   npx @tpeoficial/skills
 *
 * Usage (single command, non-interactive):
 *   npx @tpeoficial/skills --global --all --yes
 *   npx @tpeoficial/skills --local --agent claude --skill git-policy --yes
 */

import { existsSync, readdirSync, statSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as p from "@clack/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");
const HOME = homedir();

/**
 * Skills we manage. On update, an installed skill that no longer exists in the
 * source is pruned ONLY if its destination skill.json declares this provider —
 * so we never delete skills authored by the user or other providers.
 */
const MANAGED_PROVIDER = "FJRG2007";

/**
 * Per-agent install targets. `skills` is where skill folders land,
 * `memory` is where root-level *.md instruction files land.
 * Paths are resolved at runtime; `null` means "not supported for this scope".
 */
const AGENTS = {
  claude: {
    label: "Claude Code",
    targets: {
      global: { skills: join(HOME, ".claude", "skills"), memory: join(HOME, ".claude") },
      local: { skills: join(process.cwd(), ".claude", "skills"), memory: process.cwd() },
    },
  },
  codex: {
    label: "OpenAI Codex",
    targets: {
      global: { skills: join(HOME, ".codex", "skills"), memory: join(HOME, ".codex") },
      local: { skills: join(process.cwd(), ".codex", "skills"), memory: process.cwd() },
    },
  },
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    scope: null, // "global" | "local"
    agents: [], // [] => all discovered
    skills: [], // [] => all
    skillsOnly: false,
    memoryOnly: false,
    prune: true,
    keepModified: false,
    seal: false,
    yes: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-g": case "--global": opts.scope = "global"; break;
      case "-l": case "--local": opts.scope = "local"; break;
      case "-a": case "--agent": opts.agents.push(...next().split(",")); break;
      case "-s": case "--skill": opts.skills.push(...next().split(",")); break;
      case "--all": opts.agents = []; opts.skills = []; break;
      case "--skills-only": opts.skillsOnly = true; break;
      case "--memory-only": opts.memoryOnly = true; break;
      case "--no-prune": opts.prune = false; break;
      case "--prune": opts.prune = true; break;
      case "--keep-modified": opts.keepModified = true; break;
      case "--seal": opts.seal = true; break;
      case "-y": case "--yes": opts.yes = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown option: ${a}`);
          process.exit(1);
        }
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
skills — install/update AI agent skills globally or locally

Usage:
  skills [options]

Options:
  -g, --global         Install at user level (~/.claude, ~/.codex, ...)
  -l, --local          Install into the current project (.claude, .codex, ...)
  -a, --agent <name>   Target agent(s): comma-separated or repeated (default: all)
  -s, --skill <name>   Skill(s) to install: comma-separated or repeated (default: all)
      --skills-only    Only skill folders (skip CLAUDE.md / AGENTS.md memory files)
      --memory-only    Only memory files (skip skill folders)
      --no-prune       Do NOT remove orphaned skills (default: prune our own)
      --keep-modified  Don't overwrite locally-modified (tampered) skills
      --seal           Maintenance: (re)compute content sha into source skill.json
  -y, --yes            Non-interactive; accept defaults / provided flags
      --dry-run        Show what would happen without writing
  -h, --help           Show this help

Examples:
  skills                                  # interactive
  skills --global --all --yes             # install everything for every agent, globally
  skills --local --agent claude --yes     # install all claude skills into this project
  skills -g -a claude -s git-policy -y    # one skill, globally
  skills --seal                           # refresh integrity hashes before publishing
`);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
function isDir(pth) {
  try { return statSync(pth).isDirectory(); } catch { return false; }
}

/**
 * Metadata convention: a sidecar `skill.json` next to each `SKILL.md`.
 * The agent harness only loads SKILL.md, so this file is never read by the AI.
 * Holds version, provider, and any extra metadata.
 */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
function readSkillMeta(skillDir) {
  return readJson(join(skillDir, "skill.json")) || {};
}

/** List file paths under `dir` relative to it, posix-normalized, excluding skill.json. */
function listFilesRel(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (isDir(full)) out.push(...listFilesRel(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/**
 * Content hash of a skill: deterministic sha256 over every file (path + bytes)
 * EXCEPT skill.json itself (which carries the hash). Used to detect whether an
 * installed skill was modified locally vs the version that was installed.
 */
function computeContentSha(dir) {
  const files = listFilesRel(dir).filter((f) => f !== "skill.json").sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Decide what should happen to a skill at `destDir`:
 *   install   — not present in destination
 *   update    — destination version differs from source version
 *   identical — same version AND destination untouched (skip; not an update)
 *   tampered  — same version BUT destination content changed since install
 *   reinstall — same version, no recorded hash to compare (legacy install)
 */
function skillStatus(destDir, srcMeta) {
  if (!existsSync(destDir)) return { kind: "install", from: null, to: srcMeta.version || null };
  const destMeta = readSkillMeta(destDir);
  const from = destMeta.version || null;
  const to = srcMeta.version || null;
  if (from && to && from !== to) return { kind: "update", from, to };
  // Same (or unknown) version → trust the integrity hash to optimize / detect tampering.
  const recordedSha = destMeta.sha || null;
  if (!recordedSha) return { kind: "reinstall", from, to };
  const actualSha = computeContentSha(destDir);
  if (actualSha !== recordedSha) return { kind: "tampered", from, to, recordedSha, actualSha };
  return { kind: "identical", from, to };
}
function statusLabel(st) {
  switch (st.kind) {
    case "install": return st.to ? `install v${st.to}` : "install";
    case "update": return `update ${st.from} → ${st.to}`;
    case "identical": return st.to ? `up-to-date v${st.to} (skip)` : "up-to-date (skip)";
    case "tampered": return st.to ? `MODIFIED locally v${st.to}` : "MODIFIED locally";
    default: return st.to ? `reinstall v${st.to}` : "reinstall";
  }
}
/** Compare two files byte-for-byte. */
function filesEqual(a, b) {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}
/** Status for a memory file: install (new) / identical (skip) / overwrite (changed). */
function memoryStatus(srcFile, destFile) {
  if (!existsSync(destFile)) return "install";
  return filesEqual(srcFile, destFile) ? "identical" : "overwrite";
}

/**
 * Orphaned skills to prune: installed in `destSkillsDir` but absent from the
 * source `sourceNames`, and owned by us (dest skill.json provider matches).
 */
function computePrune(destSkillsDir, sourceNames) {
  if (!isDir(destSkillsDir)) return [];
  return readdirSync(destSkillsDir)
    .filter((e) => isDir(join(destSkillsDir, e)) && existsSync(join(destSkillsDir, e, "SKILL.md")))
    .filter((e) => !sourceNames.includes(e))
    .map((e) => ({ name: e, dir: join(destSkillsDir, e), meta: readSkillMeta(join(destSkillsDir, e)) }))
    .filter((s) => s.meta.provider === MANAGED_PROVIDER);
}

/**
 * Maintenance: (re)compute each source skill's content hash and write it into
 * its skill.json. Run before publishing so destinations can later detect drift.
 */
function sealSources() {
  if (!isDir(SKILLS_ROOT)) { console.error("No skills/ directory found."); process.exit(1); }
  let sealed = 0;
  for (const agent of readdirSync(SKILLS_ROOT).filter((a) => isDir(join(SKILLS_ROOT, a)))) {
    const agentDir = join(SKILLS_ROOT, agent);
    for (const name of readdirSync(agentDir)) {
      const dir = join(agentDir, name);
      if (!isDir(dir) || !existsSync(join(dir, "SKILL.md"))) continue;
      const metaPath = join(dir, "skill.json");
      const meta = readJson(metaPath) || { name, provider: MANAGED_PROVIDER };
      const sha = computeContentSha(dir);
      const changed = meta.sha !== sha;
      meta.sha = sha;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      console.log(`${changed ? "updated" : "ok     "}  ${agent}/${name}  sha=${sha.slice(0, 12)}…`);
      sealed++;
    }
  }
  console.log(`\nSealed ${sealed} skill(s).`);
}

/** Discover agents present in skills/ that we know how to install. */
function discoverAgents() {
  if (!isDir(SKILLS_ROOT)) return [];
  return readdirSync(SKILLS_ROOT)
    .filter((name) => isDir(join(SKILLS_ROOT, name)))
    .filter((name) => AGENTS[name])
    .map((name) => ({ name, dir: join(SKILLS_ROOT, name), ...AGENTS[name] }));
}

/** For an agent dir, return its skills (folders with SKILL.md) and memory files (root *.md). */
function inspectAgent(agentDir) {
  const entries = readdirSync(agentDir);
  const skills = entries
    .filter((e) => isDir(join(agentDir, e)) && existsSync(join(agentDir, e, "SKILL.md")))
    .map((e) => {
      const src = join(agentDir, e);
      return { name: e, src, meta: readSkillMeta(src) };
    });
  const memory = entries
    .filter((e) => e.toLowerCase().endsWith(".md") && statSync(join(agentDir, e)).isFile())
    .map((e) => ({ name: e, src: join(agentDir, e) }));
  return { skills, memory };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  if (opts.seal) { sealSources(); return; }

  const interactive = process.stdout.isTTY && !opts.yes;

  p.intro("📦 skills — installer");

  const available = discoverAgents();
  if (available.length === 0) {
    p.cancel(`No installable agents found under ${relative(process.cwd(), SKILLS_ROOT) || SKILLS_ROOT}`);
    process.exit(1);
  }

  // --- scope ---
  let scope = opts.scope;
  if (!scope) {
    if (interactive) {
      const r = await p.select({
        message: "Where should skills be installed?",
        options: [
          { value: "global", label: "Global (user)", hint: `~/.claude, ~/.codex …` },
          { value: "local", label: "Local (this project)", hint: `${process.cwd()}` },
        ],
      });
      if (p.isCancel(r)) return p.cancel("Aborted.");
      scope = r;
    } else {
      scope = "global"; // sensible default for --yes
    }
  }

  // --- agents ---
  let chosenAgents = available;
  if (opts.agents.length) {
    chosenAgents = available.filter((a) => opts.agents.includes(a.name));
    const unknown = opts.agents.filter((n) => !available.some((a) => a.name === n));
    if (unknown.length) p.log.warn(`Skipping unknown/absent agents: ${unknown.join(", ")}`);
  } else if (interactive && available.length > 1) {
    const r = await p.multiselect({
      message: "Which agents?",
      options: available.map((a) => ({ value: a.name, label: a.label, hint: a.name })),
      initialValues: available.map((a) => a.name),
      required: true,
    });
    if (p.isCancel(r)) return p.cancel("Aborted.");
    chosenAgents = available.filter((a) => r.includes(a.name));
  }

  if (chosenAgents.length === 0) {
    p.cancel("No matching agents selected.");
    process.exit(1);
  }

  // --- build the plan per agent (skills + memory, filtered) ---
  const plan = [];
  for (const agent of chosenAgents) {
    const target = agent.targets[scope];
    if (!target) {
      p.log.warn(`${agent.label} has no '${scope}' target — skipping.`);
      continue;
    }
    const { skills, memory } = inspectAgent(agent.dir);

    let chosenSkills = skills;
    if (!opts.memoryOnly && opts.skills.length) {
      chosenSkills = skills.filter((s) => opts.skills.includes(s.name));
    } else if (!opts.memoryOnly && interactive && skills.length > 1) {
      const r = await p.multiselect({
        message: `Skills for ${agent.label} — all selected; deselect any you don't want`,
        options: skills.map((s) => {
          const st = skillStatus(join(target.skills, s.name), s.meta);
          const prov = s.meta.provider ? ` · ${s.meta.provider}` : "";
          return { value: s.name, label: s.name, hint: `${statusLabel(st)}${prov}` };
        }),
        initialValues: skills.map((s) => s.name),
        required: false,
      });
      if (p.isCancel(r)) return p.cancel("Aborted.");
      chosenSkills = skills.filter((s) => r.includes(s.name));
    }

    // Attach the computed status to each chosen skill (install/update/identical/tampered/reinstall).
    const skillsWithStatus = (opts.memoryOnly ? [] : chosenSkills).map((s) => ({
      ...s,
      status: skillStatus(join(target.skills, s.name), s.meta),
      overwrite: true, // may be unset for tampered skills the user keeps
    }));

    // Prune is based on the FULL source skill set (what the repo ships), not on
    // the user's selection — deselecting a skill never deletes it.
    const prune = opts.prune && !opts.memoryOnly
      ? computePrune(target.skills, skills.map((s) => s.name))
      : [];

    plan.push({
      agent,
      target,
      skills: skillsWithStatus,
      memory: opts.skillsOnly ? [] : memory,
      prune,
    });
  }

  // --- handle locally-modified (tampered) skills: warn + let user pick which to overwrite ---
  const tampered = plan.flatMap((x) => x.skills.filter((s) => s.status.kind === "tampered"));
  if (tampered.length) {
    if (opts.keepModified) {
      for (const s of tampered) s.overwrite = false;
      p.log.warn(`${tampered.length} locally-modified skill(s) will be kept (--keep-modified).`);
    } else if (interactive && !opts.dryRun) {
      const sel = await p.multiselect({
        message: `${tampered.length} skill(s) were modified locally since install. Select which to OVERWRITE (all selected by default)`,
        options: tampered.map((s, i) => ({
          value: i,
          label: s.name,
          hint: s.meta.version ? `v${s.meta.version}` : "modified",
        })),
        initialValues: tampered.map((_, i) => i),
        required: false,
      });
      if (p.isCancel(sel)) return p.cancel("Aborted.");
      tampered.forEach((s, i) => { s.overwrite = sel.includes(i); });
    }
    // non-interactive without --keep-modified: overwrite all (default), as requested.
  }

  // Will this skill be written? identical → no; tampered → only if user kept overwrite.
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
    p.outro(`✅ Everything up-to-date — ${nSkip} item(s) unchanged${nKept ? `, ${nKept} kept modified` : ""} (${scope}).`);
    return;
  }

  p.note(lines.join("\n"), opts.dryRun ? "Dry run — planned changes" : "Planned changes");

  // --- confirm ---
  if (interactive && !opts.dryRun) {
    const summary = [
      nInstall && `${nInstall} to install`,
      nUpdate && `${nUpdate} to update/overwrite`,
      nRemove && `${nRemove} to remove`,
      nSkip && `${nSkip} unchanged`,
    ].filter(Boolean).join(", ");
    const ok = await p.confirm({ message: `Apply: ${summary}?` });
    if (p.isCancel(ok) || !ok) return p.cancel("Aborted.");
  }

  if (opts.dryRun) {
    p.outro("Dry run complete — no files written.");
    return;
  }

  // --- execute ---
  const s = p.spinner();
  s.start("Installing…");
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
      for (const pr of x.prune) {
        rmSync(pr.dir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    s.stop("Failed.");
    p.cancel(`Error while installing: ${err.message}`);
    process.exit(1);
  }
  s.stop(`Wrote ${copied} item(s)${nRemove ? `, removed ${nRemove}` : ""}.`);
  p.outro(`✅ Done — ${nInstall} installed, ${nUpdate} updated/overwritten` +
    (nRemove ? `, ${nRemove} removed` : "") + (nSkip ? `, ${nSkip} unchanged` : "") +
    (nKept ? `, ${nKept} kept modified` : "") + ` (${scope}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
