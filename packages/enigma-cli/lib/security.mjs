/**
 * Git security hooks (OS-agnostic). Installs a portable, self-contained commit
 * guard into a target repo: copies guard.mjs into <repo>/.githooks, writes a
 * cross-platform pre-commit shim, an optional toggle config, and points
 * core.hooksPath at it. Hooks fire for commits made via plain `git` AND via the
 * GitHub CLI (`gh`), since `gh` shells out to `git`.
 */

import { existsSync, mkdirSync, cpSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import { isOnPath } from "./util.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_SRC = join(__dirname, "guard.mjs");

/** All toggleable guard protections, in display order. */
export const GUARD_PROTECTIONS = [
  { value: "secrets", label: "Block committed secrets", hint: "API keys, tokens, private keys" },
  { value: "envFiles", label: "Block .env files", hint: "allows .env.example / .sample / .template" },
  { value: "depDirs", label: "Block dependency/cache dirs", hint: "node_modules, __pycache__, venv" },
  { value: "generatedDirs", label: "Warn on generated dirs", hint: "dist, build, .next, coverage" },
  { value: "junkFiles", label: "Warn on log / OS junk files", hint: ".log, .DS_Store, Thumbs.db" },
  { value: "largeFiles", label: "Warn on files over 5 MB", hint: "oversized blobs" },
];

/** Walk up from `start` to find the git repository root, or null. */
export function findGitRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function currentHooksPath(root) {
  try { return execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

/**
 * Configure git security hooks in the current repo.
 * `opts.force` overrides an existing core.hooksPath without prompting.
 * `opts.protections` (array of GUARD_PROTECTIONS values) limits what is enabled;
 * omitted means all protections on.
 */
export async function setupGitHooks(opts, interactive) {
  const root = findGitRoot(process.cwd());
  if (!root) {
    p.log.error("Not inside a git repository (no .git found). Run this from your project root.");
    return false;
  }
  if (!existsSync(GUARD_SRC)) {
    p.log.error(`Cannot find guard.mjs at ${GUARD_SRC}.`);
    return false;
  }

  const current = currentHooksPath(root);
  if (current && current !== ".githooks" && !opts.force) {
    p.log.warn(`core.hooksPath is already set to '${current}'.`);
    if (interactive) {
      const ok = await p.confirm({ message: `Override existing core.hooksPath '${current}' with '.githooks'?` });
      if (p.isCancel(ok) || !ok) { p.log.info("Left git hooks unchanged."); return false; }
    } else {
      p.log.info("Re-run with --force to override.");
      return false;
    }
  }

  // Which protections to enable (interactive multiselect, unless given/forced).
  let enabled = opts.protections;
  if (!enabled && interactive) {
    const r = await p.multiselect({
      message: "Which protections should the commit guard enforce?",
      options: GUARD_PROTECTIONS,
      initialValues: GUARD_PROTECTIONS.map((o) => o.value),
      required: true,
    });
    if (p.isCancel(r)) { p.log.info("Left git hooks unchanged."); return false; }
    enabled = r;
  }
  const config = {};
  for (const o of GUARD_PROTECTIONS) config[o.value] = enabled ? enabled.includes(o.value) : true;

  const hooksDir = join(root, ".githooks");
  mkdirSync(hooksDir, { recursive: true });
  cpSync(GUARD_SRC, join(hooksDir, "guard.mjs"), { force: true });
  writeFileSync(join(hooksDir, "enigma-guard.json"), JSON.stringify(config, null, 2) + "\n");

  const shimPath = join(hooksDir, "pre-commit");
  const shim = [
    "#!/bin/sh",
    "# Managed by enigma (enigma-cli) - blocks committed secrets, .env files, and dependency dirs.",
    "# Toggle protections in .githooks/enigma-guard.json. Bypass once: git commit --no-verify",
    'exec node "$(git rev-parse --show-toplevel)/.githooks/guard.mjs" "$@"',
    "",
  ].join("\n");
  writeFileSync(shimPath, shim);
  try { chmodSync(shimPath, 0o755); } catch { /* no-op on Windows */ }
  try { chmodSync(join(hooksDir, "guard.mjs"), 0o755); } catch { /* no-op on Windows */ }

  try {
    execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"]);
  } catch (err) {
    p.log.error(`Failed to set core.hooksPath: ${err.message}`);
    return false;
  }

  const on = Object.entries(config).filter(([, v]) => v).map(([k]) => k);
  p.log.success(`Git security hooks installed in ${relative(process.cwd(), hooksDir) || ".githooks"} (core.hooksPath set).`);
  p.log.info(`Enforcing: ${on.join(", ") || "nothing"}. Commit .githooks/ so your team inherits it.`);
  if (isOnPath("gh")) {
    p.log.info("GitHub CLI (gh) detected: these hooks also run for commits made via gh, since gh uses git underneath.");
  }
  return true;
}

/** In interactive skills installs, offer to set up git hooks in an unguarded repo. */
export async function maybeOfferGitHooks(interactive, opts) {
  if (!interactive || opts.security) return;
  const root = findGitRoot(process.cwd());
  if (!root) return;
  if (currentHooksPath(root) === ".githooks") return; // already guarded
  const ok = await p.confirm({ message: "Set up git security hooks here too (block secrets, .env, node_modules)?" });
  if (!p.isCancel(ok) && ok) await setupGitHooks({ ...opts, protections: undefined }, interactive);
}
