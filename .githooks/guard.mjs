#!/usr/bin/env node

// src/guard.ts
import { readFileSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { basename, extname, dirname, join } from "path";
import { fileURLToPath } from "url";
var LARGE_FILE_BYTES = 5 * 1024 * 1024;
var ENV_ALLOWED = /(example|sample|template)/i;
var isForbiddenEnv = (base) => /^\.env(\..+)?$/.test(base) && !ENV_ALLOWED.test(base);
var BLOCK_DIRS = [
  /(^|\/)node_modules\//,
  /(^|\/)bower_components\//,
  /(^|\/)\.pnp(\/|$)/,
  /(^|\/)__pycache__\//,
  /(^|\/)\.venv\//,
  /(^|\/)venv\//,
  /(^|\/)\.mypy_cache\//,
  /(^|\/)\.pytest_cache\//,
  /(^|\/)\.gradle\//
];
var WARN_DIRS = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)\.next\//,
  /(^|\/)\.nuxt\//,
  /(^|\/)\.svelte-kit\//,
  /(^|\/)\.turbo\//,
  /(^|\/)coverage\//
];
var WARN_FILES = [/\.log$/i, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/i];
var SECRET_SKIP_EXT = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mov",
  ".lock"
]);
var SECRET_PATTERNS = [
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\bsk_live_[0-9A-Za-z]{24,}\b/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["Generic bearer secret", /\b(?:secret|token|api[_-]?key|passwd|password)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i]
];
var SECRET_SKIP_PATH = [/(^|\/)node_modules\//, /(^|\/)\.git\//, /package-lock\.json$/, /guard\.[mc]?js$/];
var SELF_DIR = dirname(fileURLToPath(import.meta.url));
function loadConfig() {
  const defaults = { secrets: true, envFiles: true, depDirs: true, generatedDirs: true, junkFiles: true, largeFiles: true };
  try {
    const raw = JSON.parse(readFileSync(join(SELF_DIR, "enigma-guard.json"), "utf8"));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}
function gitFiles(all) {
  const out = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}
function scanSecrets(file, blocks) {
  if (SECRET_SKIP_PATH.some((re) => re.test(file))) return;
  if (SECRET_SKIP_EXT.has(extname(file).toLowerCase())) return;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (text.includes("\0")) return;
  text.split("\n").forEach((line, i) => {
    for (const [label, re] of SECRET_PATTERNS) {
      if (re.test(line)) blocks.push(`${file}:${i + 1}  [secret: ${label}]`);
    }
  });
}
function runGuard({ all = false } = {}) {
  const cfg = loadConfig();
  let files;
  try {
    files = gitFiles(all);
  } catch {
    return { ok: true, blocks: [], warns: [], notRepo: true };
  }
  const blocks = [];
  const warns = [];
  for (const file of files) {
    const base = basename(file);
    if (cfg.envFiles && isForbiddenEnv(base)) {
      blocks.push(`${file}  [env file with secrets - commit .env.example/.template instead]`);
    }
    if (cfg.depDirs && BLOCK_DIRS.some((re) => re.test(file))) {
      blocks.push(`${file}  [dependency/cache dir - must not be committed]`);
    } else if (cfg.generatedDirs && WARN_DIRS.some((re) => re.test(file))) {
      warns.push(`${file}  [looks generated - confirm you really want it tracked]`);
    }
    if (cfg.junkFiles && WARN_FILES.some((re) => re.test(file))) warns.push(`${file}  [log / OS junk file]`);
    if (cfg.largeFiles) {
      try {
        if (statSync(file).size > LARGE_FILE_BYTES) warns.push(`${file}  [larger than 5 MB]`);
      } catch {
      }
    }
    if (cfg.secrets) scanSecrets(file, blocks);
  }
  return { ok: blocks.length === 0, blocks, warns, count: files.length, all };
}
function runGuardCli(all) {
  const r = runGuard({ all });
  if (r.notRepo) {
    console.error("enigma-guard: not a git repository; nothing to check.");
    return 0;
  }
  if (r.warns.length) {
    console.error(`enigma-guard: ${r.warns.length} warning(s):`);
    for (const w of r.warns) console.error(`  ! ${w}`);
  }
  if (r.blocks.length) {
    console.error(`
enigma-guard: BLOCKED - ${r.blocks.length} problem(s) must be fixed before committing:`);
    for (const b of r.blocks) console.error(`  x ${b}`);
    console.error("\nFix the above (move secrets to env/secret manager, gitignore generated paths).");
    console.error("To bypass intentionally for one commit: git commit --no-verify");
    return 1;
  }
  console.log(`enigma-guard: ${r.count} ${r.all ? "tracked" : "staged"} file(s) checked, no blocking problems.`);
  return 0;
}
var guardEntry = process.argv[1] ?? "";
var isGuardEntry = /(^|[\\/])guard\.[mc]?[jt]s$/.test(guardEntry);
if (isGuardEntry && fileURLToPath(import.meta.url) === guardEntry) {
  process.exit(runGuardCli(process.argv.includes("--all")));
}
export {
  runGuard,
  runGuardCli
};
